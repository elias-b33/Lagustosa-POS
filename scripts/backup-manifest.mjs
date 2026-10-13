import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// A manifest detects corruption and accidental substitution. It is not a
// signature and must be copied to separately protected storage with the file.
export function inspectBackup(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  let journalHead = '0'.repeat(64), journalEntries = 0;
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Säkerhetskopians databas är skadad.');
    if (db.pragma('user_version', { simple: true }) !== 1) throw new Error('Säkerhetskopians databasversion stöds inte.');
    const seed = db.prepare("SELECT body FROM entities WHERE kind='meta' AND id='seeded'").get();
    if (!seed || JSON.parse(seed.body).mode !== 'training') throw new Error('Säkerhetskopian är inte en träningsdatabas.');
    for (const row of db.prepare('SELECT * FROM audit ORDER BY id').all()) {
      const hash = createHash('sha256').update(JSON.stringify([row.at, row.actor, row.action, row.entity_id, JSON.stringify(JSON.parse(row.details)), journalHead])).digest('hex');
      if (row.previous_hash !== journalHead || row.hash !== hash) throw new Error('Säkerhetskopians journal är inte intakt.');
      journalHead = row.hash; journalEntries++;
    }
  } finally { db.close(); }
  const bytes = readFileSync(filename);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), journalEntries, journalHead };
}

export function sealBackup(filename, createdAt = new Date().toISOString()) {
  const manifest = { format: 'lagustosa-backup', version: 1, mode: 'training', createdAt, ...inspectBackup(filename) };
  writeFileSync(`${filename}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}

export function verifyBackupManifest(filename, allowLegacy = false) {
  if (!existsSync(`${filename}.manifest.json`)) {
    if (!allowLegacy) throw new Error('Säkerhetskopian saknar manifest. Äldre kopior kräver uttryckligt --allow-legacy efter granskning.');
    return { legacy: true, ...inspectBackup(filename) };
  }
  const manifest = JSON.parse(readFileSync(`${filename}.manifest.json`, 'utf8'));
  if (manifest.format !== 'lagustosa-backup' || manifest.version !== 1 || manifest.mode !== 'training') throw new Error('Säkerhetskopians manifest stöds inte.');
  const actual = inspectBackup(filename);
  for (const field of ['bytes', 'sha256', 'journalEntries', 'journalHead']) {
    if (actual[field] !== manifest[field]) throw new Error(`Säkerhetskopians manifest stämmer inte (${field}).`);
  }
  return { legacy: false, ...actual };
}
