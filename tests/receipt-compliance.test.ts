import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { receiptText } from '../server/printing';
import { receiptRows, receiptVat } from '../shared/receipts';
import { ReceiptPaper } from '../web/Payments';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import type { MenuItem, PrintJob, Receipt } from '../shared/types';
import { fixture, key } from './helpers';

function mixedPriceTab(f: ReturnType<typeof fixture>) {
  f.open(); const tab = f.tab();
  const updated = f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 2, guest: 2 });
  const freeId = updated.lines[0].id;
  f.command(tab.id, { action: 'price', lineId: freeId, priceOre: 0, reason: 'Bjuder på bröd i träningen' });
  f.command(tab.id, { action: 'add', itemId: 'redwine', guest: 1 });
  f.command(tab.id, { action: 'send' });
  return { tab, freeId };
}

describe('Övningskvitton och kontrollerade kvittokopior', () => {
  it('visar kvantitet, sparad artikeltext och moms per skattesats i text och skärm', async () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 2 });
    f.command(tab.id, { action: 'add', itemId: 'redwine' });
    f.command(tab.id, { action: 'discount', discountBps: 1000, reason: 'Test av rabatt' });
    f.command(tab.id, { action: 'send' }); await f.pay(tab.id);
    const receipt = f.store.all<Receipt>('receipt')[0];
    const menu = f.store.get<MenuItem>('menu', 'bread')!;
    f.service.saveMenu(f.admin, { ...menu, name: 'Ny artikeltext', priceOre: 12345 });
    const text = receiptText(receipt);
    expect(text).toContain('2 × Vitlöksbröd');
    expect(text).not.toContain('Ny artikeltext');
    expect(text).toContain('Rabatt:');
    expect(text).toContain('Moms 12 %:'); expect(text).toContain('Moms 25 %:');
    expect(text).toContain(receipt.company.name); expect(text).toContain(receipt.registerId);
    expect(text).toContain('2026-10-13 22:00:00');
    const vat = receiptVat(receipt);
    expect(vat.reduce((sum, row) => sum + row.grossOre, 0)).toBe(receipt.payment.amountOre);
    expect(vat.every(row => row.netOre + row.vatOre === row.grossOre)).toBe(true);
    const markup = renderToStaticMarkup(createElement(ReceiptPaper, { receipt }));
    expect(markup).toContain('class="receipt-type-marker">ÖVNING');
    expect(markup).toContain('2 × Vitlöksbröd'); expect(markup).toContain('Moms 12 %');
    expect(markup).toContain('Moms 25 %'); expect(markup).toContain('2026-10-13 22:00:00');
    expect(markup).toContain('ingen certifierad enhet');
  });

  it('visar det exakta ekonomiska artikelantalet vid beloppsdelning och delretur', async () => {
    const f = fixture(); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread', quantity: 2 });
    f.command(tab.id, { action: 'send' });
    const payment = await f.pay(tab.id, { amountOre: 100 });
    const receipt = f.store.all<Receipt>('receipt')[0];
    expect(receiptRows(receipt)[0].label).toBe('Delbelopp · 1/79 × Vitlöksbröd');
    expect(receiptRows(receipt)[0].details[0]).toContain('Referens: hela raden');
    const refund = await f.service.refund(f.admin, payment.id, { key: key(), amountOre: 50, reason: 'Testretur', simulation: 'approved', fiscalSimulation: 'confirmed' });
    const returned = f.store.all<Receipt>('receipt').find(item => item.paymentId === refund.id)!;
    expect(receiptRows(returned)[0].label).toBe('Delretur · 1/158 × Vitlöksbröd');
    const text = receiptText(returned);
    expect(text.startsWith('ÖVNING\n')).toBe(true);
    expect(text).toContain('RETUR · ÖVNINGSKVITTO'); expect(text).toContain('Återförd moms:');
    expect(text).toContain(`Originalkvittots id: ${receipt.id}`);
    expect(text).toContain('Orsak: Testretur');
  });

  it('tar med nollprisartiklar exakt en gång vid delbetalning och ignorerar dem vid beloppsretur', async () => {
    const f = fixture(); const { tab, freeId } = mixedPriceTab(f);
    const first = await f.pay(tab.id, { amountOre: 100 });
    expect(first.allocations.find(row => row.lineId === freeId)).toMatchObject({ grossOre: 0, vatOre: 0 });
    const last = await f.pay(tab.id);
    expect(last.allocations.some(row => row.lineId === freeId)).toBe(false);
    expect(f.service.tab(tab.id).status).toBe('paid');
    const receipts = f.store.all<Receipt>('receipt');
    expect(receipts.flatMap(receipt => receipt.payment.allocations).filter(row => row.lineId === freeId)).toHaveLength(1);
    expect(receiptText(receipts[0])).toContain('2 × Vitlöksbröd');
    const refund = await f.service.refund(f.admin, first.id, { key: key(), amountOre: 100, reason: 'Testretur av betalning', simulation: 'approved', fiscalSimulation: 'confirmed' });
    expect(refund.allocations.some(row => row.lineId === freeId)).toBe(false);
    expect(refund.amountOre).toBe(100);
  });

  it('tar med återstående gratisrader när en annan gästs slutbetalning stänger notan', async () => {
    const f = fixture(); const { tab, freeId } = mixedPriceTab(f);
    const first = await f.pay(tab.id, { guest: 1, amountOre: 100 });
    expect(first.allocations.some(row => row.lineId === freeId)).toBe(false);
    const last = await f.pay(tab.id, { guest: 1 });
    expect(last.allocations.find(row => row.lineId === freeId)).toMatchObject({ grossOre: 0, vatOre: 0 });
    expect(f.service.tab(tab.id).status).toBe('paid');
  });

  it.each(['declined', 'cancelled'] as const)('frigör gratisrader från ett %s försök till nästa betalning', async simulation => {
    const f = fixture(); const { tab, freeId } = mixedPriceTab(f);
    const failed = await f.pay(tab.id, { simulation, amountOre: 100 });
    expect(failed.allocations.some(row => row.lineId === freeId)).toBe(true);
    expect(f.store.all('receipt')).toHaveLength(0);
    await f.pay(tab.id);
    expect(f.store.all<Receipt>('receipt').flatMap(receipt => receipt.payment.allocations).filter(row => row.lineId === freeId)).toHaveLength(1);
  });

  it('reserverar gratisrader vid okänt svar och återfinner samma rader efter kontroll', async () => {
    const f = fixture(); const { tab, freeId } = mixedPriceTab(f);
    const first = await f.pay(tab.id, { simulation: 'unknown', amountOre: 100 });
    expect(first.allocations.some(row => row.lineId === freeId)).toBe(true);
    const last = await f.pay(tab.id);
    expect(last.allocations.some(row => row.lineId === freeId)).toBe(false);
    await f.service.checkPayment(f.admin, first.id);
    await f.service.checkPayment(f.admin, first.id);
    expect(f.store.all<Receipt>('receipt').flatMap(receipt => receipt.payment.allocations).filter(row => row.lineId === freeId)).toHaveLength(1);
    expect(f.service.tab(tab.id).status).toBe('paid');
  });

  it('skapar högst en kvittokopia även vid dubbla anrop och spärrar kopia av kopia efter omstart', async () => {
    const f = fixture({}, true); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' }); await f.pay(tab.id);
    const original = f.store.all<PrintJob>('print').find(job => job.kind === 'guest')!;
    await f.service.print(f.admin, original.id, 'print', 'printed');
    const results = await Promise.allSettled([
      f.service.print(f.admin, original.id, 'reprint', undefined, 'Kunden vill ha en kopia'),
      f.service.print(f.admin, original.id, 'reprint', undefined, 'Samtidigt dubbeltryck'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const copy = f.store.all<PrintJob>('print').find(job => job.kind === 'guest' && job.reprintOf)!;
    expect(copy.text.startsWith('KOPIA\n')).toBe(true);
    await f.service.print(f.admin, copy.id, 'print', 'printed');
    expect(f.store.journal().filter(entry => entry.action === 'print.reprint')).toHaveLength(1);
    f.store.close(); const reopened = new Store(f.filename);
    try {
      const service = new KassaService(reopened);
      await expect(service.print(f.admin, original.id, 'reprint', undefined, 'Nytt försök')).rejects.toMatchObject({ code: 'RECEIPT_COPY_LIMIT' });
      await expect(service.print(f.admin, copy.id, 'reprint', undefined, 'Kopia på kopian')).rejects.toMatchObject({ code: 'RECEIPT_COPY_LIMIT' });
      expect(reopened.verifyJournal()).toBe(true);
    } finally { reopened.close(); }
  });

  it('låter inte misslyckad kvittokopia nollställa gränsen men tillåter nya märkta köksbongar', async () => {
    const f = fixture(); f.open(); const receipt = f.service.queuePrint('guest', 'receipt-id', 'ÖVNING\nTestkvitto');
    await f.service.print(f.admin, receipt.id, 'print', 'failed');
    const copy = await f.service.print(f.admin, receipt.id, 'reprint', undefined, 'Originalet misslyckades');
    await f.service.print(f.admin, copy.id, 'print', 'failed');
    await expect(f.service.print(f.admin, receipt.id, 'reprint', undefined, 'Andra försöket')).rejects.toMatchObject({ code: 'RECEIPT_COPY_LIMIT' });
    await expect(f.service.print(f.admin, copy.id, 'reprint', undefined, 'Tredje försöket')).rejects.toMatchObject({ code: 'RECEIPT_COPY_LIMIT' });
    const ticket = f.service.queuePrint('kitchen', 'ticket-id', 'TESTBONG');
    await f.service.print(f.admin, ticket.id, 'print', 'printed');
    const kitchenCopy = await f.service.print(f.admin, ticket.id, 'reprint', undefined, 'Behövs i köket');
    await f.service.print(f.admin, kitchenCopy.id, 'print', 'printed');
    expect((await f.service.print(f.admin, kitchenCopy.id, 'reprint', undefined, 'Ytterligare köksbong')).reprintOf).toBe(kitchenCopy.id);
  });

  it('kräver en öppen dag för att kunna hänföra kvittokopian till dagens rapport', async () => {
    const f = fixture();
    const original = f.service.queuePrint('guest', 'receipt-id', 'ÖVNING\nTestkvitto');
    await f.service.print(f.admin, original.id, 'print', 'printed');
    await expect(f.service.print(f.admin, original.id, 'reprint', undefined, 'Testkopia utan dag')).rejects.toThrow('Öppna en verksamhetsdag');
    const day = f.open();
    await f.service.print(f.admin, original.id, 'reprint', undefined, 'Testkopia under dagen');
    expect(f.store.journal().find(entry => entry.action === 'print.reprint')?.details).toMatchObject({ dayId: day.id });
  });
});
