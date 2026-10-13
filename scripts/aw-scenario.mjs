import assert from 'node:assert/strict';

export const awUsage = 'Use --root <fresh directory> --port <port> --mode rush|full [--guests 36|90|other multiple of 6 from 36 to 180] [--pace-ms 0..250] [--split equal|guest]';

export function parseAwOptions(argv) {
  const args = [...argv];
  const options = { guests: 36, paceMs: 0, split: 'equal' };
  const seen = new Set();
  const names = { '--root': 'root', '--port': 'port', '--mode': 'mode', '--guests': 'guests', '--pace-ms': 'paceMs', '--split': 'split' };
  while (args.length) {
    const flag = args.shift();
    assert(Object.hasOwn(names, flag) && !seen.has(flag), `Unknown or repeated argument: ${flag}`);
    seen.add(flag);
    const value = args.shift(); assert(value && !value.startsWith('--'), `Missing ${flag}`);
    options[names[flag]] = ['--port', '--guests', '--pace-ms'].includes(flag) ? Number(value) : value;
  }
  assert(options.root && ['rush', 'full'].includes(options.mode), awUsage);
  assert(Number.isInteger(options.port) && options.port >= 1024 && options.port <= 65535 && ![4173, 4183, 4273, 4373, 5173].includes(options.port), 'Use a separate simulation port; development, E2E and existing demo ports are protected');
  assert(Number.isInteger(options.guests) && options.guests >= 36 && options.guests <= 180 && options.guests % 6 === 0, 'Guests must be a multiple of six from 36 to 180');
  assert(Number.isInteger(options.paceMs) && options.paceMs >= 0 && options.paceMs <= 250, 'Pacing must be 0–250 ms between each serving command/payment');
  assert(['equal', 'guest'].includes(options.split), 'Split must be equal or guest');
  return options;
}

export const mainIds = ['margherita', 'penne', 'diavola', 'sandwalls', 'lasagna', 'filetto'];
export const drinkIds = ['redwine', 'prosecco', 'cola'];
export const methodForTable = index => index % 6 === 5 ? 'cash' : index % 6 === 4 ? 'swish' : 'card';

