import { spawn } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appId = 'lagustosa-isolated-safe-test';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const defaultRoot = path.join(process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share'), 'LagustosaPOS', 'safe-test');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function argumentsFor(args) {
  const options = { action: args[0] && !args[0].startsWith('--') ? args.shift() : 'start', root: defaultRoot, port: 4273, lan: null, httpLan: false, epson: null, 'epson-profile': 'printer-kitchen', noBrowser: false };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--no-browser') options.noBrowser = true;
    else if (flag === '--http-lan') options.httpLan = true;
    else if (['--root', '--port', '--lan', '--epson', '--epson-profile'].includes(flag)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`Ett värde saknas för ${flag}.`);
      options[flag.slice(2)] = flag === '--port' ? Number(value) : value;
    } else throw new Error(`Okänt val: ${flag}.`);
  }
  if (!['start', 'status', 'stop', 'new-session'].includes(options.action)) throw new Error('Använd start, status, stop eller new-session.');
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('Porten måste vara 1024–65535.');
  if (options.httpLan && !options.lan) throw new Error('--http-lan kräver --lan med datorns egen privata IPv4-adress.');
  if (options.epson && (!privateIPv4(options.epson) || !/^[a-zA-Z0-9_-]{1,100}$/.test(options['epson-profile']))) throw new Error('Ange en privat IPv4-adress och en giltig skrivarprofil för Epson-testet.');
  options.root = path.resolve(options.root);
  return options;
}

function contained(root, ...segments) {
  const target = path.resolve(root, ...segments);
  if (!target.startsWith(root + path.sep)) throw new Error('Testmiljöns sökväg ligger utanför testmappen.');
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Testmiljön får inte använda länkade datamappar.');
  }
  return target;
}

function saveJson(filename, value) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  try { renameSync(temporary, filename); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

const newSessionId = () => `session-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;

function configuration(root, create) {
  if (existsSync(root) && (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())) throw new Error('Testmappen måste vara en vanlig mapp.');
  const filename = contained(root, 'safe-test.json');
  if (!existsSync(filename)) {
    if (!create) return null;
    if (existsSync(root) && readdirSync(root).length) throw new Error('Mappen innehåller redan filer. Välj en tom testmapp; befintliga data ändras inte.');
    mkdirSync(root, { recursive: true });
    try { writeFileSync(filename, JSON.stringify({ appId, version: 1, instanceId: randomUUID(), sessionId: newSessionId() }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const config = JSON.parse(readFileSync(filename, 'utf8'));
  if (config.appId !== appId || config.version !== 1 || !uuidPattern.test(config.instanceId) || !/^session-\d{14}-[0-9a-f]{8}$/.test(config.sessionId)) throw new Error('Testmappens identitet är ogiltig. Befintliga data ändras inte.');
  return config;
}

async function controlLock(root) {
  const filename = contained(root, 'launcher.lock');
  const id = randomUUID();
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      writeFileSync(filename, JSON.stringify({ pid: process.pid, id }), { flag: 'wx', mode: 0o600 });
      return () => { const lock = JSON.parse(readFileSync(filename, 'utf8')); if (lock.id === id && lock.pid === process.pid) unlinkSync(filename); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(filename, 'utf8'));
        if (!running(owner.pid)) { unlinkSync(filename); continue; }
      } catch (issue) { if (issue.code !== 'ENOENT' && !(issue instanceof SyntaxError)) throw issue; }
      if (Date.now() >= deadline) throw new Error('Ett annat startverktyg arbetar med testmiljön. Försök igen när det är klart.');
      await delay(80);
    }
  }
}

function running(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Ogiltig serverprocess.');
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function runtimeFor(root, config) {
  const filename = contained(root, 'server.json');
  if (!existsSync(filename)) return null;
  const state = JSON.parse(readFileSync(filename, 'utf8'));
  if (state.epson && (!privateIPv4(state.epson.host) || !/^[a-zA-Z0-9_-]{1,100}$/.test(state.epson.printerId))) throw new Error('Ogiltig Epson-testkonfiguration.');
  if (state.instanceId !== config.instanceId || !uuidPattern.test(state.launchId) || state.sessionId !== config.sessionId || !Number.isInteger(state.port) || state.port < 1024 || state.port > 65535 || (state.caDirectory && !/^lan-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}$/.test(state.caDirectory))) throw new Error('Serverinformationen stämmer inte med testomgången.');
  const protocol = state.caDirectory ? 'https' : 'http';
  const host = state.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && !privateIPv4(host)) throw new Error('Ogiltig nätverksadress i testmiljön.');
  if (state.httpLan && (state.caDirectory || !privateIPv4(host))) throw new Error('Ogiltig HTTP-hemtestkonfiguration.');
  state.baseUrl = `${protocol}://${host}:${state.port}`;
  state.healthUrl = state.baseUrl + '/api/v1/health';
  state.caFile = state.caDirectory ? contained(root, 'certificates', state.caDirectory, 'root-ca.pem') : null;
  return state;
}

