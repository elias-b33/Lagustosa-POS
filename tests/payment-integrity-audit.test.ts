import { describe, expect, it } from 'vitest';
import type { PaymentAdapter } from '../server/adapters';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import { calculateTab } from '../shared/money';
import type { Payment, PaymentStatus, PrintJob, Receipt } from '../shared/types';
import { fixture, key } from './helpers';

describe('Beloppsgränser vid ändring av nota', () => {
  it('avvisar ett prisbyte som tillsammans med antalet överstiger notans gräns', () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 2 });
    const before = f.service.tab(tab.id);
    expect(() => f.command(tab.id, { action: 'price', lineId: before.lines[0].id, priceOre: 60000000, reason: 'Testar beloppsgräns' })).toThrow('Notan är för stor');
    expect(f.service.tab(tab.id)).toEqual(before);
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('avvisar minskad rabatt om det nya beloppet blir för stort', () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 100 });
    f.command(tab.id, { action: 'discount', discountBps: 5000, reason: 'Testar rabatt' });
    f.command(tab.id, { action: 'price', lineId: f.service.tab(tab.id).lines[0].id, priceOre: 2000000, reason: 'Testar beloppsgräns' });
    const before = f.service.tab(tab.id);
    expect(calculateTab(before).grossOre).toBe(100000000);
    expect(() => f.command(tab.id, { action: 'discount', discountBps: 0, reason: 'Återställ rabatt' })).toThrow('Notan är för stor');
    expect(f.service.tab(tab.id)).toEqual(before);
  });

  it('sparar inte en fullt rabatterad nota som gör heltalsberäkningen osäker', () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'discount', discountBps: 10000, reason: 'Testar heltalsgräns' });
    for (let index = 0; index < 90; index++) {
      const added = f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 100 });
      f.command(tab.id, { action: 'price', lineId: added.lines.at(-1)!.id, priceOre: 100000000, reason: 'Testar heltalsgräns' });
    }
    const added = f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 100 });
    const before = f.service.tab(tab.id);
    expect(() => f.command(tab.id, { action: 'price', lineId: added.lines.at(-1)!.id, priceOre: 100000000, reason: 'Testar heltalsgräns' })).toThrow('Notan är för stor');
    expect(f.service.tab(tab.id)).toEqual(before);
    expect(calculateTab(f.service.tab(tab.id)).grossOre).toBe(0);
  });
});

