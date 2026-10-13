import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Hold an operating-system database lock for the whole server/restore lifetime.
 * A PID file alone cannot atomically reclaim ownership after a crash: another
 * process can replace the stale file between a read and unlink. SQLite releases
 * this separate lock automatically when its owning process exits or crashes.
 */
export function acquireDatabaseLock(dataDir, purpose = 'server') {
  mkdirSync(dataDir, { recursive: true });
  const metadataFile = path.join(dataDir, 'training.lock');
  const token = randomUUID();
  let lease;
  try {
    lease = new Database(path.join(dataDir, 'training-owner.sqlite'), { timeout: 0 });
    // This file only coordinates ownership. It must never be backed up,
    // restored, removed, or switched to WAL while any process uses this folder.
    lease.exec('CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');

    // Older versions use only this PID file. Continue to respect a live older
    // server, including when we cannot establish whether its PID is alive.
    if (existsSync(metadataFile)) {
      let previous;
      try { previous = JSON.parse(readFileSync(metadataFile, 'utf8')); }
      catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; }
      // For this lock format, acquiring the SQLite lease already proves that
      // its owner exited. Do not mistake a reused PID for the former server.
      if (previous?.ownership !== 'sqlite-v1' && Number.isInteger(previous?.pid) && previous.pid > 0) {
        let alive = false;
        try { process.kill(previous.pid, 0); alive = true; }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        if (alive) throw new Error('Kassan kör redan med denna databas. Stoppa kassaservern innan databasen återställs.');
      }
    }
    writeFileSync(metadataFile, JSON.stringify({ pid: process.pid, token, purpose, ownership: 'sqlite-v1', startedAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (error) {
    if (lease?.open) lease.close();
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') throw new Error('Kassan kör redan med denna databas, eller en återställning pågår.');
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const owner = JSON.parse(readFileSync(metadataFile, 'utf8'));
      if (owner.pid === process.pid && owner.token === token) unlinkSync(metadataFile);
    } catch {
      // Metadata is advisory. The OS lock remains authoritative and a stale
      // metadata file is safely reclaimed at the next startup.
    } finally {
      lease.close();
    }
  };
}
