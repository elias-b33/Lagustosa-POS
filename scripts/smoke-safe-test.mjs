import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { verifyDatabase } from './database-tools.mjs';

const project = path.resolve(process.argv[2] || '.');
const runtime = process.platform === 'win32' && existsSync(path.join(project, 'runtime', 'node.exe')) ? path.join(project, 'runtime', 'node.exe') : process.execPath;
const temporary = mkdtempSync(path.join(tmpdir(), 'lagustosa-safe-env-check-'));
const root = path.join(temporary, 'isolated');
const conflictRoot = path.join(temporary, 'conflict');
const readConfig = () => JSON.parse(readFileSync(path.join(root, 'safe-test.json'), 'utf8'));
const readRuntime = () => JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8'));
const key = () => randomUUID();
let port;

async function cli(action, extra = [], selectedRoot = root) {
  const script = path.join(project, 'scripts', 'safe-test.mjs');
  const args = [script, action, '--root', selectedRoot, '--port', String(port), '--no-browser', ...extra];
  // Exercise the actual Windows launcher as well as the Node CLI in a portable package.
  const useWindowsLauncher = process.platform === 'win32' && !extra.length;
  const executable = useWindowsLauncher ? 'powershell.exe' : runtime;
  const commandArgs = useWindowsLauncher ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'scripts', 'start-safe-test.ps1'), '-Action', action, '-TestRoot', selectedRoot, '-Port', String(port), '-NoBrowser'] : args;
  const child = spawn(executable, commandArgs, { cwd: project, windowsHide: true, stdio: 'pipe', env: { ...process.env, APP_MODE: 'production', PAYMENT_ADAPTER: 'live', FISCAL_ADAPTER: 'live', PRINT_ADAPTER: 'physical', TLS_CERT: 'not-a-certificate', TLS_KEY: 'not-a-key', HOST: '0.0.0.0', DATA_DIR: path.join(temporary, 'must-not-be-used'), NODE_ENV: 'development' } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 40000);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    return { code, output };
  } finally { clearTimeout(timer); }
}

async function api(base, route, cookie, body) {
  const response = await fetch(base + '/api/v1' + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, await response.clone().text());
  return { response, data: await response.json() };
}

function secureRequest(url, ca, cookie) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { ...(ca ? { ca } : {}), headers: cookie ? { Cookie: cookie } : {}, timeout: 3000 }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(body) }); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('TLS request timed out')));
    request.on('error', reject);
  });
}

