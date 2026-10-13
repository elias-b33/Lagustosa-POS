import { describe, expect, it } from 'vitest';
import type { FiscalAdapter, FiscalResult, PaymentAdapter } from '../server/adapters';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import type { Payment, PaymentStatus, PrintJob, Receipt, Ticket } from '../shared/types';
import { calculateTab } from '../shared/money';
import { fixture, key } from './helpers';

describe('Samtidiga betalningar och returer', () => {
  it.each(['declined', 'cancelled'] as const)('bevarar positiva momsandelar när en tidigare betalningsreservation blir %s', async outcome => {
    let finishFirst!: (status: PaymentStatus) => void;
    let calls = 0;
    const payment: PaymentAdapter = {
      kind: 'simulator',
      start: async () => ++calls === 1 ? new Promise(resolve => { finishFirst = resolve; }) : 'approved',
      status: async () => 'unknown', cancel: async () => 'cancelled', refund: async () => 'approved',
    };
    const f = fixture({ payment }); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const totals = calculateTab(f.service.tab(tab.id));
    const pending = f.pay(tab.id, { amountOre: 4 });
    await f.pay(tab.id, { amountOre: 1 }, f.actor('waiter', 'SERVERING-1'));
    finishFirst(outcome); await pending;
    await f.pay(tab.id, { amountOre: 1 });
    await f.pay(tab.id);
    const allocations = f.store.all<Payment>('payment').filter(payment => payment.status === 'approved').flatMap(payment => payment.allocations);
    expect(allocations.every(row => row.vatOre >= 0 && row.vatOre <= row.grossOre)).toBe(true);
    expect(allocations.reduce((sum, row) => sum + row.vatOre, 0)).toBe(totals.vatOre);
    expect(allocations.reduce((sum, row) => sum + row.grossOre, 0)).toBe(totals.grossOre);
    expect(f.service.tab(tab.id).status).toBe('paid');
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('bevarar positiva momsandelar efter en avbruten returreservation och återbetalar exakt ursprungsmomsen', async () => {
    let finishFirst!: (status: PaymentStatus) => void;
    let calls = 0;
    const payment: PaymentAdapter = {
      kind: 'simulator', start: async () => 'approved', status: async () => 'unknown', cancel: async () => 'cancelled',
      refund: async () => ++calls === 1 ? new Promise(resolve => { finishFirst = resolve; }) : 'approved',
    };
    const f = fixture({ payment }); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const sale = await f.pay(tab.id);
    const refund = (amountOre: number) => f.service.refund(f.admin, sale.id, { key: key(), amountOre, reason: 'Felaktigt beställt', simulation: 'approved', fiscalSimulation: 'confirmed' });
    const pending = refund(4);
    await refund(1); finishFirst('declined'); await pending;
    await refund(1); await refund(sale.amountOre - 2);
    const allocations = f.store.all<Payment>('payment').filter(payment => payment.kind === 'refund' && payment.status === 'approved').flatMap(payment => payment.allocations);
    expect(allocations.every(row => row.vatOre >= 0 && row.vatOre <= row.grossOre)).toBe(true);
    expect(allocations.reduce((sum, row) => sum + row.vatOre, 0)).toBe(sale.allocations.reduce((sum, row) => sum + row.vatOre, 0));
    expect(allocations.reduce((sum, row) => sum + row.grossOre, 0)).toBe(sale.amountOre);
    expect(f.service.report(f.service.currentDay()!.id).netOre).toBe(0);
  });
});

describe('Makuleringar i köket', () => {
  it.each(['queued', 'printed'] as const)('markerar den ursprungliga bongraden och bevarar redan utskriven historik (%s)', async printStatus => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' });
    f.command(tab.id, { action: 'add', itemId: 'olives' });
    f.command(tab.id, { action: 'send' });
    const ticket = f.store.all<Ticket>('ticket')[0];
    const bread = ticket.items.find(item => item.itemId === 'bread')!;
    const originalJob = f.store.all<PrintJob>('print')[0];
    if (printStatus === 'printed') await f.service.print(f.admin, originalJob.id, 'print', 'printed');
    const jobSnapshot = f.store.get<PrintJob>('print', originalJob.id)!;
    f.command(tab.id, { action: 'remove', lineId: bread.id, reason: 'Gästen ändrade sig' });
    const updated = f.store.get<Ticket>('ticket', ticket.id)!;
    expect(updated.items.find(item => item.id === bread.id)?.status).toBe('void');
    expect(updated.items.find(item => item.itemId === 'olives')?.status).toBe('sent');
    const jobAfter = f.store.get<PrintJob>('print', originalJob.id)!;
    if (printStatus === 'queued') expect(jobAfter.text).toContain('MAKULERAD — TILLAGA INTE: 1 × Vitlöksbröd');
    else expect(jobAfter).toEqual(jobSnapshot);
    const cancellation = f.store.all<Ticket>('ticket').find(ticket => ticket.kind === 'cancel')!;
    expect(cancellation.items.map(item => item.id)).toEqual([bread.id]);
    expect(f.store.all<PrintJob>('print').find(job => job.sourceId === cancellation.id)?.text).toContain('MAKULERING — STOPPA RÄTT');
    f.service.updateTicket(f.actor('kitchen', 'KOK-TEST'), ticket.id, 'started');
    expect(f.service.tab(tab.id).lines.find(line => line.id === bread.id)?.status).toBe('void');
    expect(f.service.tab(tab.id).lines.find(line => line.itemId === 'olives')?.status).toBe('started');
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('låter inte en helt makulerad originalbong återgå till arbete efter kvitterad makulering', () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const original = f.store.all<Ticket>('ticket')[0];
    f.command(tab.id, { action: 'remove', lineId: original.items[0].id, reason: 'Gästen ändrade sig' });
    const cancellation = f.store.all<Ticket>('ticket').find(ticket => ticket.kind === 'cancel')!;
    for (const status of ['started', 'ready', 'served'] as const) f.service.updateTicket(f.admin, cancellation.id, status);
    expect(() => f.service.updateTicket(f.admin, original.id, 'started')).toThrow('Alla rätter');
    expect(f.store.get<Ticket>('ticket', original.id)?.status).toBe('queued');
    expect(f.service.tab(tab.id).lines[0].status).toBe('void');
  });
});

describe('Avbruten kontrollregistrering', () => {
  it('återhämtar samma testkvitto efter omstart före simulatorns registrering och låter dagen avslutas', async () => {
    const fiscal: FiscalAdapter = { kind: 'simulator', register: async () => new Promise(() => {}), lookup: async () => ({ status: 'unknown', controlCode: null }) };
    const f = fixture({ fiscal }, true); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    void f.pay(tab.id);
    await Promise.resolve(); await Promise.resolve();
    const originalReceipt = f.store.all<Receipt>('receipt')[0];
    expect(originalReceipt.fiscalStatus).toBe('pending');
    expect(f.store.all('fiscal-simulator')).toHaveLength(0);
    f.store.close();
    const reopened = new Store(f.filename);
    try {
      const restarted = new KassaService(reopened);
      expect(reopened.get<Receipt>('receipt', originalReceipt.id)?.fiscalStatus).toBe('unknown');
      await Promise.all([restarted.verifyFiscal(f.admin, originalReceipt.id), restarted.verifyFiscal(f.admin, originalReceipt.id)]);
      await restarted.verifyFiscal(f.admin, originalReceipt.id);
      const recovered = reopened.get<Receipt>('receipt', originalReceipt.id)!;
      expect(recovered.fiscalStatus).toBe('confirmed');
      expect(recovered.payment).toEqual(originalReceipt.payment);
      expect(recovered.tab).toEqual(originalReceipt.tab);
      expect(reopened.all('payment')).toHaveLength(1);
      expect(reopened.all('receipt')).toHaveLength(1);
      expect(reopened.all('fiscal-simulator')).toHaveLength(1);
      expect(reopened.all<PrintJob>('print').filter(job => job.kind === 'guest')).toHaveLength(1);
      expect(restarted.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 }).status).toBe('closed');
      expect(reopened.verifyJournal()).toBe(true);
    } finally { reopened.close(); }
  });

  it('låter inte en statuskontroll skriva över en pågående registrering', async () => {
    let finish!: (result: FiscalResult) => void;
    let lookups = 0;
    const fiscal: FiscalAdapter = {
      kind: 'simulator', register: async () => new Promise(resolve => { finish = resolve; }),
      lookup: async () => { lookups++; return { status: 'unknown', controlCode: null }; },
    };
    const f = fixture({ fiscal }); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const payment = f.pay(tab.id);
    await Promise.resolve(); await Promise.resolve();
    const receipt = f.store.all<Receipt>('receipt')[0];
    expect((await f.service.verifyFiscal(f.admin, receipt.id)).fiscalStatus).toBe('pending');
    expect(lookups).toBe(0);
    finish({ status: 'confirmed', controlCode: 'TEST-RECOVERED' }); await payment;
    expect(f.store.get<Receipt>('receipt', receipt.id)?.fiscalStatus).toBe('confirmed');
    expect(f.store.all<PrintJob>('print').filter(job => job.kind === 'guest')).toHaveLength(1);
  });

  it('försöker inte registrera om ett okänt kvitto när adaptern saknar säker återhämtning', async () => {
    let registrations = 0;
    const fiscal: FiscalAdapter = {
      kind: 'simulator', register: async () => { registrations++; return { status: 'unknown', controlCode: null }; },
      lookup: async () => ({ status: 'unknown', controlCode: null }),
    };
    const f = fixture({ fiscal }); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' }); await f.pay(tab.id);
    const receipt = f.store.all<Receipt>('receipt')[0];
    expect((await f.service.verifyFiscal(f.admin, receipt.id)).fiscalStatus).toBe('unknown');
    expect(registrations).toBe(1);
  });
});
