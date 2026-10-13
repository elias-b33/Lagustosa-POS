import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A real HTTP workflow on a fresh, isolated simulator. No production endpoints,
// existing rounds, browser sessions, physical printers or real payments are used.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = {};
while (args.length) {
  const flag = args.shift();
  assert(['--root', '--port', '--mode'].includes(flag), `Unknown argument: ${flag}`);
  const value = args.shift(); assert(value && !value.startsWith('--'), `Missing ${flag}`);
  options[flag.slice(2)] = value;
}
assert(options.root && options.port && ['rush', 'full'].includes(options.mode), 'Use --root <fresh directory> --port <port> --mode rush|full');
const root = path.resolve(options.root);
const port = Number(options.port);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535 && ![4173, 4183, 4273, 5173].includes(port), 'Use a separate simulation port');
assert(!existsSync(root) || readdirSync(root).length === 0, 'Simulation requires a new empty directory; existing data will not be changed');
const base = `http://127.0.0.1:${port}`;
const launcher = action => execFileSync(process.execPath, [path.join(project, 'scripts/safe-test.mjs'), action, '--root', root, '--port', String(port), '--no-browser'], { cwd: project, windowsHide: true, encoding: 'utf8', timeout: 40000 });
const startedAt = Date.now();
const timings = [];
const checks = [];
const streams = [];
let collisions = 0;
let started = false;
const check = (condition, description) => { assert(condition, description); checks.push(description); };
const sum = (rows, fn) => rows.reduce((total, row) => total + fn(row), 0);
const tabGross = tab => sum(tab.lines.filter(line => line.status !== 'void'), line => line.unitPriceOre * line.quantity);
const key = randomUUID;

