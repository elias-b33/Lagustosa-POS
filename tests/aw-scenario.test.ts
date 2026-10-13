import { describe, expect, it } from 'vitest';
import { exampleMenu } from '../server/seed';
import { restaurantMenu } from '../server/restaurant-menu';
// @ts-expect-error Standalone Node scenario shared with the command-line stress run.
import { dispatchBookings, expectedAw, parseAwOptions } from '../scripts/aw-scenario.mjs';

const menu = [...new Map([...exampleMenu, ...restaurantMenu].map(item => [item.id, item])).values()];
const baseArgs = ['--root', 'new-test-folder', '--port', '4483', '--mode', 'full'];

describe('Parametriserad AW-belastning och oberoende beloppsplan', () => {
  it('behåller 36 gäster/lika delning som standard och väljer 90 utan att ändra antalet enhetsklienter', () => {
    expect(parseAwOptions(baseArgs)).toMatchObject({ guests: 36, paceMs: 0, split: 'equal', port: 4483 });
    expect(parseAwOptions([...baseArgs, '--guests', '90', '--pace-ms', '25', '--split', 'guest'])).toMatchObject({ guests: 90, paceMs: 25, split: 'guest' });
  });

  it.each(['4273', '4373', '4183', '5173'])('skyddar befintlig demo-/utvecklingsport %s', port => {
    expect(() => parseAwOptions(['--root', 'new', '--port', port, '--mode', 'full'])).toThrow('protected');
  });

  it('avvisar ofullständiga grupper, obegränsad väntan och tvetydiga argument', () => {
    for (const guests of ['0', '35', '89', '186', 'NaN']) expect(() => parseAwOptions([...baseArgs, '--guests', guests])).toThrow();
    expect(() => parseAwOptions([...baseArgs, '--pace-ms', '251'])).toThrow();
    expect(() => parseAwOptions([...baseArgs, '--port', '4484'])).toThrow('repeated');
    expect(() => parseAwOptions([...baseArgs, '--split', 'unknown'])).toThrow('Split');
    expect(() => parseAwOptions([...baseArgs, '--guests'])).toThrow('Missing');
  });

  it('återskapar de tidigare 36-gästbeloppen med handräknade mängder och radavrundad moms', () => {
    const plan = expectedAw(menu);
    expect(plan).toMatchObject({ guests: 36, tables: 6, peak: { activeLines: 96, units: 102, orderValueOre: 1446200, stationTickets: 26 }, final: { salesOre: 1607000, tipsOre: 6000, vatOre: 194475, stationTickets: 38, expectedCashOre: 433100 } });
    expect(plan.final.methods).toEqual([
      { method: 'card', salesOre: 1072800, tipsOre: 4000, payments: 24 },
      { method: 'swish', salesOre: 267100, tipsOre: 1000, payments: 6 },
      { method: 'cash', salesOre: 267100, tipsOre: 1000, payments: 6 },
    ]);
  });

  it('räknar 15 bokningar, 90 gästbetalningar och skilda momsunderlag från menyn', () => {
    const plan = expectedAw(menu, 90, 'guest');
    // Each ordinary booking: 2671 kr. One pizza substitution adds 44 kr.
    // VAT per ordinary booking: 32334 ore; the replacement changes it by 471.
    expect(plan.final.salesOre).toBe(15 * 267100 + 4400);
    expect(plan.final.vatOre).toBe(15 * 32334 + 471);
    expect(plan.final.expectedCashOre).toBe(150000 + 2 * 267100 + 2 * 1000 + 20000 - 5000);
    expect(plan.peak).toMatchObject({ activeLines: 240, units: 255, stationTickets: 62, quantities: { cola: 75, prosecco: 30, redwine: 30, antipasto: 30, margherita: 14, diavola: 16 } });
    expect(plan.final).toMatchObject({ activeLines: 300, stationTickets: 92, tipsOre: 15000, quantities: { tiramisu: 30, coffee: 30 } });
    expect(plan.final.vat).toEqual([{ vatBps: 1200, grossOre: 3410900, vatOre: 365481 }, { vatBps: 2500, grossOre: 600000, vatOre: 120000 }]);
    expect(plan.bookings).toHaveLength(15);
    expect(plan.bookings[0].installments).toEqual([
      { guest: 1, amountOre: 46700, tipOre: 1000 }, { guest: 2, amountOre: 42700, tipOre: 0 },
      { guest: 3, amountOre: 32300, tipOre: 0 }, { guest: 4, amountOre: 30000, tipOre: 0 },
      { guest: 5, amountOre: 23800, tipOre: 0 }, { guest: 6, amountOre: 96000, tipOre: 0 },
    ]);
  });

  it('tar med tillvalspriser och låter avrundningen i lika delning sluta exakt på menyns totalsumma', () => {
    const changed = structuredClone(menu);
    changed.find(item => item.id === 'filetto')!.modifiers.flatMap(group => group.options).find(option => option.id === 'pepper')!.priceOre = 101;
    const plan = expectedAw(changed, 90, 'equal');
    expect(plan.final.salesOre).toBe(4010900 + 15 * 101);
    const amounts: number[] = plan.bookings[0].installments.map((payment: { amountOre: number }) => payment.amountOre);
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(plan.bookings[0].salesOre);
    expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1);
    expect(() => expectedAw(changed.filter(item => item.id !== 'filetto'), 90)).toThrow('filetto');
  });

  it('fördelar varje bokning exakt en gång mellan fyra samtidiga serveringsarbetare', async () => {
    const seen: number[] = []; let active = 0; let maximum = 0;
    const metrics = await dispatchBookings(['a', 'b', 'c', 'd'], Array.from({ length: 15 }, (_, index) => index), async (_client: string, booking: number) => {
      active++; maximum = Math.max(maximum, active); seen.push(booking);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
    });
    expect(maximum).toBe(4); expect(metrics.maxActiveWorkers).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, index) => index));
    expect(metrics.assignments.reduce((sum: number, count: number) => sum + count, 0)).toBe(15);
  });

  it('väntar in pågående klienter efter fel innan simulatorns server kan stängas', async () => {
    let completed = 0;
    await expect(dispatchBookings(['a', 'b', 'c', 'd'], Array.from({ length: 15 }, (_, index) => index), async (_client: string, booking: number) => {
      if (booking === 0) throw new Error('Deliberate stop');
      await new Promise(resolve => setTimeout(resolve, 5)); completed++;
    })).rejects.toThrow('Deliberate stop');
    expect(completed).toBe(3);
  });
});
