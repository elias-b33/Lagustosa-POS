import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const packageDir = path.resolve(process.argv[2] || '');
const runtime = path.join(packageDir, 'runtime', 'node.exe');
if (!process.argv[2] || !existsSync(runtime)) throw new Error('Ange ett färdigt Windows-paket.');
const dataDir = mkdtempSync(path.join(tmpdir(), 'lagustosa-package-check-'));
const child = spawn(runtime, ['dist/server/index.js'], {
  cwd: packageDir, windowsHide: true, stdio: 'pipe',
  env: { ...process.env, PORT: '4193', HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_DIR: path.join(dataDir, 'backups'), APP_MODE: 'training', TLS_CERT: '', TLS_KEY: '' },
});
let logs = '';
child.stdout.on('data', data => { logs += data.toString(); });
child.stderr.on('data', data => { logs += data.toString(); });
try {
  const started = Date.now();
  while (!logs.includes('Server listening at http://127.0.0.1:4193')) {
    if (child.exitCode !== null || Date.now() - started > 15000) throw new Error('Paketets server startade inte: ' + logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const base = 'http://127.0.0.1:4193';
  assert.equal((await (await fetch(base + '/api/v1/health')).json()).mode, 'training');
  assert.match(await (await fetch(base)).text(), /Lagustosa Kassa/);
  const login = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const state = await (await fetch(base + '/api/v1/bootstrap', { headers: { Cookie: cookie } })).json();
  assert.equal(state.tables.length, 12);
  assert.equal(state.actor.staff.role, 'admin');
  console.log('Windows-paket verifierat: medföljande Node, server, webbapp, databas och inloggning fungerar.');
} finally {
  if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  rmSync(dataDir, { recursive: true, force: true });
}
