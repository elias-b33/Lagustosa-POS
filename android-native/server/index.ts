import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createNativeApp } from './app';
import { assertTrainingMode } from '../../server/app';
import { assertTestTransport } from '../../server/test-network';
import { acquireDatabaseLock } from '../../scripts/database-lock.mjs';

assertTrainingMode(process.env);
// No implicit ./data fallback: the native demo must have its own explicit directory.
if (!process.env.NATIVE_DATA_DIR) throw new Error('Ange NATIVE_DATA_DIR för en separat native-testdatabas.');
const dataDir = path.resolve(process.env.NATIVE_DATA_DIR);
const releaseLock = acquireDatabaseLock(dataDir);
process.on('exit', releaseLock);
const cert = process.env.TLS_CERT, key = process.env.TLS_KEY;
if (Boolean(cert) !== Boolean(key)) throw new Error('Både TLS_CERT och TLS_KEY måste anges.');
const https = cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;
assertTestTransport(process.env, Boolean(https));
const { app, service } = await createNativeApp({
  database: path.join(dataDir, 'training.sqlite'), backupDir: path.join(dataDir, 'backups'),
  sessionCookieName: 'native_demo_session', https, logger: true,
});
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 4198) });
const backup = setInterval(() => service.backup('system').catch(e => app.log.error(e)), 3600000);
backup.unref();
async function shutdown() { clearInterval(backup); await app.close(); releaseLock(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
