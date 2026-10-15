import { randomBytes } from 'node:crypto';
import net, { type Socket } from 'node:net';
import type { PrintAdapter } from './adapters';
import type { PrintJob, PrinterProfile, TestPrinterIntegration } from '../shared/types';
import { demand } from './errors';

export function isPrivatePrinterAddress(host: string): boolean {
  if (net.isIP(host) !== 4) return false;
  const [a, b, , d] = host.split('.').map(Number);
  return d !== 0 && d !== 255 && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}

type Result = 'printed' | 'failed' | 'uncertain';
type Connector = (options: { host: string; port: number }) => Socket;

// Epson TM-m30II: FS ( C fn48 selects UTF-8; GS ( H fn48 acknowledges
// completed print data. TCP delivery alone is never treated as a printed job.
// https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/tmm30ii.html
export class EpsonTestPrintAdapter implements PrintAdapter {
  readonly kind = 'epson-test';
  private pending: Promise<unknown> = Promise.resolve();
  private readonly printerIds: string[];
  constructor(private host: string, printerIds: string | string[], private connect: Connector = options => net.createConnection(options), private timeoutMs = 12000, private automatic = false) {
    demand(isPrivatePrinterAddress(host), 'Ange skrivarens privata IPv4-adress.', 500, 'TEST_PRINTER_ADDRESS');
    this.printerIds = typeof printerIds === 'string' ? [printerIds] : [...printerIds];
    demand(this.printerIds.length > 0 && this.printerIds.length <= 3 && new Set(this.printerIds).size === this.printerIds.length && this.printerIds.every(id => /^[a-zA-Z0-9_-]{1,100}$/.test(id)), 'Ange en giltig skrivarprofil.', 500, 'TEST_PRINTER_PROFILE');
  }
  integration(): TestPrinterIntegration { return { kind: 'epson-test', model: 'TM-m30II', host: this.host, printerId: this.printerIds[0], printerIds: [...this.printerIds], automatic: this.automatic }; }
  async print(job: PrintJob, printer: PrinterProfile, outcome: Result): Promise<Result> {
    if (!this.printerIds.includes(printer.id)) return outcome;
    // The home test prints paper only; it never pulses a physical cash drawer.
    if (job.kind === 'drawer') return 'failed';
    const result = this.pending.then(() => this.send(job));
    this.pending = result.catch(() => undefined);
    return result;
  }
  private send(job: PrintJob): Promise<Result> {
    const text = job.text.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ' ');
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) return Promise.resolve('failed');
    const processId = randomBytes(2).toString('hex');
    const acknowledgement = Buffer.from(`7"${processId}\0`, 'ascii');
    const document = Buffer.concat([
      Buffer.from([0x1b, 0x40, 0x1c, 0x28, 0x43, 2, 0, 48, 2]),
      Buffer.from(`ÖVNING — ELEVA POS\n${text}\n\n`, 'utf8'),
      Buffer.from([0x1d, 0x28, 0x48, 6, 0, 48, 48]), Buffer.from(processId, 'ascii'),
      Buffer.from([0x1d, 0x56, 66, 0]),
    ]);
    return new Promise(resolve => {
      let sent = false;
      let settled = false;
      let received: Buffer = Buffer.alloc(0);
      let socket: Socket;
      const finish = (result: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result === 'printed') socket.end(); else socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => finish(sent ? 'uncertain' : 'failed'), this.timeoutMs);
      try { socket = this.connect({ host: this.host, port: 9100 }); }
      catch { clearTimeout(timer); resolve('failed'); return; }
      socket.once('connect', () => socket.write(Buffer.from([0x1d, 0x49, 67])));
      socket.on('data', chunk => {
        received = Buffer.concat([received, chunk]);
        if (!sent) {
          const end = received.indexOf(0);
          if (end < 0) { if (received.length > 1024) finish('failed'); return; }
          if (received.subarray(0, end).toString('ascii') !== '_TM-m30II') { finish('failed'); return; }
          received = Buffer.alloc(0);
          sent = true;
          socket.write(document);
        } else if (received.includes(acknowledgement)) finish('printed');
        else if (received.length > 4096) received = received.subarray(-acknowledgement.length);
      });
      socket.once('error', () => finish(sent ? 'uncertain' : 'failed'));
      socket.once('close', () => finish(sent ? 'uncertain' : 'failed'));
    });
  }
}
