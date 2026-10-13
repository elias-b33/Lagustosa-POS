import 'dotenv/config';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function configuration(env = process.env) {
  if ((env.APP_MODE ?? 'training') !== 'training') throw new Error('Verktygen stöder endast träningsdatabasen.');
  const dataDir = path.resolve(env.DATA_DIR || './data');
  return { dataDir, database: path.join(dataDir, 'training.sqlite'), backupDir: path.resolve(env.BACKUP_DIR || path.join(dataDir, 'backups')) };
}

export function verifyDatabase(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Databasens integritetskontroll misslyckades.');
    if (db.pragma('user_version', { simple: true }) !== 1) throw new Error('Databasen har en okänd version.');
    const seeded = db.prepare("SELECT body FROM entities WHERE kind='meta' AND id='seeded'").get();
    if (!seeded || JSON.parse(seeded.body).mode !== 'training') throw new Error('Detta är inte en Lagustosa-träningsdatabas.');
    let previous = '0'.repeat(64);
    for (const row of db.prepare('SELECT * FROM audit ORDER BY id').all()) {
      const hash = createHash('sha256').update(JSON.stringify([row.at, row.actor, row.action, row.entity_id, JSON.stringify(JSON.parse(row.details)), previous])).digest('hex');
      if (row.previous_hash !== previous || row.hash !== hash) throw new Error('Journalens kontrollsummor stämmer inte.');
      previous = row.hash;
    }
  } finally { db.close(); }
}

export async function backupDatabase(config = configuration()) {
  if (!existsSync(config.database)) throw new Error('Ingen träningsdatabas finns. Starta kassan först.');
  mkdirSync(config.backupDir, { recursive: true });
  const filename = path.join(config.backupDir, `lagustosa-training-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`);
  const db = new Database(config.database, { readonly: true, fileMustExist: true });
  try { await db.backup(filename); } finally { db.close(); }
  verifyDatabase(filename);
  return filename;
}

export async function restoreDatabase(source, config = configuration()) {
  if (!source) throw new Error('Ange säkerhetskopians sökväg: npm run restore -- <fil.sqlite>');
  const sourcePath = path.resolve(source);
  if (sourcePath === config.database) throw new Error('Säkerhetskopian får inte vara den aktiva databasen.');
  const lockPath = path.join(config.dataDir, 'training.lock');
  if (existsSync(lockPath)) {
    const { pid } = JSON.parse(readFileSync(lockPath, 'utf8'));
    let running = false;
    try { process.kill(pid, 0); running = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (running) throw new Error('Stoppa kassaservern innan databasen återställs.');
  }
  verifyDatabase(sourcePath);
  mkdirSync(config.dataDir, { recursive: true });
  const staging = path.join(config.dataDir, `restore-${randomUUID()}.sqlite`);
  let safetyBackup = null;
  try {
    const sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try { await sourceDb.backup(staging); } finally { sourceDb.close(); }
    verifyDatabase(staging);
    if (existsSync(config.database)) {
      safetyBackup = await backupDatabase(config);
      const previous = new Database(config.database, { fileMustExist: true });
      try { previous.pragma('wal_checkpoint(TRUNCATE)'); } finally { previous.close(); }
    }
    renameSync(staging, config.database);
    return { database: config.database, safetyBackup };
  } finally { if (existsSync(staging)) unlinkSync(staging); }
}