// This oracle is deliberately independent of the server's order/payment/money
// functions. Inputs are the planned menu quantities and the initial catalogue;
// no returned tab, receipt, payment allocation or day report is used.
export function expectedAw(menuItems, guests = 36, split = 'equal') {
  assert(Number.isInteger(guests) && guests >= 36 && guests <= 180 && guests % 6 === 0);
  assert(['equal', 'guest'].includes(split));
  const tableCount = guests / 6;
  const menu = new Map(menuItems.map(item => [item.id, item]));
  const line = (id, guest, quantity = 1, modifiers = []) => {
    const item = menu.get(id); assert(item, `Expected catalogue item: ${id}`);
    const options = item.modifiers.flatMap(group => group.options);
    const unitOre = item.priceOre + modifiers.reduce((total, id) => {
      const option = options.find(option => option.id === id); assert(option, `Expected modifier ${id}`);
      return total + option.priceOre;
    }, 0);
    const vatBps = item.taxClass === 'food' ? 1200 : 2500;
    const grossOre = quantity * unitOre;
    const vatOre = Math.round(grossOre * vatBps / (10000 + vatBps));
    return { id, guest, quantity, unitOre, grossOre, vatBps, vatOre, modifiers };
  };
  const tables = Array.from({ length: tableCount }, (_, index) => {
    const peakRows = [];
    for (let guest = 1; guest <= 6; guest++) {
      peakRows.push(line(drinkIds[(guest + index) % 3], guest));
      const id = index === 0 && guest === 1 ? 'diavola' : mainIds[guest - 1];
      peakRows.push(line(id, guest, 1, id === 'filetto' ? ['fried-potatoes', 'pepper', 'medium'] : []));
    }
    peakRows.push(line('antipasto', 0, 2, ['medio']));
    for (let guest = 1; guest <= 3; guest++) peakRows.push(line('cola', guest));
    const finalRows = [...peakRows];
    for (const guest of [1, 2]) finalRows.push(line('tiramisu', guest), line('coffee', guest));
    const peakOre = peakRows.reduce((sum, row) => sum + row.grossOre, 0);
    const salesOre = finalRows.reduce((sum, row) => sum + row.grossOre, 0);
    let remaining = salesOre;
    const installments = Array.from({ length: 6 }, (_, guestIndex) => {
      const amountOre = split === 'equal' ? Math.floor(remaining / (6 - guestIndex)) : finalRows.filter(row => row.guest === guestIndex + 1 || guestIndex === 5 && row.guest === 0).reduce((sum, row) => sum + row.grossOre, 0);
      remaining -= amountOre;
      return { guest: guestIndex + 1, amountOre, tipOre: guestIndex === 0 ? 1000 : 0 };
    });
    assert.equal(remaining, 0);
    return { index, method: methodForTable(index), peakOre, salesOre, tipOre: 1000, installments, peakRows, finalRows };
  });
  const allPeak = tables.flatMap(table => table.peakRows);
  const allFinal = tables.flatMap(table => table.finalRows);
  const units = rows => Object.fromEntries([...new Set(rows.map(row => row.id))].sort().map(id => [id, rows.filter(row => row.id === id).reduce((sum, row) => sum + row.quantity, 0)]));
  const vat = [...new Set(allFinal.map(row => row.vatBps))].sort((a, b) => a - b).map(vatBps => ({ vatBps, grossOre: allFinal.filter(row => row.vatBps === vatBps).reduce((sum, row) => sum + row.grossOre, 0), vatOre: allFinal.filter(row => row.vatBps === vatBps).reduce((sum, row) => sum + row.vatOre, 0) }));
  const methods = ['card', 'swish', 'cash'].map(method => ({ method, salesOre: tables.filter(table => table.method === method).reduce((sum, table) => sum + table.salesOre, 0), tipsOre: tables.filter(table => table.method === method).reduce((sum, table) => sum + table.tipOre, 0), payments: tables.filter(table => table.method === method).length * 6 }));
  return {
    guests, tables: tableCount, guestsPerTable: 6, split,
    assumptions: ['Dine-in food VAT 12%, alcohol/standard VAT 25%; verified against the fresh test settings', 'No discounts or price overrides in this scenario', '1000 ore tip on each table’s first payment', 'Guest split: guests 1–5 pay their own rows; guest 6 also pays the shared platters'],
    openingFloatOre: 150000, cashDepositOre: 20000, cashWithdrawalOre: 5000,
    peak: { activeLines: allPeak.length, units: allPeak.reduce((sum, row) => sum + row.quantity, 0), quantities: units(allPeak), orderValueOre: tables.reduce((sum, table) => sum + table.peakOre, 0), stationTickets: tableCount * 4 + 2 },
    final: { activeLines: allFinal.length, quantities: units(allFinal), salesOre: tables.reduce((sum, table) => sum + table.salesOre, 0), tipsOre: tableCount * 1000, vatOre: vat.reduce((sum, row) => sum + row.vatOre, 0), vat, methods, stationTickets: tableCount * 6 + 2, expectedCashOre: 150000 + methods.find(method => method.method === 'cash').salesOre + methods.find(method => method.method === 'cash').tipsOre + 20000 - 5000 },
    bookings: tables,
  };
}

export async function dispatchBookings(clients, bookings, operation) {
  assert.equal(clients.length, 4, 'The scenario requires four serving clients');
  let next = 0; let active = 0; let maxActive = 0;
  let failure;
  const assignments = clients.map(() => 0);
  await Promise.allSettled(clients.map(async (client, clientIndex) => {
    while (!failure && next < bookings.length) {
      const index = next++; active++; maxActive = Math.max(maxActive, active); assignments[clientIndex]++;
      try { await operation(client, bookings[index], index); }
      catch (error) { failure ??= error; throw error; }
      finally { active--; }
    }
  }));
  if (failure) throw failure;
  return { maxActiveWorkers: maxActive, assignments };
}
