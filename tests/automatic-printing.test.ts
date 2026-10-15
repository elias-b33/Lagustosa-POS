import { describe, expect, it } from 'vitest';
import type { PrintAdapter } from '../server/adapters';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import { createApp } from '../server/app';
import type { PrintJob, TestPrinterIntegration } from '../shared/types';
import { fixture, key } from './helpers';

function printer(result: 'printed' | 'failed' | 'uncertain' = 'printed') {
  const sent: PrintJob[] = [];
  const config: TestPrinterIntegration = { kind: 'epson-test', model: 'TM-m30II', host: '192.168.1.252', printerId: 'printer-guest', printerIds: ['printer-guest', 'printer-kitchen'], automatic: true };
  const adapter: PrintAdapter = { kind: 'epson-test', integration: () => config, print: async job => { sent.push(job); return result; } };
  return { sent, config, adapter };
}

describe('Persistent automatic print queue', () => {
  it('runs the queue on the server without any browser requesting a print', async () => {
    const p = printer(); const { app, service, store } = await createApp({ database: ':memory:', printerFactory: () => p.adapter });
    try {
      await app.ready();
      const job = service.queuePrint('kitchen', 'server-order', 'ORDER');
      await expect.poll(() => store.get<PrintJob>('print', job.id)?.status).toBe('printed');
      expect(p.sent).toHaveLength(1);
    } finally { await app.close(); }
  });
  it('prints a sent kitchen order and approved receipt once, including repeated requests', async () => {
    const p = printer(); const f = fixture({ printer: p.adapter }); f.open(); const tab = f.tab();
    const waiter = f.actor('waiter', 'SERVERING-1');
    f.command(tab.id, { action: 'add', itemId: 'bread' }, waiter);
    f.command(tab.id, { action: 'add', itemId: 'redwine' }, waiter);
    await f.service.drainAutomaticPrints(); expect(p.sent).toHaveLength(0);
    const send = { action: 'send' as const, key: key(), version: f.service.tab(tab.id).version };
    f.service.updateTab(waiter, tab.id, send); f.service.updateTab(waiter, tab.id, send);
    const pay = { key: key(), version: f.service.tab(tab.id).version, method: 'card' as const, tipOre: 0, simulation: 'approved' as const, fiscalSimulation: 'confirmed' as const };
    await Promise.all([f.service.startPayment(f.admin, tab.id, pay), f.service.startPayment(f.admin, tab.id, pay)]);
    await Promise.all([f.service.drainAutomaticPrints(), f.service.drainAutomaticPrints()]);
    await f.service.drainAutomaticPrints();
    expect(p.sent.map(job => job.kind)).toEqual(['kitchen', 'guest']);
    expect(p.sent.every(job => job.attempts === 1 && job.delivery === 'epson-test')).toBe(true);
    expect(f.store.all<PrintJob>('print').find(job => job.kind === 'bar')).toMatchObject({ status: 'queued', attempts: 0 });
    expect(f.store.journal().filter(entry => entry.action === 'print.started').every(entry => entry.actor === 'system')).toBe(true);
    expect(f.store.verifyJournal()).toBe(true);
  });
  it.each(['declined', 'unknown', 'fiscal-unknown'] as const)('does not print a guest receipt for %s until confirmed', async scenario => {
    const p = printer(); const f = fixture({ printer: p.adapter }); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    await f.pay(tab.id, scenario === 'fiscal-unknown' ? { fiscalSimulation: 'unknown' } : { simulation: scenario });
    await f.service.drainAutomaticPrints();
    expect(p.sent.map(job => job.kind)).toEqual(['kitchen']);
  });
  it('ignores old manual jobs, rolled-back jobs, drawer jobs, closing reports and marked copies', async () => {
    const p = printer(); const f = fixture({ printer: p.adapter });
    p.config.automatic = false;
    const old = f.service.queuePrint('kitchen', 'old', 'OLD');
    p.config.automatic = true;
    expect(() => f.store.atomic(() => { f.service.queuePrint('kitchen', 'rollback', 'ROLLBACK'); throw new Error('rollback'); })).toThrow();
    f.service.queuePrint('drawer', 'drawer', 'DRAWER'); f.service.queuePrint('closing', 'day', 'DAY');
    f.service.queuePrint('kitchen', 'copy', 'KOPIA', old.id);
    f.service.queuePrint('guest', 'unconfirmed', 'No valid receipt');
    await f.service.drainAutomaticPrints(); expect(p.sent).toHaveLength(0);
    expect(f.store.get<PrintJob>('print', old.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });
  it.each(['failed', 'uncertain'] as const)('does not retry a %s result automatically', async outcome => {
    const p = printer(outcome); const f = fixture({ printer: p.adapter });
    const job = f.service.queuePrint('kitchen', 'order', 'ORDER');
    await f.service.drainAutomaticPrints(); await f.service.drainAutomaticPrints();
    expect(p.sent).toHaveLength(1);
    expect(f.store.get<PrintJob>('print', job.id)).toMatchObject({ status: outcome, attempts: 1 });
  });
  it('does not redirect pending automatic jobs to a changed physical address', async () => {
    const p = printer(); const f = fixture({ printer: p.adapter });
    f.service.queuePrint('kitchen', 'order', 'ORDER');
    p.config.host = '192.168.1.253';
    await f.service.drainAutomaticPrints(); expect(p.sent).toHaveLength(0);
  });
  it('atomically excludes a manual double print and waits for the current job on shutdown', async () => {
    const p = printer(); let finish!: (status: 'printed') => void;
    p.adapter.print = async job => { p.sent.push(job); return new Promise(resolve => { finish = resolve; }); };
    const f = fixture({ printer: p.adapter });
    const first = f.service.queuePrint('kitchen', 'a', 'A'); const second = f.service.queuePrint('kitchen', 'b', 'B');
    const pending = f.service.drainAutomaticPrints();
    await expect(f.service.print(f.admin, first.id, 'print', 'printed')).rejects.toThrow('redan hanterats');
    const stopping = f.service.stopAutomaticPrinting();
    finish('printed'); await Promise.all([pending, stopping]);
    expect(p.sent).toHaveLength(1); expect(f.store.get<PrintJob>('print', second.id)?.status).toBe('queued');
  });
  it('resumes only never-attempted automatic jobs after restart and leaves interrupted jobs uncertain', async () => {
    const p = printer(); const f = fixture({ printer: p.adapter }, true);
    const interrupted = f.service.queuePrint('kitchen', 'a', 'A');
    const pending = f.service.queuePrint('kitchen', 'b', 'B');
    f.store.put('print', { ...interrupted, status: 'printing', attempts: 1 });
    f.store.close(); const reopened = new Store(f.filename);
    try {
      const service = new KassaService(reopened, { printer: p.adapter });
      await service.drainAutomaticPrints();
      expect(p.sent.map(job => job.id)).toEqual([pending.id]);
      expect(reopened.get<PrintJob>('print', interrupted.id)?.status).toBe('uncertain');
      await service.stopAutomaticPrinting();
    } finally { reopened.close(); }
  });
});
