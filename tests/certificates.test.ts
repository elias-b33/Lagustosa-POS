import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { createPrivateKey, webcrypto, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as x509 from '@peculiar/x509';
import { fixture } from './helpers';
// @ts-expect-error Standalone certificate tool is an mjs module.
import { createCertificates, repairLegacyServerCertificate } from '../scripts/create-certs.mjs';

const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

async function legacyCertificates() {
  const directory = path.join(fixture().directory, 'certs');
  await createCertificates(directory, ['192.168.1.20']);
  const read = (file: string) => readFileSync(path.join(directory, file));
  const root = new x509.X509Certificate(read('root-ca.pem'));
  const leaf = new x509.X509Certificate(read('server.pem'));
  const signingKey = await webcrypto.subtle.importKey('pkcs8', createPrivateKey(read('root-ca-key.pem')).export({ format: 'der', type: 'pkcs8' }), algorithm, false, ['sign']);
  const legacy = await x509.X509CertificateGenerator.create({
    issuer: root.subject, publicKey: leaf.publicKey, signingKey: signingKey as CryptoKey,
    serialNumber: leaf.serialNumber, signingAlgorithm: algorithm,
    notBefore: leaf.notBefore, notAfter: leaf.notAfter, extensions: leaf.extensions,
  });
  writeFileSync(path.join(directory, 'server.pem'), legacy.toString('pem'));
  writeFileSync(path.join(directory, 'Lagustosa-Test-CA.cer'), new X509Certificate(read('root-ca.pem')).raw);
  return { directory, read };
}

describe('Browser-compatible local TLS certificates', () => {
  it('repairs the empty-subject certificate without replacing trust or keys', async () => {
    const { directory, read } = await legacyCertificates();
    const original = read('server.pem');
    const old = new X509Certificate(original);
    expect(old.subject).toBeFalsy();
    const preserved = ['root-ca.pem', 'root-ca-key.pem', 'server-key.pem', 'Lagustosa-Test-CA.cer'].map(name => ({ name, content: read(name) }));

    expect(await repairLegacyServerCertificate(directory)).toBe(true);
    const repairedBytes = read('server.pem');
    const repaired = new X509Certificate(repairedBytes);
    expect(repaired.subject).toBeTruthy();
    expect(repaired.verify(new X509Certificate(read('root-ca.pem')).publicKey)).toBe(true);
    expect(repaired.checkPrivateKey(createPrivateKey(read('server-key.pem')))).toBe(true);
    expect(repaired.checkIP('192.168.1.20')).toBe('192.168.1.20');
    expect(repaired.checkIP('192.168.1.21')).toBeUndefined();
    expect(repaired.validFrom).toBe(old.validFrom);
    expect(repaired.validTo).toBe(old.validTo);
    expect(repaired.serialNumber).not.toBe(old.serialNumber);
    expect(new x509.X509Certificate(repairedBytes).extensions.map(ext => ext.toString('hex'))).toEqual(new x509.X509Certificate(original).extensions.map(ext => ext.toString('hex')));
    expect(read('server.legacy-empty-subject.pem')).toEqual(original);
    for (const { name, content } of preserved) expect(read(name)).toEqual(content);
    expect(await repairLegacyServerCertificate(directory)).toBe(false);
    expect(read('server.pem')).toEqual(repairedBytes);
  });

  it('leaves newly generated certificates unchanged', async () => {
    const directory = path.join(fixture().directory, 'certs');
    await createCertificates(directory, ['192.168.1.20']);
    const original = readFileSync(path.join(directory, 'server.pem'));
    expect(await repairLegacyServerCertificate(directory)).toBe(false);
    expect(readFileSync(path.join(directory, 'server.pem'))).toEqual(original);
    expect(existsSync(path.join(directory, 'server.legacy-empty-subject.pem'))).toBe(false);
  });

  it.each(['root-ca-key.pem', 'server-key.pem'])('preserves the original when %s does not match', async name => {
    const { directory, read } = await legacyCertificates();
    const original = read('server.pem');
    const otherKey = name === 'root-ca-key.pem' ? 'server-key.pem' : 'root-ca-key.pem';
    writeFileSync(path.join(directory, name), read(otherKey));
    await expect(repairLegacyServerCertificate(directory)).rejects.toThrow(/Inga certifikat ändrades/);
    expect(read('server.pem')).toEqual(original);
    expect(existsSync(path.join(directory, 'server.legacy-empty-subject.pem'))).toBe(false);
  });
});
