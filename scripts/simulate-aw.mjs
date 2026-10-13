import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { parseAwOptions, expectedAw, dispatchBookings, mainIds, drinkIds, awUsage } from './aw-scenario.mjs';

// A real HTTP workflow on a fresh, isolated simulator. No production endpoints,
// existing rounds, browser sessions, physical printers or real payments are used.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--help')) { console.log(awUsage); process.exit(0); }
const options = parseAwOptions(process.argv.slice(2));
const root = path.resolve(options.root);
const { port, guests, paceMs, split } = options;
const tableCount = guests / 6;
assert(!existsSync(root) || readdirSync(root).length === 0, 'Simulation requires a new empty directory; existing data will not be changed');
const base = `http://127.0.0.1:${port}`;
const launcher = action => execFileSync(process.execPath, [path.join(project, 'scripts/safe-test.mjs'), action, '--root', root, '--port', String(port), '--no-browser'], { cwd: project, windowsHide: true, encoding: 'utf8', timeout: 40000 });
const startedAt = Date.now();
const timings = [];
const checks = [];
const streams = [];
const phases = [];
let collisions = 0;
let started = false;
let activeRequests = 0;
let maxActiveRequests = 0;
let phase = 'setup';
let runReport = null;
const check = (condition, description) => { assert(condition, description); checks.push(description); };
const sum = (rows, fn) => rows.reduce((total, row) => total + fn(row), 0);
const tabGross = tab => sum(tab.lines.filter(line => line.status !== 'void'), line => line.unitPriceOre * line.quantity);
const key = randomUUID;
const pace = () => paceMs ? new Promise(resolve => setTimeout(resolve, paceMs)) : Promise.resolve();

async function request(client, endpoint, body, method = 'POST') {
  const time = performance.now();
  const trace = { endpoint, method: body === undefined ? 'GET' : method, device: client?.deviceCode ?? 'anonymous', phase, status: 0, expectedError: false, ms: 0 };
  activeRequests++; maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
  try {
    const response = await fetch(base + '/api/v1' + endpoint, {
      method: trace.method,
      headers: { ...(client?.cookie ? { cookie: client.cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    });
    trace.status = response.status;
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), { code: result.code, status: response.status });
    return { result, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  } catch (error) {
    trace.error = error.message; trace.code = error.code ?? 'NETWORK_OR_RESPONSE'; error.trace = trace; throw error;
  } finally {
    trace.ms = performance.now() - time; timings.push(trace); activeRequests--;
  }
}
const api = async (client, endpoint, body, method) => (await request(client, endpoint, body, method)).result;
const snapshot = client => api(client, '/bootstrap');
async function expectError(operation, code) {
  try { await operation(); assert.fail(`Expected ${code}`); }
  catch (error) { assert.equal(error.code, code); error.trace.expectedError = true; }
}

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
    try { const result = await api(client, `/tabs/${tabId}/commands`, { key: commandKey, version, ...input }); await pace(); return result; }
    catch (error) {
      if (error.code !== 'VERSION_CONFLICT') throw error;
      error.trace.expectedError = true;
      collisions++; version = (await api(client, `/tabs/${tabId}`)).version;
    }
  }
  throw new Error('Too many version conflicts');
}
async function fourServers(name, servers, tabs, operation) {
  phase = name;
  const start = performance.now(); const before = timings.length;
  const workers = await dispatchBookings(servers, tabs, operation);
  phases.push({ name, elapsedMs: Math.round(performance.now() - start), requests: timings.length - before, bookings: tabs.length, ...workers });
  phase = 'between-phases';
}
async function advance(client, ticket, target) {
  const steps = ['queued', 'started', 'ready', 'served'];
  for (let index = steps.indexOf(ticket.status) + 1; index <= steps.indexOf(target); index++) {
    ticket = await api(client, `/tickets/${ticket.id}/status`, { status: steps[index] });
  }
  return ticket;
}