function health(state) {
  return new Promise(resolve => {
    const transport = state.caFile ? https : http;
    const request = transport.get(state.healthUrl, { ...(state.caFile ? { ca: readFileSync(state.caFile) } : {}), timeout: 1200 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 65536) request.destroy(); });
      response.on('end', () => { try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); } });
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

function matches(result, config, state) {
  return result?.ok === true && result.mode === 'training' && result.environment === 'safe-test' && Boolean(result.httpLan) === Boolean(state.httpLan) && result.instanceId === config.instanceId && result.launchId === state.launchId && result.testRoundId === config.sessionId && result.processId === state.pid && result.adapters?.payment === 'simulator' && result.adapters?.fiscal === 'simulator' && result.adapters?.print === (state.epson ? 'epson-test' : 'preview') && (!state.epson || (result.testPrinter?.host === state.epson.host && result.testPrinter?.printerId === state.epson.printerId));
}

async function stop(root, config) {
  const state = runtimeFor(root, config);
  if (!state) return;
  if (running(state.pid)) {
    if (!matches(await health(state), config, state)) throw new Error('Serverprocessens identitet kunde inte verifieras. Ingen process stoppades. Kontrollera testmiljön manuellt.');
    process.kill(state.pid, 'SIGTERM');
    const until = Date.now() + 7000;
    while (running(state.pid) && Date.now() < until) await delay(100);
    if (running(state.pid)) throw new Error('Testservern har inte stannat än. Testomgången bevaras.');
  }
  unlinkSync(contained(root, 'server.json'));
}

function privateIPv4(value) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  return parts.every(part => part <= 255) && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}

function validateLanAddress(address) {
  const addresses = Object.values(networkInterfaces()).flat().filter(Boolean).filter(item => !item.internal).map(item => item.address);
  if (!privateIPv4(address) || !addresses.includes(address)) throw new Error('Ange datorns egen privata IPv4-adress, exempelvis 192.168.1.50.');
}

async function certificates(root, address) {
  validateLanAddress(address);
  const caDirectory = 'lan-' + address.replaceAll('.', '-');
  const directory = contained(root, 'certificates', caDirectory);
  if (!existsSync(directory)) {
    const { createCertificates } = await import('./create-certs.mjs');
    await createCertificates(directory, [address]);
    writeFileSync(path.join(directory, 'Lagustosa-Test-CA.cer'), new X509Certificate(readFileSync(path.join(directory, 'root-ca.pem'))).raw);
  }
  for (const file of ['root-ca.pem', 'server.pem', 'server-key.pem', 'Lagustosa-Test-CA.cer']) {
    if (!existsSync(contained(root, 'certificates', caDirectory, file))) throw new Error('Testmiljöns certifikat är ofullständiga. Återskapa dem i en ny certifikatmapp.');
  }
  const { repairLegacyServerCertificate } = await import('./create-certs.mjs');
  if (await repairLegacyServerCertificate(directory)) console.log('Ett äldre servercertifikat har rättats. Samma rotcertifikat och testdata används.');
  return { caDirectory, directory };
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { windowsHide: true, detached: true, stdio: 'ignore' });
  child.on('error', () => console.error(`Öppna ${url} i webbläsaren.`));
  child.unref();
}

