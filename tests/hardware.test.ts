import { describe, expect, it } from 'vitest';
import { fixture, key } from './helpers';
import type { PrinterProfile, PrintJob } from '../shared/types';
import type { PrintAdapter } from '../server/adapters';
import { Store } from '../server/db';
import { KassaService } from '../server/service';

describe('Restaurangens åtta skärmar och tre skrivare', () => {
  it('förbereder en huvudkassa, fyra handterminaler, tre orderskärmar och tre skilda skrivarrutter', () => {
    const f = fixture(); const data = f.service.bootstrap(f.admin);
    expect(data.devices.filter(device => device.kind === 'main')).toHaveLength(1);
    expect(data.devices.filter(device => device.kind === 'serving')).toHaveLength(4);
    expect(data.devices.filter(device => device.kind === 'display')).toHaveLength(3);
    expect(data.printers).toHaveLength(3);
    expect(data.printers.map(printer => printer.destination).sort()).toEqual(['bar', 'guest', 'kitchen']);
    expect(data.deviceConnections.every(device => device.connections === 0)).toBe(true);
  });

  it('skickar köksbong, barbong, kvitto, dagsavslut och kassalåda till rätt profil', async () => {
    const sent: { kind: PrintJob['kind']; printerId: string }[] = [];
    const printer: PrintAdapter = { kind: 'preview', print: async (job, target, outcome) => { sent.push({ kind: job.kind, printerId: target.id }); return outcome; } };
    const f = fixture({ printer }); const day = f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'add', itemId: 'redwine' }); f.command(tab.id, { action: 'send' });
    await f.pay(tab.id); f.service.drawer(f.admin, 'Övning av kassalåda'); f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 });
    const jobs = f.store.all<PrintJob>('print');
    for (const job of jobs) await f.service.print(f.admin, job.id, 'print', 'printed');
    expect(sent).toEqual(expect.arrayContaining([
      { kind: 'kitchen', printerId: 'printer-kitchen' }, { kind: 'bar', printerId: 'printer-bar' },
      { kind: 'guest', printerId: 'printer-guest' }, { kind: 'closing', printerId: 'printer-guest' }, { kind: 'drawer', printerId: 'printer-guest' },
    ]));
    expect(sent).toHaveLength(10);
    expect(sent.filter(job => job.kind === 'closing')).toHaveLength(6);
    const closingJobs = jobs.filter(job => job.kind === 'closing');
    for (const register of f.service.bootstrap(f.admin).registers!) expect(closingJobs.some(job => job.text.includes(register.id))).toBe(true);
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('behåller köade jobb på avstängd skrivare och kräver ett journalfört byte till rätt station', async () => {
    const f = fixture(); const job = f.service.queuePrint('kitchen', 'test-order', 'TESTBONG');
    const original = f.store.get<PrinterProfile>('printer', 'printer-kitchen')!;
    f.service.savePrinter(f.admin, { ...original, active: false });
    const replacement: PrinterProfile = { ...original, id: key(), name: 'Ny köksskrivare', active: true };
    f.service.savePrinter(f.admin, replacement);
    expect(f.store.get<PrintJob>('print', job.id)?.printerId).toBe(original.id);
    await expect(f.service.print(f.admin, job.id, 'print', 'printed')).rejects.toThrow('aktiv skrivare');
    expect(f.store.get<PrintJob>('print', job.id)?.attempts).toBe(0);
    await expect(f.service.print(f.admin, job.id, 'route', undefined, 'Byte', 'printer-bar')).rejects.toThrow('rätt typ');
    await expect(f.service.print(f.admin, job.id, 'route', undefined, '', replacement.id)).rejects.toThrow('orsak');
    await expect(f.service.print(f.actor('waiter', 'SERVERING-1'), job.id, 'route', undefined, 'Skrivaren byts', replacement.id)).rejects.toThrow('behörighet');
    const routed = await f.service.print(f.admin, job.id, 'route', undefined, 'Tidigare skrivaren ur bruk', replacement.id);
    expect(routed).toMatchObject({ id: job.id, printerId: replacement.id, status: 'queued', text: 'TESTBONG', attempts: 0 });
    expect((await f.service.print(f.admin, job.id, 'print', 'printed')).status).toBe('printed');
    expect(f.store.all('print')).toHaveLength(1);
    expect(f.store.journal().find(entry => entry.action === 'print.routed')?.details).toMatchObject({ previousPrinterId: original.id, printerId: replacement.id });
  });

  it('kräver kontroll av osäker utskrift innan ett byte eller en märkt kopia', async () => {
    const f = fixture(); const job = f.service.queuePrint('bar', 'test-order', 'BARBONG');
    await f.service.print(f.admin, job.id, 'print', 'uncertain');
    await expect(f.service.print(f.admin, job.id, 'route', undefined, 'Byte', 'printer-bar')).rejects.toThrow('väntande utskrift');
    await expect(f.service.print(f.admin, job.id, 'reprint', undefined, 'Byte')).rejects.toThrow('osäkra');
    await f.service.print(f.admin, job.id, 'resolve', 'failed', 'Inget papper kom ut');
    const copy = await f.service.print(f.admin, job.id, 'reprint', undefined, 'Bekräftad kopia');
    expect(copy.printerId).toBe(job.printerId); expect(copy.reprintOf).toBe(job.id); expect(copy.text).toContain('KOPIA');
  });

  it('tillåter inte dubbla aktiva rutter eller ändrad profil under en pågående utskrift', async () => {
    let finish!: (status: 'printed') => void;
    const printer: PrintAdapter = { kind: 'preview', print: async () => new Promise(resolve => { finish = resolve; }) };
    const f = fixture({ printer }); const profile = f.store.get<PrinterProfile>('printer', 'printer-guest')!;
    expect(() => f.service.savePrinter(f.admin, { ...profile, id: key() })).toThrow('redan en aktiv skrivare');
    const job = f.service.queuePrint('guest', 'test-receipt', 'KVITTO');
    const pending = f.service.print(f.admin, job.id, 'print', 'printed');
    expect(() => f.service.savePrinter(f.admin, { ...profile, paperWidthMm: 58 })).toThrow('pågående utskriften');
    finish('printed'); await pending;
    expect(f.service.savePrinter(f.admin, { ...profile, paperWidthMm: 58 }).paperWidthMm).toBe(58);
  });

  it('uppgraderar äldre köer utan att radera order eller gissa historiska skrivarval', () => {
    const f = fixture({}, true); f.open(); const tab = f.tab(); f.command(tab.id, { action: 'add', itemId: 'bread' });
    const queued = f.service.queuePrint('kitchen', tab.id, 'ÄLDRE KÖ');
    const { printerId: _id, printerName: _name, ...legacy } = queued;
    f.store.put('print', legacy);
    f.store.put('print', { ...legacy, id: key(), status: 'printed' as const });
    f.store.db.prepare("DELETE FROM entities WHERE kind='printer' OR (kind='meta' AND id='printers-seeded')").run();
    f.store.close(); const reopened = new Store(f.filename);
    try {
      const restarted = new KassaService(reopened);
      expect(restarted.tab(tab.id).lines).toHaveLength(1);
      expect(reopened.all('printer')).toHaveLength(3);
      expect(reopened.get<PrintJob>('print', queued.id)?.printerId).toBe('printer-kitchen');
      expect(reopened.all<PrintJob>('print').find(job => job.status === 'printed')?.printerId).toBeNull();
      expect(reopened.verifyJournal()).toBe(true);
    } finally { reopened.close(); }
  });

  it('räknar öppna skärmflikar och stänger samma anslutning högst en gång', () => {
    const f = fixture(); const first = f.service.connectDevice('main'); const second = f.service.connectDevice('main');
    expect(f.service.deviceConnections().find(device => device.deviceId === 'main')?.connections).toBe(2);
    first.close(); first.close();
    expect(f.service.deviceConnections().find(device => device.deviceId === 'main')?.connections).toBe(1);
    second.touch(); second.close();
    expect(f.service.deviceConnections().find(device => device.deviceId === 'main')).toMatchObject({ connections: 0, lastSeenAt: '2026-10-13T20:00:00.000Z' });
  });

  it('låter en administratör på en orderskärm hantera stationen utan betalnings- eller returåtgärder', async () => {
    const f = fixture(); f.open(); const tab = f.tab(); f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    const display = f.actor('admin', 'KOK-TEST');
    expect(f.service.bootstrap(display)).toMatchObject({ tabs: [], payments: [], receipts: [], printers: [] });
    await expect(f.pay(tab.id, {}, display)).rejects.toThrow('kassa eller serveringsenhet');
    const sale = await f.pay(tab.id);
    await expect(f.service.refund(display, sale.id, { key: key(), amountOre: sale.amountOre, reason: 'Test', simulation: 'approved', fiscalSimulation: 'confirmed' })).rejects.toThrow('kassa eller serveringsenhet');
    await expect(f.service.checkPayment(display, sale.id)).rejects.toThrow('kassa eller serveringsenhet');
    expect(f.store.all('payment')).toHaveLength(1);
  });
});
