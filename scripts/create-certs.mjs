import 'reflect-metadata';
import { webcrypto, randomBytes, randomUUID, createPrivateKey, X509Certificate } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as x509 from '@peculiar/x509';

const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };

export async function createCertificates(directory = path.resolve('certs'), hosts = []) {
  const files = ['root-ca.pem', 'root-ca-key.pem', 'server.pem', 'server-key.pem'];
  if (files.some(file => existsSync(path.join(directory, file)))) throw new Error('Certifikat finns redan. Använd en ny certifikatmapp vid förnyelse och planera om installationen av rotcertifikatet.');
  const names = [...new Set(['localhost', '127.0.0.1', '::1', hostname(), ...hosts])];
  if (names.some(name => !isIP(name) && !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(name))) throw new Error('Ange endast giltiga datornamn eller IP-adresser.');
  x509.cryptoProvider.set(webcrypto);
  const caKeys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const serverKeys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const notBefore = new Date(Date.now() - 5 * 60000);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    name: 'CN=Lagustosa Training Local CA', serialNumber: randomBytes(16).toString('hex'), keys: caKeys,
    signingAlgorithm: algorithm, notBefore, notAfter: new Date(Date.now() + 3 * 365 * 86400000),
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true), await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey)],
  });
  const certificate = await x509.X509CertificateGenerator.create({
    subject: 'CN=Lagustosa Training Server', issuer: ca.subject, publicKey: serverKeys.publicKey, signingKey: caKeys.privateKey,
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

// Older launchers passed `name` (the self-signed API) instead of `subject`.
// A blank subject with a non-critical SAN violates RFC 5280 and Chrome rejects it.
export async function repairLegacyServerCertificate(directory) {
  const filename = path.join(directory, 'server.pem');
  const original = readFileSync(filename);
  const certificate = new x509.X509Certificate(original);
  const san = certificate.getExtension(x509.SubjectAlternativeNameExtension);
  if (certificate.subject || !san || san.critical) return false;

  x509.cryptoProvider.set(webcrypto);
  const ca = new x509.X509Certificate(readFileSync(path.join(directory, 'root-ca.pem')));
  const nativeCa = new X509Certificate(Buffer.from(ca.rawData));
  const nativeLeaf = new X509Certificate(original);
  const serverKey = createPrivateKey(readFileSync(path.join(directory, 'server-key.pem')));
  if (ca.subject !== 'CN=Lagustosa Training Local CA' || certificate.issuer !== ca.subject || !nativeCa.ca || nativeLeaf.ca
      || !await ca.verify() || !await certificate.verify({ publicKey: ca.publicKey }) || !nativeLeaf.checkPrivateKey(serverKey)) {
    throw new Error('Det äldre servercertifikatet kunde inte verifieras. Inga certifikat ändrades.');
  }
  const signingKey = await webcrypto.subtle.importKey('pkcs8', createPrivateKey(readFileSync(path.join(directory, 'root-ca-key.pem'))).export({ format: 'der', type: 'pkcs8' }), algorithm, false, ['sign']);
  const repaired = await x509.X509CertificateGenerator.create({
    subject: 'CN=Lagustosa Training Server', issuer: ca.subject, publicKey: certificate.publicKey, signingKey,
    serialNumber: randomBytes(16).toString('hex'), signingAlgorithm: algorithm,
    notBefore: certificate.notBefore, notAfter: certificate.notAfter, extensions: certificate.extensions,
  });
  if (!new X509Certificate(Buffer.from(repaired.rawData)).verify(nativeCa.publicKey)) throw new Error('Rotcertifikatets privata nyckel stämmer inte. Inga certifikat ändrades.');

  // Keep the trusted root, both keys, addresses and validity period unchanged.
  const backup = path.join(directory, 'server.legacy-empty-subject.pem');
  if (existsSync(backup) && !readFileSync(backup).equals(original)) throw new Error('En annan certifikatbackup finns redan. Inga certifikat ändrades.');
  if (!existsSync(backup)) copyFileSync(filename, backup, constants.COPYFILE_EXCL);
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, repaired.toString('pem'), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, filename);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await createCertificates(path.resolve('certs'), process.argv.slice(2));
    console.log(`Certifikat skapade för ${result.hosts.join(', ')} i ${result.directory}.`);
    console.log('Rotcertifikatet är inte installerat. Följ README för datorn och plattorna.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