describe('Betalningsintegritet under samtidighet och omstart', () => {
  it('debiterar en gång vid dubbeltryck och reserverar beloppet mot en andra enhet', async () => {
    let calls = 0;
    let finish!: (status: PaymentStatus) => void;
    const payment: PaymentAdapter = {
      kind: 'simulator', start: async () => { calls++; return new Promise(resolve => { finish = resolve; }); },
      status: async () => 'unknown', cancel: async () => 'unknown', refund: async () => 'approved',
    };
    const f = fixture({ payment }); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const input = { key: key(), version: f.service.tab(tab.id).version, method: 'card' as const, tipOre: 0, simulation: 'approved' as const, fiscalSimulation: 'confirmed' as const };
    const first = f.service.startPayment(f.admin, tab.id, input);
    const repeated = await f.service.startPayment(f.admin, tab.id, input);
    expect(repeated.status).toBe('pending');
    await expect(f.pay(tab.id, {}, f.actor('waiter', 'SERVERING-1'))).rejects.toThrow('betald eller reserverad');
    expect(calls).toBe(1);
    finish('approved'); await first;
    expect(f.store.all<Payment>('payment')).toHaveLength(1);
    expect(f.store.all<Receipt>('receipt')).toHaveLength(1);
    expect(f.store.all<PrintJob>('print').filter(job => job.kind === 'guest')).toHaveLength(1);
    expect(f.service.tab(tab.id).status).toBe('paid');
  });

  it('håller en osäker retur reserverad över omstart och registrerar kvittot en gång', async () => {
    const f = fixture({}, true); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const sale = await f.pay(tab.id);
    const input = { key: key(), amountOre: sale.amountOre, reason: 'Testar retursvar efter avbrott', simulation: 'unknown' as const, fiscalSimulation: 'confirmed' as const };
    const pendingRefund = await f.service.refund(f.admin, sale.id, input);
    expect(pendingRefund.status).toBe('unknown');
    f.store.close();
    const reopened = new Store(f.filename);
    try {
      const restarted = new KassaService(reopened);
      expect((await restarted.refund(f.admin, sale.id, input)).id).toBe(pendingRefund.id);
      await expect(restarted.refund(f.admin, sale.id, { ...input, key: key() })).rejects.toThrow('återstår att återbetala');
      await Promise.all(Array.from({ length: 8 }, () => restarted.checkPayment(f.admin, pendingRefund.id)));
      expect(reopened.all<Payment>('payment').filter(payment => payment.kind === 'refund')).toHaveLength(1);
      expect(reopened.all<Receipt>('receipt').filter(receipt => receipt.kind === 'refund')).toHaveLength(1);
      expect(restarted.report(restarted.currentDay()!.id).netOre).toBe(0);
      expect(reopened.verifyJournal()).toBe(true);
    } finally { reopened.close(); }
  });

  it('återställer ett godkänt externt testresultat efter avbrott före lokalt svar', async () => {
    const f = fixture({}, true); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const uncertain = await f.pay(tab.id, { simulation: 'unknown' });
    // Emulate the durable state if the process stops before finishPayment runs.
    f.store.put('payment', { ...uncertain, status: 'pending' });
    f.store.close();
    const reopened = new Store(f.filename);
    try {
      const restarted = new KassaService(reopened);
      expect(reopened.get<Payment>('payment', uncertain.id)?.status).toBe('unknown');
      await Promise.all(Array.from({ length: 8 }, () => restarted.checkPayment(f.admin, uncertain.id)));
      expect(reopened.all<Receipt>('receipt')).toHaveLength(1);
      expect(reopened.all<PrintJob>('print').filter(job => job.kind === 'guest')).toHaveLength(1);
      expect(restarted.tab(tab.id).status).toBe('paid');
      expect(reopened.verifyJournal()).toBe(true);
    } finally { reopened.close(); }
  });

  it('bevarar varje öre och momsen genom många delbetalningar och samtidiga delreturer', async () => {
    const f = fixture(); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 3 });
    f.command(tab.id, { action: 'add', itemId: 'redwine', quantity: 3 });
    f.command(tab.id, { action: 'discount', discountBps: 1733, reason: 'Testar ojämn fördelning' });
    f.command(tab.id, { action: 'send' });
    const totals = calculateTab(f.service.tab(tab.id));
    const sales: Payment[] = [];
    for (const amountOre of [1, 4, 101, 777, 2501]) sales.push(await f.pay(tab.id, { amountOre }));
    sales.push(await f.pay(tab.id));
    expect(sales.reduce((sum, payment) => sum + payment.amountOre, 0)).toBe(totals.grossOre);
    expect(sales.flatMap(payment => payment.allocations).reduce((sum, allocation) => sum + allocation.vatOre, 0)).toBe(totals.vatOre);
    await Promise.all(sales.map(async sale => {
      const base = { reason: 'Full retur för varje delbetalning', simulation: 'approved' as const, fiscalSimulation: 'confirmed' as const };
      const part = Math.floor(sale.amountOre / 2);
      const requests = part ? [part, sale.amountOre - part] : [sale.amountOre];
      await Promise.all(requests.map(amountOre => f.service.refund(f.admin, sale.id, { ...base, key: key(), amountOre })));
    }));
    const report = f.service.report(day.id);
    expect(report.netOre).toBe(0);
    expect(report.vatOre).toBe(0);
    expect(report.unresolved).toBe(0);
    expect(f.store.all<Payment>('payment').flatMap(payment => payment.allocations).every(row => row.vatOre >= 0 && row.vatOre <= row.grossOre)).toBe(true);
    expect(f.store.verifyJournal()).toBe(true);
  });
});
