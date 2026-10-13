import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp, assertTrainingMode } from './app';
import { demand } from './errors';
import { acquireDatabaseLock } from '../scripts/database-lock.mjs';

assertTrainingMode(process.env);
const dataDir = path.resolve(process.env.DATA_DIR || './data');
const releaseDatabaseLock = acquireDatabaseLock(dataDir);
process.on('exit', releaseDatabaseLock);
const certPath = process.env.TLS_CERT || '';
const keyPath = process.env.TLS_KEY || '';
if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('Både TLS_CERT och TLS_KEY måste anges.');
const https = certPath && keyPath ? { cert: readFileSync(certPath), key: readFileSync(keyPath) } : undefined;
const safeTest = process.env.TEST_ENVIRONMENT === 'safe-test' ? { instanceId: process.env.TEST_INSTANCE_ID || '', launchId: process.env.TEST_LAUNCH_ID || '', sessionId: process.env.TEST_SESSION_ID || '' } : undefined;
const host = process.env.HOST || '127.0.0.1';
if (safeTest) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  demand(uuid.test(safeTest.instanceId) && uuid.test(safeTest.launchId), 'Testmiljön saknar giltig identitet.', 500);
  demand(/^[a-zA-Z0-9_-]{1,100}$/.test(safeTest.sessionId), 'Testomgången saknar giltig identitet.', 500);
  demand(Boolean(https) || ['127.0.0.1', '::1', 'localhost'].includes(host), 'Testmiljön behöver HTTPS för anslutningar från andra enheter.', 500);
}
const builtWeb = path.resolve('dist/web');
const development = process.env.NODE_ENV === 'development' || process.env.npm_lifecycle_event === 'dev';
const { app, service } = await createApp({ database: path.join(dataDir, 'training.sqlite'), backupDir: path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups')), webDir: !development && existsSync(builtWeb) ? builtWeb : undefined, https, logger: true, development, sessionCookieName: process.env.SESSION_COOKIE_NAME, safeTest });
const port = Number(process.env.PORT || 4173);
await app.listen({ host, port });
const automaticBackup = setInterval(() => service.backup('system').catch(error => app.log.error(error)), 3600000);
automaticBackup.unref();
const shutdown = async () => {
  clearInterval(automaticBackup);
  await app.close();
  releaseDatabaseLock();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