function printReady(root, config, state) {
  console.log(`${state.httpLan ? 'HEMTEST UTAN CERTIFIKAT' : 'SÄKER TESTMILJÖ'} redo: ${state.baseUrl}/`);
  if (state.httpLan) console.log('Okrypterad HTTP på det privata testnätet. Använd endast testuppgifter.');
  console.log(state.epson ? `Simulerade betalningar och kontrollenhet. MANUELL FYSISK TESTUTSKRIFT: ${state.epson.printerId} → Epson ${state.epson.host}. Övriga profiler förhandsvisas.` : 'Endast simulerade betalningar, kontrollenhet och utskriftsförhandsvisning.');
  console.log(`Testomgång: ${config.sessionId}`);
  console.log(`Separat datamapp: ${contained(root, 'sessions', config.sessionId)}`);
  console.log(`Serverlogg: ${contained(root, 'sessions', config.sessionId, 'server.log')}`);
  console.log('Logga in: Ansvarig · PIN 1234 · enhetskod LAGUSTOSA-TEST. Öppna sedan dagen.');
  if (state.caFile) {
    const cert = new X509Certificate(readFileSync(state.caFile));
    console.log(`Rotcertifikat att installera på testenheterna: ${path.join(path.dirname(state.caFile), 'Lagustosa-Test-CA.cer')}`);
    console.log(`SHA-256: ${cert.fingerprint256}`);
    console.log('Certifikatförtroende och eventuell privat brandväggsregel ställs in manuellt. Se TEST-GUIDE.md.');
  }
}