try {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  process.stdout.write(launcher('start')); started = true;
  const health = await api(null, '/health');
  check(health.environment === 'safe-test' && health.mode === 'training' && health.adapters.payment === 'simulator' && health.adapters.print === 'preview' && health.adapters.fiscal === 'simulator', 'Only isolated simulators are active');
  const admin = await login('admin', '1234', 'LAGUSTOSA-TEST');
  const empty = await snapshot(admin);
  check(!empty.currentDay && empty.tabs.length === 0 && empty.payments.length === 0 && empty.tickets.length === 0, 'Fresh round contains no previous orders or payments');
  const expected = expectedAw(empty.menu, guests, split);
  writeFileSync(path.join(root, 'aw-expected.json'), JSON.stringify(expected, null, 2));
  const servers = [];
  for (let index = 1; index <= 4; index++) servers.push(await login('waiter', '3456', `SERVERING-${index}`));
  const kitchen = await login('kitchen', '4567', 'KOK-TEST');
  const kitchen2 = await login('kitchen', '4567', 'KOK-TEST-2');
  const bar = await login('bar', '5678', 'BAR-TEST');
  const clients = [admin, ...servers, kitchen, kitchen2, bar];
  for (const client of clients) await watch(client);
  check((await snapshot(admin)).deviceConnections.filter(device => device.connections === 1).length === 8, 'Eight distinct virtual devices connected simultaneously');
  check(empty.printers.length === 3 && new Set(empty.printers.map(printer => printer.destination)).size === 3, 'Exactly three printer queues are configured');
  const day = await api(admin, '/business-days', { key: key(), floatOre: expected.openingFloatOre });
  for (const taxClass of ['food', 'alcohol', 'standard']) {
    const rules = empty.settings.taxRules.filter(rule => rule.mode === 'dine_in' && rule.taxClass === taxClass && rule.from <= day.date && (!rule.until || rule.until >= day.date)).sort((left, right) => right.from.localeCompare(left.from));
    assert.equal(rules[0]?.rateBps, taxClass === 'food' ? 1200 : 2500, 'Oracle VAT assumption must match configured dine-in tax rate');
  }
  const tables = Array.from({ length: tableCount }, (_, index) => empty.tables[index] ?? { id: `aw-table-${index + 1}`, active: true, x: 10 + index % 5 * 18, y: 10 + Math.floor(index / 5) * 18 });
  for (let index = 0; index < tables.length; index++) {
    await api(admin, `/tables/${tables[index].id}`, { ...tables[index], name: `AW ${index + 1}`, seats: 6, area: 'AW · simulerad bokning' }, 'PUT');
  }
  const tabs = Array(tableCount);
  await fourServers('simultaneous-arrival', servers, tables, async (client, table, index) => {
    tabs[index] = await api(client, '/tabs', { key: key(), tableId: table.id, guestCount: 6, serviceMode: 'dine_in' });
  });
  console.log(`AW arrival: ${guests} guests, ${tableCount} bookings, four concurrent serving clients; pacing ${paceMs} ms, ${split} split.`);
  await fourServers('first-orders', servers, tabs, async (client, tab, index) => {
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
  check(state.tabs.length === tableCount && sum(state.tabs, tab => tab.guestCount) === guests, `All ${guests} guests have an open table in the same arrival wave`);
  check(state.tabs.flatMap(tab => tab.lines).filter(line => line.status === 'held').length === guests, `${guests} mains held until deliberately fired`);
  check(state.tickets.length === tableCount * 2 && state.printJobs.length === tableCount * 2, `First send yields exactly ${tableCount} kitchen and ${tableCount} bar tickets, including duplicate-send checks`);
  const stations = await Promise.all([snapshot(kitchen), snapshot(kitchen2), snapshot(bar)]);
  check(stations[0].tickets.length === tableCount && stations[2].tickets.length === tableCount && stations[0].tickets.every(ticket => ticket.station === 'kitchen') && stations[2].tickets.every(ticket => ticket.station === 'bar'), 'Kitchen/bar receive only their own station orders');
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
  await fourServers('second-drinks-and-mains', servers, tabs, async (client, tab, index) => {
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
  check(active.length === expected.peak.activeLines && sum(active, line => line.quantity) === expected.peak.units, `Peak contains ${tableCount * 9} drinks, ${guests} mains and ${tableCount * 2} sharing platters without lost lines`);
  const expectedUnits = expected.peak.quantities;
  for (const [itemId, quantity] of Object.entries(expectedUnits)) assert.equal(sum(active.filter(line => line.itemId === itemId), line => line.quantity), quantity, `Quantity for ${itemId}`);
  const orderedItems = state.tickets.filter(ticket => ticket.kind === 'order').flatMap(ticket => ticket.items).filter(line => line.status !== 'void');
  assert.equal(orderedItems.length, active.length);
  for (const line of active) {
    const matches = orderedItems.filter(item => item.id === line.id);
    assert.equal(matches.length, 1, `Exactly one station item for ${line.id}`);
    for (const property of ['itemId', 'quantity', 'guest', 'modifiers', 'notes', 'station', 'course']) assert.deepEqual(matches[0][property], line[property]);
  }
  check(true, 'Every active line appears exactly once in station tickets with guest, modifiers and notes intact');
  const expectedPeakOre = expected.peak.orderValueOre;
  check(sum(state.tabs, tabGross) === expectedPeakOre, 'Peak order total matches independently calculated menu quantities and prices');
  check(state.tickets.length === expected.peak.stationTickets && state.tickets.filter(ticket => ticket.kind === 'cancel').length === 1, `Peak includes ${expected.peak.stationTickets} station tickets with an explicit cancellation`);
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
    guests, tables: tableCount, virtualDevices: 8, activeLines: active.length, units: sum(active, line => line.quantity),
    drinks: sum(active.filter(line => line.course === 'drink'), line => line.quantity), mains: sum(active.filter(line => line.course === 'main'), line => line.quantity),
    stationTickets: state.tickets.length, kitchenTickets: state.tickets.filter(ticket => ticket.station === 'kitchen').length,
    barTickets: state.tickets.filter(ticket => ticket.station === 'bar').length, printJobs: state.printJobs.length,
    orderValueOre: sum(state.tabs, tabGross),
  };
  console.log('Peak:', JSON.stringify(peak));
  let final = null;
  if (options.mode === 'full') {
    await expectError(() => api(admin, `/print-jobs/${uncertainPrintId}/actions`, { action: 'reprint', reason: 'Måste nekas innan osäkerheten har kontrollerats' }), 'INVALID');
    await api(admin, `/print-jobs/${uncertainPrintId}/actions`, { action: 'resolve', outcome: 'failed', reason: 'Simulerad kontroll: inget papper kom ut' });
    const copy = await api(admin, `/print-jobs/${uncertainPrintId}/actions`, { action: 'reprint', reason: 'Verifierat misslyckad testutskrift' });
    check(copy.reprintOf === uncertainPrintId && copy.text.includes('KOPIA'), 'An uncertain print is checked before a labelled replacement copy');
    await fourServers('desserts-and-coffee', servers, tabs, async (client, tab) => {
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
    const expectedSalesOre = expected.final.salesOre;
    check(sum(beforePayment.tabs, tabGross) === expectedSalesOre, `Final order total independently includes ${tableCount * 2} desserts and ${tableCount * 2} coffees`);
    const finalActive = beforePayment.tabs.flatMap(tab => tab.lines).filter(line => line.status !== 'void');
    check(finalActive.length === expected.final.activeLines, 'Final active row count matches the independent plan');
    for (const [itemId, quantity] of Object.entries(expected.final.quantities)) assert.equal(sum(finalActive.filter(line => line.itemId === itemId), line => line.quantity), quantity, `Final quantity for ${itemId}`);
    const finalStationRows = beforePayment.tickets.filter(ticket => ticket.kind === 'order').flatMap(ticket => ticket.items).filter(line => line.status !== 'void');
    assert.equal(finalStationRows.length, finalActive.length);
    for (const line of finalActive) assert.equal(finalStationRows.filter(row => row.id === line.id).length, 1, `Final station row for ${line.id}`);
    check(true, 'Dessert and coffee rows also appear exactly once in the station queues');
    await fourServers('guest-payments', servers, tabs, async (client, tab, tableIndex) => {
      const booking = expected.bookings[tableIndex];
      let remaining = booking.salesOre;
      for (let installment = 0; installment < 6; installment++) {
        const { amountOre, tipOre } = booking.installments[installment];
        const method = booking.method;
        const payer = method === 'cash' ? admin : client;
        const selection = split === 'guest' && installment < 5 ? { guest: installment + 1 } : {};
        if (tableIndex === 0 && installment === 0) {
          const version = (await api(payer, `/tabs/${tab.id}`)).version;
          const declined = await api(payer, `/tabs/${tab.id}/payments`, { key: key(), version, method, amountOre, tipOre: 0, simulation: 'declined', ...selection });
          assert.equal(declined.status, 'declined');
        }
        const version = (await api(payer, `/tabs/${tab.id}`)).version;
        const input = { key: key(), version, method, amountOre, tipOre, ...selection, simulation: tableIndex === 1 && installment === 0 ? 'unknown' : 'approved', fiscalSimulation: tableIndex === 2 && installment === 0 ? 'unknown' : 'confirmed', ...(method === 'swish' ? { swishVerified: true } : {}), ...(method === 'cash' ? { tenderedOre: amountOre + tipOre + 10000 } : {}) };
        let payment = await api(payer, `/tabs/${tab.id}/payments`, input);
        if (input.simulation === 'unknown') assert.equal(payment.status, 'unknown', 'The simulated lost reply must first be unknown');
        if (payment.status === 'unknown') payment = await api(payer, `/payments/${payment.id}/check`, {});
        assert.equal(payment.status, 'approved');
        const repeated = await api(payer, `/tabs/${tab.id}/payments`, input);
        assert.equal(repeated.id, payment.id, 'Payment retry must retain payment identity');
        assert.equal(payment.amountOre, amountOre); assert.equal(payment.tipOre, tipOre);
        if (method === 'cash') assert.equal(payment.changeOre, 10000, 'Cash change is exactly the deliberate excess tender');
        if (split === 'guest') {
          const originalTab = beforePayment.tabs.find(candidate => candidate.id === tab.id);
          for (const row of payment.allocations) {
            const line = originalTab.lines.find(line => line.id === row.lineId);
            assert(line.guest === installment + 1 || installment === 5 && line.guest === 0, 'Guest payment must not include another guest’s rows');
          }
        }
        remaining -= amountOre;
        await pace();
      }
      assert.equal(remaining, 0);
    });
    state = await snapshot(admin);
    check(state.receipts.filter(receipt => receipt.fiscalStatus === 'unknown').length === 1, 'One fiscal reply is unknown before explicit verification');
    for (const receipt of state.receipts.filter(receipt => receipt.fiscalStatus !== 'confirmed')) await api(admin, `/receipts/${receipt.id}/verify`, {});
    state = await snapshot(admin);
    check(state.payments.filter(payment => payment.status === 'approved').length === guests && state.receipts.length === guests, `${guests} approved split payments produce exactly ${guests} receipts despite retries`);
    check(state.payments.filter(payment => payment.status === 'declined').length === 1 && state.report.unresolved === 0, 'Declined payment and unknown replies are reconciled');
    check(state.report.salesOre === expectedSalesOre && state.report.tipsOre === expected.final.tipsOre && state.tabs.every(tab => tab.status === 'paid'), `All ${tableCount} bills paid to the exact order total with separate tips`);
    check(state.payments.flatMap(payment => payment.allocations).every(row => row.vatOre >= 0 && row.vatOre <= row.grossOre), 'All VAT allocations remain nonnegative and bounded');
    assert.deepEqual(state.report.vat, expected.final.vat, 'VAT by rate must match independent planned row rounding after all splits');
    check(state.report.vatOre === expected.final.vatOre, 'Final VAT equals independent per-row VAT, including split-payment rounding');
    for (const method of expected.final.methods) {
      const actual = state.report.methods.find(row => row.method === method.method);
      assert.equal(actual.salesOre, method.salesOre); assert.equal(actual.tipsOre, method.tipsOre);
      assert.equal(state.payments.filter(row => row.status === 'approved' && row.method === method.method).length, method.payments);
    }
    check(true, 'Card, Swish and cash totals/payment counts match the independent table payment plan');
    for (const line of finalActive) {
      const allocations = state.payments.filter(payment => payment.status === 'approved').flatMap(payment => payment.allocations).filter(row => row.lineId === line.id);
      assert.equal(sum(allocations, row => row.grossOre), line.unitPriceOre * line.quantity, `Exactly paid once in full: ${line.id}`);
    }
    assert.equal(new Set(state.receipts.map(receipt => receipt.paymentId)).size, guests);
    const numbers = state.receipts.map(receipt => receipt.number).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: guests }, (_, index) => index + 1));
    check(true, 'Every active row is paid exactly once in total; receipt payment identities and sequence are unique and unbroken');
    const guestOriginal = state.printJobs.find(job => job.kind === 'guest');
    await api(admin, `/print-jobs/${guestOriginal.id}/actions`, { action: 'print', outcome: 'printed' });
    const guestCopy = await api(admin, `/print-jobs/${guestOriginal.id}/actions`, { action: 'reprint', reason: 'AW-test: gästen behöver sin tillåtna kvittokopia' });
    await api(admin, `/print-jobs/${guestCopy.id}/actions`, { action: 'print', outcome: 'printed' });
    await expectError(() => api(admin, `/print-jobs/${guestOriginal.id}/actions`, { action: 'reprint', reason: 'Andra kopian ska spärras' }), 'RECEIPT_COPY_LIMIT');
    await expectError(() => api(admin, `/print-jobs/${guestCopy.id}/actions`, { action: 'reprint', reason: 'Kopia av kopia ska spärras' }), 'RECEIPT_COPY_LIMIT');
    check(guestCopy.reprintOf === guestOriginal.id && guestCopy.text.startsWith('KOPIA'), 'Only one labelled guest receipt copy is permitted, including copies of copies');
    for (const [direction, amountOre] of [['in', expected.cashDepositOre], ['out', expected.cashWithdrawalOre]]) {
      const input = { key: key(), dayId: day.id, direction, amountOre, reason: `AW-test: kontant${direction === 'in' ? 'insättning' : 'uttag'}` };
      const movement = await api(admin, '/cash-movements', input);
      assert.equal((await api(admin, '/cash-movements', input)).id, movement.id, 'Cash movement retry cannot duplicate a deposit or withdrawal');
    }
    await api(admin, '/drawer/open', { reason: 'AW-test: kontrollerad simulerad lådöppning' });
    state = await snapshot(admin);
    const expectedCashOre = expected.final.expectedCashOre;
    check(state.report.expectedCashOre === expectedCashOre, 'Expected cash independently matches opening float, planned cash sales/tips, deposit and withdrawal');
    check(state.report.training.receiptCopies === 1 && state.report.training.cashDepositsOre === expected.cashDepositOre && state.report.training.cashWithdrawalsOre === expected.cashWithdrawalOre, 'Day counters include one guest copy and exactly one deposit/withdrawal despite retries');
    const closing = await api(admin, `/business-days/${day.id}/close`, { key: key(), countedCashOre: expectedCashOre });
    check(closing.status === 'closed' && closing.report.differenceOre === 0, 'Business day closes with zero cash discrepancy');
    state = await snapshot(admin);
    for (const job of state.printJobs.filter(job => job.status === 'queued')) await api(admin, `/print-jobs/${job.id}/actions`, { action: 'print', outcome: 'printed' });
    state = await snapshot(admin);
    check(state.printJobs.every(job => job.printerId === `printer-${['closing', 'drawer'].includes(job.kind) ? 'guest' : job.kind}`), 'Receipt and closing jobs use the guest printer; food/drink keep their destinations');
    check(state.printJobs.filter(job => job.status === 'failed').length === 1 && state.printJobs.every(job => ['failed', 'printed'].includes(job.status)), 'All print jobs reconciled, including one failed original and its printed copy');
    check(state.tickets.length === expected.final.stationTickets, 'Final station ticket count matches the independent phase plan');
    final = { salesOre: closing.report.salesOre, tipsOre: closing.report.tipsOre, vatOre: closing.report.vatOre, expectedCashOre, cashDifferenceOre: closing.report.differenceOre, methods: closing.report.methods, approvedPayments: guests, declinedPayments: 1, receipts: state.receipts.length, receiptCopies: closing.report.training.receiptCopies, printJobs: state.printJobs.length, printed: state.printJobs.filter(job => job.status === 'printed').length, stationTickets: state.tickets.length, dayClosed: true };
  }
  check((await api(admin, '/journal')).intact, 'Audit chain remains intact');
  check(clients.every(client => !client.streamError) && (await snapshot(admin)).deviceConnections.filter(device => device.connections === 1).length === 8, 'All eight virtual clients remain connected through the completed scenario');
  await api(admin, '/backups', {});
  const durations = timings.map(entry => entry.ms).sort((a, b) => a - b);
  const unexpectedErrors = timings.filter(entry => (entry.status === 0 || entry.status >= 400) && !entry.expectedError);
  check(unexpectedErrors.length === 0, 'Every HTTP error is an explicitly checked fault scenario; no unexpected or transport errors');
  check(phases.every(phase => phase.maxActiveWorkers === 4 && phase.assignments.every(count => count > 0)), 'Every service phase uses all four concurrent serving clients');
  const report = {
    mode: options.mode, guests, tables: tableCount, paceMs, split, baseUrl: base, createdAt: new Date().toISOString(), testRoundId: health.testRoundId,
    simulatedScenario: `${guests} guests at ${tableCount} simulated AW bookings, all opened in one arrival wave before ordering; compressed service, not real waiting/kitchen times`,
    limitations: ['One computer with eight virtual event clients; not eight physical devices or browsers', 'Real HTTP and SQLite writes; payments, fiscal unit and printer results are simulated', 'Four concurrent serving workers; guests do not each have their own HTTP client', 'Pacing is synthetic command/payment delay, not measured guest think time or kitchen time', 'Existing example drink prices retained; not an AW package quote', 'Unknown payment/fiscal replies are adapter scenarios, not a physical network/power failure', 'Measures this run, not maximum capacity, 99% uptime, Wi-Fi reliability or legal approval'],
    splitDescription: split === 'guest' ? 'One payment per guest; guests 1–5 select their own rows, guest 6 also pays common platters' : 'Six equal amount payments per booking, one per guest; last payment receives rounding remainder',
    expectedAmountsFile: 'aw-expected.json', requestTraceFile: 'aw-http.json', peak, final, checks, expectedVersionConflicts: collisions, phases,
    http: { requests: timings.length, concurrentRequestsPeak: maxActiveRequests, eventStreams: streams.length, expectedErrors: timings.filter(entry => entry.expectedError).length, unexpectedErrors: unexpectedErrors.length, medianMs: Math.round(durations[Math.floor(durations.length * .5)]), p95Ms: Math.round(durations[Math.floor(durations.length * .95)]), maxMs: Math.round(durations.at(-1)) },
    virtualDevices: clients.map(client => ({ device: client.deviceCode, changeEvents: client.events })), elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  };
  runReport = report;
} catch (error) {
  process.exitCode = 1;
  console.error('AW simulation failed:', error.stack);
  if (existsSync(root)) writeFileSync(path.join(root, 'aw-failure.json'), JSON.stringify({ at: new Date().toISOString(), message: error.message, stack: error.stack, checks, phases }, null, 2));
} finally {
  for (const stream of streams) stream.controller.abort();
  await Promise.allSettled(streams.map(stream => stream.finished));
  let stopped = false;
  if (started && (options.mode === 'full' || process.exitCode)) {
    try { process.stdout.write(launcher('stop')); stopped = true; }
    catch (error) { process.exitCode = 1; console.error('Unable to verify simulator shutdown:', error.message); }
  }
  if (existsSync(root)) writeFileSync(path.join(root, 'aw-http.json'), JSON.stringify(timings, null, 2));
  if (runReport) {
    runReport.serverStopped = stopped;
    runReport.totalIncludingShutdownSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
    writeFileSync(path.join(root, 'aw-report.json'), JSON.stringify(runReport, null, 2));
    console.log(`AW simulation ${process.exitCode ? 'failed cleanup' : 'passed'}:`, JSON.stringify(runReport));
  }
}