async function request(client, endpoint, body, method = 'POST') {
  const time = performance.now();
  const response = await fetch(base + '/api/v1' + endpoint, {
    method: body === undefined ? 'GET' : method,
    headers: { ...(client?.cookie ? { cookie: client.cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  timings.push({ endpoint, status: response.status, ms: performance.now() - time });
  if (!response.ok) throw Object.assign(new Error(result.message), { code: result.code, status: response.status });
  return { result, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
const api = async (client, endpoint, body, method) => (await request(client, endpoint, body, method)).result;
const snapshot = client => api(client, '/bootstrap');

async function login(staffId, pin, deviceCode) {
  const response = await request(null, '/auth/login', { staffId, pin, deviceCode });
  return { cookie: response.cookie, deviceCode, actor: response.result.actor, events: 0 };
}
async function watch(client) {
  const controller = new AbortController();
  const response = await fetch(base + '/api/v1/events', { headers: { cookie: client.cookie }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const accept = value => {
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      if (buffer.slice(0, end).includes('event: change')) client.events++;
      buffer = buffer.slice(end + 2);
    }
  };
  const first = await reader.read(); assert(!first.done, 'Event stream closed before first frame');
  accept(first.value);
  const finished = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { if (!controller.signal.aborted) client.streamError = 'Unexpected stream end'; break; }
        accept(value);
      }
    } catch (error) { if (!controller.signal.aborted) client.streamError = error.message; }
  })();
  streams.push({ controller, finished });
}
async function command(client, tabId, input, commandKey = key(), initialVersion) {
  let version = initialVersion ?? (await api(client, `/tabs/${tabId}`)).version;
  for (let retry = 0; retry < 8; retry++) {
    try { return await api(client, `/tabs/${tabId}/commands`, { key: commandKey, version, ...input }); }
    catch (error) {
      if (error.code !== 'VERSION_CONFLICT') throw error;
      collisions++; version = (await api(client, `/tabs/${tabId}`)).version;
    }
  }
  throw new Error('Too many version conflicts');
}
async function fourServers(servers, tabs, operation) {
  let next = 0;
  await Promise.all(servers.map(async client => {
    while (next < tabs.length) { const index = next++; await operation(client, tabs[index], index); }
  }));
}
async function advance(client, ticket, target) {
  const steps = ['queued', 'started', 'ready', 'served'];
  for (let index = steps.indexOf(ticket.status) + 1; index <= steps.indexOf(target); index++) {
    ticket = await api(client, `/tickets/${ticket.id}/status`, { status: steps[index] });
  }
  return ticket;
}

try {
  process.stdout.write(launcher('start')); started = true;
  const health = await api(null, '/health');
  check(health.environment === 'safe-test' && health.mode === 'training' && health.adapters.payment === 'simulator' && health.adapters.print === 'preview' && health.adapters.fiscal === 'simulator', 'Only isolated simulators are active');
  const admin = await login('admin', '1234', 'LAGUSTOSA-TEST');
  const empty = await snapshot(admin);
  check(!empty.currentDay && empty.tabs.length === 0 && empty.payments.length === 0 && empty.tickets.length === 0, 'Fresh round contains no previous orders or payments');
  const servers = [];
  for (let index = 1; index <= 4; index++) servers.push(await login('waiter', '3456', `SERVERING-${index}`));
  const kitchen = await login('kitchen', '4567', 'KOK-TEST');
  const kitchen2 = await login('kitchen', '4567', 'KOK-TEST-2');
  const bar = await login('bar', '5678', 'BAR-TEST');
  const clients = [admin, ...servers, kitchen, kitchen2, bar];
  for (const client of clients) await watch(client);
  check((await snapshot(admin)).deviceConnections.filter(device => device.connections === 1).length === 8, 'Eight distinct virtual devices connected simultaneously');
  const day = await api(admin, '/business-days', { key: key(), floatOre: 150000 });
  const tables = empty.tables.slice(0, 6);
  for (let index = 0; index < tables.length; index++) {
    await api(admin, `/tables/${tables[index].id}`, { ...tables[index], name: `AW ${index + 1}`, seats: 6, area: 'AW · simulerad bokning' }, 'PUT');
  }
  const tabs = [];
  for (let index = 0; index < 6; index++) tabs.push(await api(servers[index % 4], '/tabs', { key: key(), tableId: tables[index].id, guestCount: 6, serviceMode: 'dine_in' }));
  const mainIds = ['margherita', 'penne', 'diavola', 'sandwalls', 'lasagna', 'filetto'];
  const drinkIds = ['redwine', 'prosecco', 'cola'];
  console.log('AW arrival: 36 guests, six tables, four serving devices.');
  await fourServers(servers, tabs, async (client, tab, index) => {
    for (let guest = 1; guest <= 6; guest++) {
      await command(client, tab.id, { action: 'add', itemId: drinkIds[(guest + index) % 3], guest, hold: false });
      const itemId = mainIds[guest - 1];
      await command(client, tab.id, { action: 'add', itemId, guest, hold: true, ...(itemId === 'filetto' ? { modifiers: ['fried-potatoes', 'pepper', 'medium'] } : {}), notes: guest === 3 ? 'Utan lök · AW-test' : '' });
    }
    await command(client, tab.id, { action: 'add', itemId: 'antipasto', quantity: 2, guest: 0, modifiers: ['medio'], hold: false, notes: 'Delas mellan sex gäster · AW-test' });
    const sendKey = key();
    const sent = await command(client, tab.id, { action: 'send' }, sendKey);
    const repeat = await command(client, tab.id, { action: 'send' }, sendKey, sent.version);
    assert.equal(repeat.version, sent.version, 'Repeated send must return original result');
  });
  let state = await snapshot(admin);
  check(state.tabs.length === 6 && sum(state.tabs, tab => tab.guestCount) === 36, 'All 36 guests have an open table');
  check(state.tabs.flatMap(tab => tab.lines).filter(line => line.status === 'held').length === 36, '36 mains held until deliberately fired');
  check(state.tickets.length === 12 && state.printJobs.length === 12, 'First send yields exactly six kitchen and six bar tickets, including duplicate-send checks');
  const stations = await Promise.all([snapshot(kitchen), snapshot(kitchen2), snapshot(bar)]);
  check(stations[0].tickets.length === 6 && stations[2].tickets.length === 6 && stations[0].tickets.every(ticket => ticket.station === 'kitchen') && stations[2].tickets.every(ticket => ticket.station === 'bar'), 'Kitchen/bar receive only their own station orders');
  assert.deepEqual(stations[0].tickets, stations[1].tickets);
  check(stations.every(display => display.payments.length === 0 && display.receipts.length === 0), 'Displays do not receive payment or receipt data');
  // Simulated paper flow, including one ambiguous result requiring a check.
  for (let index = 0; index < state.printJobs.length; index++) await api(admin, `/print-jobs/${state.printJobs[index].id}/actions`, { action: 'print', outcome: index === 0 ? 'uncertain' : 'printed' });
  const uncertainPrintId = state.printJobs[0].id;
  for (const station of ['kitchen', 'bar']) {
    const tickets = state.tickets.filter(ticket => ticket.station === station);
    for (let index = 0; index < tickets.length; index++) await advance(station === 'bar' ? bar : kitchen, tickets[index], index < 2 ? 'served' : index < 4 ? 'ready' : 'started');
  }
  // A deliberate stale-version collision from two serving devices at one table.
  const collisionTab = await api(servers[0], `/tabs/${tabs[0].id}`);
  await Promise.all([0, 1].map(index => command(servers[index], collisionTab.id, { action: 'add', itemId: 'cola', guest: index + 1, hold: false }, key(), collisionTab.version)));
  check(collisions >= 1, 'Concurrent changes on the same bill recover with the original command key');
  await fourServers(servers, tabs, async (client, tab, index) => {
    for (let guest = index === 0 ? 3 : 1; guest <= 3; guest++) await command(client, tab.id, { action: 'add', itemId: 'cola', guest, hold: false });
    await command(client, tab.id, { action: 'send' });
    await command(client, tab.id, { action: 'fire', course: 'main' });
  });
  let changed = await api(admin, `/tabs/${tabs[0].id}`);
  await command(admin, changed.id, { action: 'remove', lineId: changed.lines.find(line => line.itemId === 'margherita').id, reason: 'AW-test: gästen byter pizza innan tillagning' });
  await command(servers[0], changed.id, { action: 'add', itemId: 'diavola', guest: 1, hold: false, notes: 'Ersätter makulerad Margherita · AW-test' });
  await command(servers[0], changed.id, { action: 'send' });
  state = await snapshot(admin);
  const active = state.tabs.flatMap(tab => tab.lines).filter(line => line.status !== 'void');
  check(active.length === 96 && sum(active, line => line.quantity) === 102, 'Peak contains 54 drinks, 36 mains and 12 sharing platters without lost lines');
  const expectedUnits = { redwine: 12, prosecco: 12, cola: 30, antipasto: 12, margherita: 5, penne: 6, diavola: 7, sandwalls: 6, lasagna: 6, filetto: 6 };
  for (const [itemId, quantity] of Object.entries(expectedUnits)) assert.equal(sum(active.filter(line => line.itemId === itemId), line => line.quantity), quantity, `Quantity for ${itemId}`);
  const orderedItems = state.tickets.filter(ticket => ticket.kind === 'order').flatMap(ticket => ticket.items).filter(line => line.status !== 'void');
  assert.equal(orderedItems.length, active.length);
  for (const line of active) {
    const matches = orderedItems.filter(item => item.id === line.id);
    assert.equal(matches.length, 1, `Exactly one station item for ${line.id}`);
    for (const property of ['itemId', 'quantity', 'guest', 'modifiers', 'notes', 'station', 'course']) assert.deepEqual(matches[0][property], line[property]);
  }
  check(true, 'Every active line appears exactly once in station tickets with guest, modifiers and notes intact');
  const menu = new Map(empty.menu.map(item => [item.id, item]));
  const expectedPeakOre = sum(Object.entries(expectedUnits), ([id, quantity]) => quantity * (menu.get(id).priceOre + (id === 'antipasto' ? menu.get(id).modifiers[0].options.find(option => option.id === 'medio').priceOre : 0)));
  check(sum(state.tabs, tabGross) === expectedPeakOre, 'Peak order total matches independently calculated menu quantities and prices');
  check(state.tickets.length === 26 && state.tickets.filter(ticket => ticket.kind === 'cancel').length === 1, 'Peak includes 26 station tickets with an explicit cancellation');
  check(state.printJobs.every(job => job.printerId === `printer-${job.kind}`), 'Every kitchen/bar job is routed to the matching printer profile');
  check(state.tickets.some(ticket => ticket.kind === 'order' && ticket.items.some(line => line.status === 'void')), 'Cancelled main is marked on its original kitchen ticket');
  const mirror = await Promise.all([snapshot(kitchen), snapshot(kitchen2)]);
  assert.deepEqual(mirror[0].tickets, mirror[1].tickets);
  const eventCounts = clients.map(client => client.events);
  await command(admin, tabs[0].id, { action: 'guests', guestCount: 6 });
  const deadline = Date.now() + 2000;
  while (clients.some((client, index) => client.events <= eventCounts[index]) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  check(clients.every((client, index) => !client.streamError && client.events > eventCounts[index]), 'All eight event streams remain connected and receive the final peak change');
  const peak = {
    guests: 36, tables: 6, virtualDevices: 8, activeLines: active.length, units: sum(active, line => line.quantity),
    drinks: sum(active.filter(line => line.course === 'drink'), line => line.quantity), mains: sum(active.filter(line => line.course === 'main'), line => line.quantity),
    stationTickets: state.tickets.length, kitchenTickets: state.tickets.filter(ticket => ticket.station === 'kitchen').length,
    barTickets: state.tickets.filter(ticket => ticket.station === 'bar').length, printJobs: state.printJobs.length,
    orderValueOre: sum(state.tabs, tabGross),
  };
  console.log('Peak:', JSON.stringify(peak));
  let final = null;
  if (options.mode === 'full') {
    await api(admin, `/print-jobs/${uncertainPrintId}/actions`, { action: 'resolve', outcome: 'failed', reason: 'Simulerad kontroll: inget papper kom ut' });
    const copy = await api(admin, `/print-jobs/${uncertainPrintId}/actions`, { action: 'reprint', reason: 'Verifierat misslyckad testutskrift' });
    check(copy.reprintOf === uncertainPrintId && copy.text.includes('KOPIA'), 'An uncertain print is checked before a labelled replacement copy');
    await fourServers(servers, tabs, async (client, tab) => {
      for (const guest of [1, 2]) {
        await command(client, tab.id, { action: 'add', itemId: 'tiramisu', guest, hold: false });
        await command(client, tab.id, { action: 'add', itemId: 'coffee', guest, hold: false });
      }
      await command(client, tab.id, { action: 'send' });
    });
    state = await snapshot(admin);
    for (const ticket of state.tickets) await advance(ticket.station === 'bar' ? bar : kitchen, ticket, 'served');
    const beforePayment = await snapshot(admin);
    check(beforePayment.tickets.every(ticket => ticket.status === 'served'), 'All station tickets, including the cancellation, are served or acknowledged');
    const expectedSalesOre = expectedPeakOre + 12 * menu.get('tiramisu').priceOre + 12 * menu.get('coffee').priceOre;
    check(sum(beforePayment.tabs, tabGross) === expectedSalesOre, 'Final order total independently includes 12 desserts and 12 coffees');
    await fourServers(servers, tabs, async (client, tab, tableIndex) => {
      let remaining = tabGross(await api(client, `/tabs/${tab.id}`));
      for (let installment = 0; installment < 6; installment++) {
        const amountOre = Math.floor(remaining / (6 - installment));
        const method = tableIndex === 5 ? 'cash' : tableIndex === 4 ? 'swish' : 'card';
        const payer = method === 'cash' ? admin : client;
        if (tableIndex === 0 && installment === 0) {
          const version = (await api(payer, `/tabs/${tab.id}`)).version;
          const declined = await api(payer, `/tabs/${tab.id}/payments`, { key: key(), version, method, amountOre, tipOre: 0, simulation: 'declined' });
          assert.equal(declined.status, 'declined');
        }
        const version = (await api(payer, `/tabs/${tab.id}`)).version;
        const input = { key: key(), version, method, amountOre, tipOre: installment === 0 ? 1000 : 0, simulation: tableIndex === 1 && installment === 0 ? 'unknown' : 'approved', fiscalSimulation: tableIndex === 2 && installment === 0 ? 'unknown' : 'confirmed', ...(method === 'swish' ? { swishVerified: true } : {}), ...(method === 'cash' ? { tenderedOre: amountOre + (installment === 0 ? 1000 : 0) + 10000 } : {}) };
        let payment = await api(payer, `/tabs/${tab.id}/payments`, input);
        if (input.simulation === 'unknown') assert.equal(payment.status, 'unknown', 'The simulated lost reply must first be unknown');
        if (payment.status === 'unknown') payment = await api(payer, `/payments/${payment.id}/check`, {});
        assert.equal(payment.status, 'approved');
        const repeated = await api(payer, `/tabs/${tab.id}/payments`, input);
        assert.equal(repeated.id, payment.id, 'Payment retry must retain payment identity');
        remaining -= amountOre;
      }
      assert.equal(remaining, 0);
    });
    state = await snapshot(admin);
    check(state.receipts.filter(receipt => receipt.fiscalStatus === 'unknown').length === 1, 'One fiscal reply is unknown before explicit verification');
    for (const receipt of state.receipts.filter(receipt => receipt.fiscalStatus !== 'confirmed')) await api(admin, `/receipts/${receipt.id}/verify`, {});
    state = await snapshot(admin);
    check(state.payments.filter(payment => payment.status === 'approved').length === 36 && state.receipts.length === 36, '36 approved split payments produce exactly 36 receipts despite retries');
    check(state.payments.filter(payment => payment.status === 'declined').length === 1 && state.report.unresolved === 0, 'Declined payment and unknown replies are reconciled');
    check(state.report.salesOre === expectedSalesOre && state.report.tipsOre === 6000 && state.tabs.every(tab => tab.status === 'paid'), 'All six bills paid to the exact order total with separate tips');
    check(state.payments.flatMap(payment => payment.allocations).every(row => row.vatOre >= 0 && row.vatOre <= row.grossOre), 'All VAT allocations remain nonnegative and bounded');
    const expectedCashOre = 150000 + sum(state.payments.filter(payment => payment.method === 'cash' && payment.status === 'approved'), payment => payment.amountOre + payment.tipOre);
    check(state.report.expectedCashOre === expectedCashOre, 'Expected cash independently matches opening float plus approved cash sales and cash tips');
    const closing = await api(admin, `/business-days/${day.id}/close`, { key: key(), countedCashOre: expectedCashOre });
    check(closing.status === 'closed' && closing.report.differenceOre === 0, 'Business day closes with zero cash discrepancy');
    state = await snapshot(admin);
    for (const job of state.printJobs.filter(job => job.status === 'queued')) await api(admin, `/print-jobs/${job.id}/actions`, { action: 'print', outcome: 'printed' });
    state = await snapshot(admin);
    check(state.printJobs.every(job => job.printerId === `printer-${['closing', 'drawer'].includes(job.kind) ? 'guest' : job.kind}`), 'Receipt and closing jobs use the guest printer; food/drink keep their destinations');
    check(state.printJobs.filter(job => job.status === 'failed').length === 1 && state.printJobs.every(job => ['failed', 'printed'].includes(job.status)), 'All print jobs reconciled, including one failed original and its printed copy');
    final = { salesOre: closing.report.salesOre, tipsOre: closing.report.tipsOre, vatOre: closing.report.vatOre, cashDifferenceOre: closing.report.differenceOre, approvedPayments: 36, declinedPayments: 1, receipts: state.receipts.length, printJobs: state.printJobs.length, printed: state.printJobs.filter(job => job.status === 'printed').length, stationTickets: state.tickets.length, dayClosed: true };
  }
  check((await api(admin, '/journal')).intact, 'Audit chain remains intact');
  await api(admin, '/backups', {});
  const durations = timings.map(entry => entry.ms).sort((a, b) => a - b);
  const report = {
    mode: options.mode, baseUrl: base, createdAt: new Date().toISOString(), testRoundId: health.testRoundId,
    simulatedScenario: '36 guests at six simulated AW tables; compressed service, not real waiting/kitchen times',
    limitations: ['One computer with eight virtual event clients; not eight physical devices', 'Simulator payments and print previews only', 'Existing example drink prices retained; not an AW package quote', 'Measures this run, not maximum capacity or Wi-Fi reliability'],
    peak, final, checks, expectedVersionConflicts: collisions,
    http: { requests: timings.length, unexpectedErrors: timings.filter(entry => entry.status >= 400 && entry.status !== 409).length, medianMs: Math.round(durations[Math.floor(durations.length * .5)]), p95Ms: Math.round(durations[Math.floor(durations.length * .95)]), maxMs: Math.round(durations.at(-1)) },
    virtualDevices: clients.map(client => ({ device: client.deviceCode, changeEvents: client.events })), elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  };
  writeFileSync(path.join(root, 'aw-report.json'), JSON.stringify(report, null, 2));
  console.log('AW simulation passed:', JSON.stringify(report));
} catch (error) {
  process.exitCode = 1;
  console.error('AW simulation failed:', error.stack);
} finally {
  for (const stream of streams) stream.controller.abort();
  await Promise.allSettled(streams.map(stream => stream.finished));
  if (started && (options.mode === 'full' || process.exitCode)) process.stdout.write(launcher('stop'));
}
