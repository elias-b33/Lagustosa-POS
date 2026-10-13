import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createApp, assertTrainingMode } from './app';
import { demand } from './errors';

assertTrainingMode(process.env);
const dataDir = path.resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true });
const lockFile = path.join(dataDir, 'training.lock');
if (existsSync(lockFile)) {
  let running = false;
  try { const lock = JSON.parse(readFileSync(lockFile, 'utf8')); process.kill(lock.pid, 0); running = true; } catch {}
  if (running) throw new Error('Kassan kör redan med denna databas.');
  unlinkSync(lockFile);
}
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
const removeLock = () => { try { const lock = JSON.parse(readFileSync(lockFile, 'utf8')); if (lock.pid === process.pid) unlinkSync(lockFile); } catch {} };
process.on('exit', removeLock);
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
  removeLock();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
