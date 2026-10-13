import Database from 'better-sqlite3';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AuditEntry } from '../shared/types';

export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 32).toString('hex')}`;
}
export function verifyPin(pin: string, hashed: string): boolean {
  const [salt, stored] = hashed.split(':');
  if (!salt || !stored) return false;
  const expected = Buffer.from(stored, 'hex');
  const actual = scryptSync(pin, salt, 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class Store {
  readonly db: Database.Database;
  constructor(readonly filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS entity_status ON entities(kind,json_extract(body,'$.status'));
      CREATE INDEX IF NOT EXISTS entity_tab ON entities(kind,json_extract(body,'$.tabId'));
      CREATE TABLE IF NOT EXISTS commands (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL, device_id TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, blocked_until TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL, details TEXT NOT NULL, hash TEXT NOT NULL, previous_hash TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Journalen är oföränderlig'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Journalen är oföränderlig'); END;
      CREATE TRIGGER IF NOT EXISTS receipt_no_delete BEFORE DELETE ON entities WHEN OLD.kind = 'receipt' BEGIN SELECT RAISE(ABORT,'Kvitton får inte raderas'); END;
      CREATE TRIGGER IF NOT EXISTS receipt_financial_immutable BEFORE UPDATE ON entities WHEN OLD.kind = 'receipt' AND (json_extract(NEW.body,'$.payment') != json_extract(OLD.body,'$.payment') OR json_extract(NEW.body,'$.tab') != json_extract(OLD.body,'$.tab') OR json_extract(NEW.body,'$.number') != json_extract(OLD.body,'$.number')) BEGIN SELECT RAISE(ABORT,'Kvittots belopp är oföränderliga'); END;
      PRAGMA user_version = 1;
    `);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM entities WHERE kind=? AND id=?').get(kind, id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as T : undefined;
  }
  all<T>(kind: string): T[] {
    return (this.db.prepare('SELECT body FROM entities WHERE kind=? ORDER BY rowid').all(kind) as { body: string }[]).map(row => JSON.parse(row.body) as T);
  }
  put<T extends { id: string }>(kind: string, entity: T): void {
    this.db.prepare('INSERT INTO entities(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind, entity.id, JSON.stringify(entity));
  }
  next(name: string): number {
    const result = this.db.prepare('INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1 RETURNING value').get(name) as { value: number };
    return result.value;
  }
  atomic<T>(operation: () => T): T { return this.db.transaction(operation).immediate(); }
  audit(actor: string, action: string, entityId: string, details: unknown, at: string): void {
    const previousHash = (this.db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined)?.hash ?? '0'.repeat(64);
    const encoded = JSON.stringify(details);
    const hash = digest(JSON.stringify([at, actor, action, entityId, encoded, previousHash]));
    this.db.prepare('INSERT INTO audit(at,actor,action,entity_id,details,hash,previous_hash) VALUES(?,?,?,?,?,?,?)').run(at, actor, action, entityId, encoded, hash, previousHash);
  }
  journal(): AuditEntry[] {
    return (this.db.prepare('SELECT id,at,actor,action,entity_id AS entityId,details,hash,previous_hash AS previousHash FROM audit ORDER BY id').all() as (Omit<AuditEntry, 'details'> & { details: string })[]).map(row => ({ ...row, details: JSON.parse(row.details) }));
  }
  verifyJournal(): boolean {
    let previous = '0'.repeat(64);
    for (const row of this.journal()) {
      if (row.previousHash !== previous || row.hash !== digest(JSON.stringify([row.at, row.actor, row.action, row.entityId, JSON.stringify(row.details), previous]))) return false;
      previous = row.hash;
    }
    return true;
  }
  close(): void { this.db.close(); }
}
