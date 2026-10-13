import 'reflect-metadata';
import { webcrypto, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as x509 from '@peculiar/x509';

export async function createCertificates(directory = path.resolve('certs'), hosts = []) {
  const files = ['root-ca.pem', 'root-ca-key.pem', 'server.pem', 'server-key.pem'];
  if (files.some(file => existsSync(path.join(directory, file)))) throw new Error('Certifikat finns redan. Använd en ny certifikatmapp vid förnyelse och planera om installationen av rotcertifikatet.');
  const names = [...new Set(['localhost', '127.0.0.1', '::1', hostname(), ...hosts])];
  if (names.some(name => !isIP(name) && !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(name))) throw new Error('Ange endast giltiga datornamn eller IP-adresser.');
  x509.cryptoProvider.set(webcrypto);
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
  const caKeys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const serverKeys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const notBefore = new Date(Date.now() - 5 * 60000);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Lagustosa Training Local CA', serialNumber: randomBytes(16).toString('hex'), keys: caKeys,
    signingAlgorithm: algorithm, notBefore, notAfter: new Date(Date.now() + 3 * 365 * 86400000),
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true), await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey)],
  });
  const certificate = await x509.X509CertificateGenerator.create({
    name: 'CN=Lagustosa Training Server', issuer: ca.subject, publicKey: serverKeys.publicKey, signingKey: caKeys.privateKey,
    serialNumber: randomBytes(16).toString('hex'), signingAlgorithm: algorithm, notBefore, notAfter: new Date(Date.now() + 365 * 86400000),
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true), new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]), new x509.SubjectAlternativeNameExtension(names.map(value => ({ type: isIP(value) ? 'ip' : 'dns', value })))],
  });
  const privatePem = async key => `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await webcrypto.subtle.exportKey('pkcs8', key)).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'root-ca.pem'), ca.toString('pem'));
  writeFileSync(path.join(directory, 'root-ca-key.pem'), await privatePem(caKeys.privateKey), { mode: 0o600 });
  writeFileSync(path.join(directory, 'server.pem'), certificate.toString('pem'));
  writeFileSync(path.join(directory, 'server-key.pem'), await privatePem(serverKeys.privateKey), { mode: 0o600 });
  return { directory, hosts: names };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await createCertificates(path.resolve('certs'), process.argv.slice(2));
    console.log(`Certifikat skapade för ${result.hosts.join(', ')} i ${result.directory}.`);
    console.log('Rotcertifikatet är inte installerat. Följ README för datorn och plattorna.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
