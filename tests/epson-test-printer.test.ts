import { afterEach, describe, expect, it, vi } from 'vitest';
import net, { type Socket } from 'node:net';
import { EpsonTestPrintAdapter, isPrivatePrinterAddress } from '../server/epson-test-printer';
import type { PrintJob, PrinterProfile } from '../shared/types';
import { fixture } from './helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const printer: PrinterProfile = { id: 'printer-kitchen', name: 'Kök', destination: 'kitchen', paperWidthMm: 80, active: true };
const job: PrintJob = { id: 'test', kind: 'kitchen', sourceId: 'test', status: 'printing', text: 'Bord 01\nRäkor · sås\nÅÄÖ åäö\n', createdAt: '', reprintOf: null, attempts: 1, printerId: printer.id, printerName: printer.name };

async function fakePrinter(options: { model?: string; reply?: 'ack' | 'none' | 'wrong' | 'close'; automatic?: boolean } = {}) {
  const documents: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let received: Buffer = Buffer.alloc(0);
    let identified = false;
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (!identified && received.length >= 3) {
        expect(received.subarray(0, 3)).toEqual(Buffer.from([0x1d, 0x49, 67]));
        identified = true; received = received.subarray(3);
        socket.write(Buffer.from(`_${options.model ?? 'TM-m30II'}\0`));
      }
      const marker = received.indexOf(Buffer.from([0x1d, 0x28, 0x48, 6, 0, 48, 48]));
      if (marker >= 0 && received.length >= marker + 15) {
        documents.push(received);
        const processId = received.subarray(marker + 7, marker + 11);
        received = Buffer.alloc(0);
        if (options.reply === 'close') socket.destroy();
        else if (options.reply !== 'none') {
          const ack = Buffer.concat([Buffer.from('7"'), options.reply === 'wrong' ? Buffer.from('ZZZZ') : processId, Buffer.from([0])]);
          // Exercise TCP packet fragmentation in the completion response.
          socket.write(ack.subarray(0, 3)); setTimeout(() => { if (!socket.destroyed) socket.write(ack.subarray(3)); }, 5);
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const adapter = new EpsonTestPrintAdapter('192.168.1.252', options.automatic ? ['printer-guest', printer.id] : printer.id, () => net.createConnection({ host: '127.0.0.1', port }), 300, options.automatic);
  return { adapter, documents };
}

describe('Explicit Epson home test printing', () => {
  it('delivers both automatic kitchen and guest documents to the same Epson connection queue', async () => {
    const { adapter, documents } = await fakePrinter({ automatic: true });
    const f = fixture({ printer: adapter }); f.open(); const tab = f.tab();
    f.command(tab.id, { action: 'add', itemId: 'bread' }); f.command(tab.id, { action: 'send' });
    await f.pay(tab.id); await f.service.drainAutomaticPrints();
    expect(documents).toHaveLength(2);
    expect(documents[0].toString('utf8')).toContain('KÖKSBESTÄLLNING');
    expect(documents[1].toString('utf8')).toContain('ÖVNINGSKVITTO');
    expect(f.store.all<PrintJob>('print').every(job => job.status === 'printed' && job.attempts === 1)).toBe(true);
  });
  it('requires a private IP literal and does not permit arbitrary URLs', () => {
    for (const address of ['192.168.1.252', '10.0.0.2', '172.16.0.5']) expect(isPrivatePrinterAddress(address)).toBe(true);
    for (const address of ['127.0.0.1', '169.254.169.254', '8.8.8.8', '192.168.1.255', 'localhost', 'http://192.168.1.2', '192.168.01.2']) expect(() => new EpsonTestPrintAdapter(address, printer.id)).toThrow();
  });
  it('sends UTF-8 text and waits for the matching print completion response', async () => {
    const { adapter, documents } = await fakePrinter();
    expect(await adapter.print(job, printer, 'failed')).toBe('printed');
    expect(documents).toHaveLength(1);
    expect(documents[0].toString('utf8')).toContain('ÖVNING — ELEVA POS');
    expect(documents[0].toString('utf8')).toContain('ÅÄÖ åäö');
  });
  it.each(['none', 'wrong', 'close'] as const)('keeps %s completion uncertain without retrying', async reply => {
    const { adapter, documents } = await fakePrinter({ reply });
    expect(await adapter.print(job, printer, 'printed')).toBe('uncertain');
    expect(documents).toHaveLength(1);
  });
  it('sends no print data to an unexpected device', async () => {
    const { adapter, documents } = await fakePrinter({ model: 'Unknown' });
    expect(await adapter.print(job, printer, 'printed')).toBe('failed');
    expect(documents).toHaveLength(0);
  });
  it('keeps other profiles simulated and never sends a drawer pulse', async () => {
    const connect = vi.fn(() => { throw new Error('Must not connect'); });
    const adapter = new EpsonTestPrintAdapter('192.168.1.252', printer.id, connect);
    expect(await adapter.print(job, { ...printer, id: 'printer-bar' }, 'printed')).toBe('printed');
    expect(await adapter.print({ ...job, kind: 'drawer' }, printer, 'printed')).toBe('failed');
    expect(connect).not.toHaveBeenCalled();
  });
  it('removes control commands from user-entered text', async () => {
    const { adapter, documents } = await fakePrinter();
    expect(await adapter.print({ ...job, text: 'Test\x1bp\x00\x01\x02\nSlut' }, printer, 'printed')).toBe('printed');
    expect(documents[0].includes(Buffer.from([0x1b, 0x70]))).toBe(false);
    expect(documents[0].toString('utf8')).toContain('Test p   \nSlut');
  });
  it('serializes concurrent jobs and persists the physical destination in the journal', async () => {
    const { adapter, documents } = await fakePrinter();
    const f = fixture({ printer: adapter });
    const first = f.service.queuePrint('kitchen', 'a', 'Första');
    const second = f.service.queuePrint('kitchen', 'b', 'Andra');
    const results = await Promise.all([f.service.print(f.admin, first.id, 'print', 'printed'), f.service.print(f.admin, second.id, 'print', 'printed')]);
    expect(results.every(result => result.status === 'printed' && result.delivery === 'epson-test' && result.printerAddress === '192.168.1.252')).toBe(true);
    expect(documents).toHaveLength(2);
    await expect(f.service.print(f.admin, first.id, 'print', 'printed')).rejects.toThrow('redan hanterats');
    expect(f.store.journal().filter(entry => entry.action === 'print.started').every(entry => (entry.details as { delivery: string }).delivery === 'epson-test')).toBe(true);
  });
});