async function start(options, config) {
  const { root } = options;
  const previous = runtimeFor(root, config);
  if (previous && running(previous.pid)) {
    if (!matches(await health(previous), config, previous)) throw new Error('En process kör enligt testmappen men servern kunde inte verifieras. Ingen ny process startades.');
    if (previous.port !== options.port || previous.host !== (options.lan || '127.0.0.1')) throw new Error('Testservern kör redan med en annan adress. Stoppa testmiljön innan adressen ändras.');
    if (Boolean(previous.httpLan) !== options.httpLan) throw new Error('Testservern kör med ett annat HTTP/HTTPS-läge. Stoppa testmiljön innan läget ändras.');
    if ((previous.epson?.host ?? null) !== options.epson || (previous.epson && previous.epson.printerId !== options['epson-profile'])) throw new Error('Testservern kör med en annan skrivarkoppling. Stoppa testmiljön innan skrivarkopplingen ändras.');
    printReady(root, config, previous);
    if (!options.noBrowser) openBrowser(previous.baseUrl + '/');
    return;
  }
  if (!existsSync(path.join(projectRoot, 'dist', 'server', 'index.js')) || !existsSync(path.join(projectRoot, 'dist', 'web', 'index.html'))) throw new Error('Den byggda appen saknas. Kör npm run build eller använd Windows-paketet.');
  if (options.lan) validateLanAddress(options.lan);
  const tls = options.lan && !options.httpLan ? await certificates(root, options.lan) : null;
  const state = { pid: 0, instanceId: config.instanceId, launchId: randomUUID(), sessionId: config.sessionId, port: options.port, host: options.lan || '127.0.0.1', caDirectory: tls?.caDirectory ?? null, httpLan: options.httpLan, projectRoot };
  state.epson = options.epson ? { host: options.epson, printerId: options['epson-profile'] } : null;
  state.baseUrl = `${tls ? 'https' : 'http'}://${state.host}:${state.port}`;
  state.healthUrl = state.baseUrl + '/api/v1/health';
  state.caFile = tls ? path.join(tls.directory, 'root-ca.pem') : null;
  if (await health(state)) throw new Error(`Port ${options.port} används redan av en annan server. Den ändrades inte.`);
  const dataDir = contained(root, 'sessions', config.sessionId);
  mkdirSync(dataDir, { recursive: true });
  const emptyEnvironment = contained(root, 'safe-test.env');
  writeFileSync(emptyEnvironment, '# Testmiljöns inställningar bestäms av startverktyget.\n');
  const logFile = openSync(contained(root, 'sessions', config.sessionId, 'server.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, ['dist/server/index.js'], {
      cwd: projectRoot, detached: true, windowsHide: true, stdio: ['ignore', logFile, logFile],
      env: { ...process.env, APP_MODE: 'training', PAYMENT_ADAPTER: 'simulator', FISCAL_ADAPTER: 'simulator', PRINT_ADAPTER: state.epson ? 'epson-test' : 'preview', EPSON_TEST_HOST: state.epson?.host ?? '', EPSON_TEST_PROFILE: state.epson?.printerId ?? '', NODE_ENV: 'production', npm_lifecycle_event: 'safe-test', DOTENV_CONFIG_PATH: emptyEnvironment, DOTENV_CONFIG_QUIET: 'true', DATA_DIR: dataDir, BACKUP_DIR: path.join(dataDir, 'backups'), HOST: state.host, PORT: String(options.port), TLS_CERT: tls ? path.join(tls.directory, 'server.pem') : '', TLS_KEY: tls ? path.join(tls.directory, 'server-key.pem') : '', SAFE_TEST_HTTP_LAN: options.httpLan ? '1' : '', SESSION_COOKIE_NAME: 'lagustosa_safe_test_' + config.instanceId.replaceAll('-', '') + (options.httpLan ? '_http' : ''), TEST_ENVIRONMENT: 'safe-test', TEST_INSTANCE_ID: config.instanceId, TEST_LAUNCH_ID: state.launchId, TEST_SESSION_ID: config.sessionId },
    });
  } finally { closeSync(logFile); }
  let spawnError;
  state.pid = child.pid;
  child.on('error', error => { spawnError = error; });
  const deadline = Date.now() + 20000;
  try {
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) break;
      if (matches(await health(state), config, state)) { ready = true; break; }
      await delay(120);
    }
    if (!ready) throw new Error(`Testservern kunde inte starta. Läs ${path.join(dataDir, 'server.log')}.`);
    saveJson(contained(root, 'server.json'), state);
    child.unref();
    printReady(root, config, state);
    if (!options.noBrowser) openBrowser(state.baseUrl + '/');
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  }
}

try {
  const options = argumentsFor(process.argv.slice(2));
  let config = configuration(options.root, ['start', 'new-session'].includes(options.action));
  if (!config) console.log('Ingen säker testmiljö har startats än.');
  else {
    const releaseLock = await controlLock(options.root);
    try {
      config = configuration(options.root, false);
      if (options.action === 'stop') { await stop(options.root, config); console.log('Testservern är stoppad. Alla testomgångar är bevarade.'); }
      else if (options.action === 'status') {
        const state = runtimeFor(options.root, config);
        if (state && matches(await health(state), config, state)) printReady(options.root, config, state);
        else console.log('Testmiljön är stoppad eller kan inte verifieras.');
      } else {
        if (options.action === 'new-session') {
          await stop(options.root, config);
          config = { ...config, sessionId: newSessionId() };
          saveJson(contained(options.root, 'safe-test.json'), config);
          console.log('En ny testomgång startas. Föregående testdata och säkerhetskopior är bevarade.');
        }
        await start(options, config);
      }
    } finally { releaseLock(); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