try {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const started = await cli('start'); assert.equal(started.code, 0, started.output);
  const original = readConfig(); const firstProcess = readRuntime();
  assert.equal(firstProcess.projectRoot, project);
  const health = (await api(base, '/health')).data;
  assert.equal(health.instanceId, original.instanceId);
  assert.deepEqual(health.adapters, { payment: 'simulator', fiscal: 'simulator', print: 'preview' });
  assert.equal(health.environment, 'safe-test');
  assert.equal(existsSync(path.join(temporary, 'must-not-be-used')), false);
  const repeated = await cli('start'); assert.equal(repeated.code, 0, repeated.output);
  assert.equal(readRuntime().pid, firstProcess.pid, 'Opening the launcher twice must reuse the verified server');
  const simultaneous = await Promise.all([cli('start'), cli('start')]);
  for (const result of simultaneous) assert.equal(result.code, 0, result.output);
  assert.equal(readRuntime().pid, firstProcess.pid, 'Concurrent launches must reuse the verified server');

  const collision = await cli('start', [], conflictRoot); assert.equal(collision.code, 1); assert.match(collision.output, /Port .*används redan/);
  assert.equal((await api(base, '/health')).data.launchId, firstProcess.launchId);
  assert.equal(existsSync(path.join(conflictRoot, 'sessions')), false);
  const foreign = path.join(temporary, 'existing-data'); mkdirSync(foreign); writeFileSync(path.join(foreign, 'training.sqlite'), 'preserve-existing-data');
  const foreignStart = await cli('start', [], foreign); assert.equal(foreignStart.code, 1);
  assert.equal(readFileSync(path.join(foreign, 'training.sqlite'), 'utf8'), 'preserve-existing-data');

  const login = await api(base, '/auth/login', null, { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' });
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^lagustosa_safe_test_[a-f0-9]{32}=/);
  let state = (await api(base, '/bootstrap', cookie)).data;
  assert.equal(state.testEnvironment, 'safe-test'); assert.equal(state.tables.length, 12); assert.equal(state.devices.length, 8); assert.equal(state.printers.length, 3); assert.equal(state.currentDay, null);
  await api(base, '/business-days', cookie, { key: key(), floatOre: 150000 });
  let tab = (await api(base, '/tabs', cookie, { key: key(), tableId: 'table-1', guestCount: 2, serviceMode: 'dine_in' })).data;
  for (const command of [{ action: 'add', itemId: 'bread' }, { action: 'add', itemId: 'redwine' }, { action: 'send' }]) tab = (await api(base, `/tabs/${tab.id}/commands`, cookie, { ...command, key: key(), version: tab.version })).data;
  const payment = (await api(base, `/tabs/${tab.id}/payments`, cookie, { key: key(), version: tab.version, method: 'card', tipOre: 500, simulation: 'approved', fiscalSimulation: 'confirmed' })).data;
  assert.equal(payment.status, 'approved');
  state = (await api(base, '/bootstrap', cookie)).data;
  assert.equal(state.payments.length, 1); assert.equal(state.receipts.length, 1);
  assert.deepEqual(new Set(state.printJobs.map(job => job.printerId)), new Set(['printer-guest', 'printer-kitchen', 'printer-bar']));
  await api(base, '/backups', cookie, {});
  const oldDatabase = path.join(root, 'sessions', original.sessionId, 'training.sqlite');
  assert.equal(existsSync(oldDatabase), true);
  const oldBytes = readFileSync(oldDatabase);

  // A stale/mistaken PID must never stop an unrelated process.
  const stateFile = path.join(root, 'server.json');
  writeFileSync(stateFile, JSON.stringify({ ...firstProcess, pid: process.pid }));
  const unsafeStop = await cli('stop'); assert.equal(unsafeStop.code, 1); assert.match(unsafeStop.output, /Ingen process stoppades/);
  assert.equal((await api(base, '/health')).data.launchId, firstProcess.launchId);
  writeFileSync(stateFile, JSON.stringify(firstProcess));

  const fresh = await cli('new-session'); assert.equal(fresh.code, 0, fresh.output);
  const current = readConfig(); assert.notEqual(current.sessionId, original.sessionId); assert.equal(current.instanceId, original.instanceId);
  assert.equal(existsSync(oldDatabase), true); assert.equal(readFileSync(oldDatabase).length >= oldBytes.length, true);
  verifyDatabase(oldDatabase);
  const preserved = new Database(oldDatabase, { readonly: true, fileMustExist: true });
  try {
    assert.equal(preserved.prepare("SELECT COUNT(*) AS count FROM entities WHERE kind='payment'").get().count, 1);
    assert.equal(preserved.prepare("SELECT COUNT(*) AS count FROM entities WHERE kind='receipt'").get().count, 1);
  } finally { preserved.close(); }
  const newLogin = await api(base, '/auth/login', null, { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' });
  const newCookie = newLogin.response.headers.get('set-cookie').split(';')[0];
  state = (await api(base, '/bootstrap', newCookie)).data;
  assert.deepEqual([state.tabs.length, state.payments.length, state.receipts.length, state.printJobs.length], [0, 0, 0, 0]); assert.equal(state.currentDay, null);
  const invalidOptions = await cli('start', ['--port', '0']); assert.equal(invalidOptions.code, 1);
  const stopped = await cli('stop'); assert.equal(stopped.code, 0, stopped.output);
  assert.equal(existsSync(path.join(root, 'server.json')), false); assert.equal(existsSync(oldDatabase), true);

  const invalidConfig = { ...current, sessionId: '../escape' }; writeFileSync(path.join(root, 'safe-test.json'), JSON.stringify(invalidConfig));
  const invalidStart = await cli('start'); assert.equal(invalidStart.code, 1); assert.match(invalidStart.output, /identitet är ogiltig/);
  writeFileSync(path.join(root, 'safe-test.json'), JSON.stringify(current));

  const privateAddress = Object.values(networkInterfaces()).flat().filter(Boolean).find(item => !item.internal && item.family === 'IPv4' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
  if (privateAddress) {
    const lan = await cli('start', ['--lan', privateAddress]); assert.equal(lan.code, 0, lan.output);
    const lanState = readRuntime(); assert.equal(lanState.host, privateAddress);
    const caFile = path.join(root, 'certificates', lanState.caDirectory, 'root-ca.pem'); const ca = readFileSync(caFile);
    assert.equal((await secureRequest(`https://${privateAddress}:${port}/api/v1/health`, ca)).data.instanceId, current.instanceId);
    await assert.rejects(secureRequest(`https://${privateAddress}:${port}/api/v1/health`), error => ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code));
    console.log('LAN check passed: private address, verified local CA and HTTPS; CA trust was not installed.');
    const ended = await cli('stop'); assert.equal(ended.code, 0, ended.output);
  } else console.log('No private IPv4 interface available; LAN smoke check skipped.');

  console.log('Safe environment verified: Windows launcher/Node runtime, isolated data and cookie, forced simulators, startup identity, duplicate launch, preserved test rounds, backup and guarded stop.');
} finally {
  if (existsSync(path.join(root, 'safe-test.json'))) {
    const cleanup = await cli('stop');
    if (cleanup.code !== 0) throw new Error('Test cleanup failed; preserved files in ' + temporary + ': ' + cleanup.output);
  }
  const resolvedTemporary = path.resolve(temporary);
  if (!resolvedTemporary.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolvedTemporary).startsWith('lagustosa-safe-env-check-')) throw new Error('Invalid cleanup target');
  rmSync(resolvedTemporary, { recursive: true, force: true });
}
