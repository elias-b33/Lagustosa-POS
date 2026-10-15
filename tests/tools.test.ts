import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { fixture } from './helpers';

describe('Installation och återställning', () => {
  it('återställer backup och sparar den tidigare databasen separat', async () => {
    // @ts-expect-error Node-verktyget är en fristående mjs-modul.
    const { backupDatabase, restoreDatabase, verifyDatabase } = await import('../scripts/database-tools.mjs');
    const f = fixture({}, true); f.open(); const tab = f.tab();
    const config = { dataDir: f.directory, database: f.filename, backupDir: path.join(f.directory, 'backups') };
    const backup = await backupDatabase(config);
    f.command(tab.id, { action: 'add', itemId: 'bread' });
    f.store.close();
    const result = await restoreDatabase(backup, config);
    expect(existsSync(result.safetyBackup)).toBe(true);
    expect(() => verifyDatabase(result.database)).not.toThrow();
  });

  it('avvisar återställning medan servern är igång', async () => {
    // @ts-expect-error Fristående CLI-modul.
    const { backupDatabase, restoreDatabase } = await import('../scripts/database-tools.mjs');
    const f = fixture({}, true); f.open();
    const config = { dataDir: f.directory, database: f.filename, backupDir: path.join(f.directory, 'backups') };
    const backup = await backupDatabase(config);
    writeFileSync(path.join(f.directory, 'training.lock'), JSON.stringify({ pid: process.pid }));
    await expect(restoreDatabase(backup, config)).rejects.toThrow('Stoppa kassaservern');
  });

  it('skapar en verifierbar TLS-kedja med rätt lokala namn och IP-adresser', async () => {
    // @ts-expect-error Fristående certifikatmodul.
    const { createCertificates } = await import('../scripts/create-certs.mjs');
    const f = fixture(); const directory = path.join(f.directory, 'certs');
    await createCertificates(directory, ['192.168.1.20', 'lagustosa.local']);
    const root = new X509Certificate(readFileSync(path.join(directory, 'root-ca.pem')));
    const leaf = new X509Certificate(readFileSync(path.join(directory, 'server.pem')));
    expect(root.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.subject).toBeTruthy();
    expect(leaf.issuer).toBe(root.subject);
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(leaf.checkHost('lagustosa.local')).toBe('lagustosa.local');
    expect(leaf.checkIP('192.168.1.20')).toBe('192.168.1.20');
    await expect(createCertificates(directory)).rejects.toThrow('finns redan');
  });
});
