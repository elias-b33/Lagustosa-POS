import { describe, expect, it } from 'vitest';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { verifyBackupManifest } from '../scripts/backup-manifest.mjs';
import { fixture } from './helpers';

describe('Verifierad säkerhetskopia och återställning', () => {
  it('skapar samma verifierade manifest för serverbackup och CLI och återkallar gamla sessioner', async () => {
    // @ts-expect-error Standalone CLI module.
    const { restoreDatabase, backupDatabase } = await import('../scripts/database-tools.mjs');
    const f = fixture({}, true); f.open();
    const config = { dataDir: f.directory, database: f.filename, backupDir: path.join(f.directory, 'backups') };
    const backup = await f.service.backup(f.admin);
    expect(verifyBackupManifest(backup.filename)).toMatchObject({ legacy: false, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const cli = await backupDatabase(config);
    expect(verifyBackupManifest(cli).journalEntries).toBeGreaterThan(0);
    f.store.close();
    const result = await restoreDatabase(cli, config);
    const restored = new Database(result.database, { readonly: true });
    try {
      expect(restored.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
      expect(restored.prepare('SELECT action FROM audit ORDER BY id DESC LIMIT 1').get()).toEqual({ action: 'backup.restored' });
    } finally { restored.close(); }
    expect(verifyBackupManifest(result.safetyBackup).legacy).toBe(false);
  });

  it('stoppar manipulerat manifest innan den aktiva databasen byts', async () => {
    // @ts-expect-error Standalone CLI module.
    const { restoreDatabase } = await import('../scripts/database-tools.mjs');
    const f = fixture({}, true); f.open();
    const backup = await f.service.backup(f.admin);
    const manifest = JSON.parse(readFileSync(`${backup.filename}.manifest.json`, 'utf8'));
    writeFileSync(`${backup.filename}.manifest.json`, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
    f.store.close();
    const before = readFileSync(f.filename);
    await expect(restoreDatabase(backup.filename, { dataDir: f.directory, database: f.filename, backupDir: path.join(f.directory, 'backups') })).rejects.toThrow('manifest stämmer inte');
    expect(readFileSync(f.filename)).toEqual(before);
  });

  it('kräver uttryckligt val för äldre kopior och journalför att manifest saknades', async () => {
    // @ts-expect-error Standalone CLI module.
    const { restoreDatabase } = await import('../scripts/database-tools.mjs');
    const f = fixture({}, true); f.open();
    const backup = await f.service.backup(f.admin);
    const legacy = path.join(f.directory, 'old-copy.sqlite'); copyFileSync(backup.filename, legacy);
    f.store.close();
    const config = { dataDir: f.directory, database: f.filename, backupDir: path.join(f.directory, 'backups') };
    await expect(restoreDatabase(legacy, config)).rejects.toThrow('saknar manifest');
    const restored = await restoreDatabase(legacy, config, { allowLegacy: true });
    expect(restored.legacyManifest).toBe(true);
    const db = new Database(restored.database, { readonly: true });
    try { expect(JSON.parse((db.prepare('SELECT details FROM audit ORDER BY id DESC LIMIT 1').get() as { details: string }).details).legacyManifest).toBe(true); }
    finally { db.close(); }
  });
});
