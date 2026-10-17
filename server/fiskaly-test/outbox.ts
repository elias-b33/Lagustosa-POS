import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Receipt } from '../../shared/types';
import { FiskalyTestClient, FiskalyTestError } from './client';
import { closingPayload, duplicateIntentionPayload, openingPayload, receiptOperation, transactionIntentionPayload, transactionPayload } from './payload';
import { FISKALY_API_VERSION, FISKALY_TEST_ORIGIN } from './config';

const APPLICATION_ID = 1162626644;
const hash = (data: string) => createHash('sha256').update(data).digest('hex');
type Kind = 'opening' | 'closing' | 'intention' | 'receipt' | 'duplicate' | 'copy-receipt';
export interface TestJob {
  id: string; registerId: string; systemId: string; kind: Kind; key: string; payload: string;
  status: 'prepared' | 'unknown' | 'received-unverified'; recordId: string | null; firstSentAt: number | null;
  remoteState: string | null; remoteMode: string | null; lastIssue: string | null;
}
const responseSchema = z.object({ content: z.object({ id: z.uuid({ version: 'v7' }), type: z.enum(['INTENTION', 'TRANSACTION']),
  system: z.object({ id: z.uuid({ version: 'v7' }) }), state: z.enum(['ACCEPTED', 'REJECTED', 'COMPLETED', 'FAILED']), mode: z.enum(['PROCESSING', 'FINISHED']) }) });

/** Standalone TEST outbox. It must never be opened on the POS database or used
 * to authorize a payment. Even received records await SIGN SE acceptance tests.
 */
export class FiskalyTestOutbox {
  private db: Database.Database;
  private inFlight = new Map<string, Promise<TestJob>>();
  constructor(filename: string, readonly client: FiskalyTestClient, private now = () => Date.now()) {
    this.db = new Database(filename);
    try {
      const marker = this.db.pragma('application_id', { simple: true });
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.length && marker !== APPLICATION_ID) throw new Error('Fiskaly-förberedelsen behöver en egen databas. Befintlig databas har inte ändrats.');
      this.db.pragma(`application_id = ${APPLICATION_ID}`);
      this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
      this.db.exec('CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL);');
      const identity = hash(JSON.stringify({ origin: FISKALY_TEST_ORIGIN, version: FISKALY_API_VERSION, unit: client.config.unitId, bindings: [...client.config.bindings].sort((a, b) => a.registerId.localeCompare(b.registerId)) }));
      const previous = this.db.prepare('SELECT digest FROM identity WHERE id=1').get() as { digest: string } | undefined;
      if (previous && previous.digest !== identity) throw new Error('Organisation eller kassakoppling har ändrats. Återanvänd ursprunglig konfiguration; historiken får inte flyttas mellan kassor.');
      this.db.prepare('INSERT OR IGNORE INTO identity(id,digest) VALUES(1,?)').run(identity);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { if (this.inFlight.size) throw new Error('Vänta tills testanropen har avslutats.'); this.db.close(); }
  get(id: string): TestJob {
    const row = this.db.prepare('SELECT body FROM jobs WHERE id=?').get(id) as { body: string } | undefined;
    if (!row) throw new Error('Testanropet finns inte.');
    return JSON.parse(row.body);
  }
  private save(job: TestJob) { this.db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(job), job.id); return job; }
  private system(registerId: string) {
    const system = this.client.config.bindings.find(binding => binding.registerId === registerId)?.systemId;
    if (!system) throw new Error('Kassan saknar egen fiskaly TEST-identitet.');
    return system;
  }
  private stage(id: string, registerId: string, kind: Kind, body: unknown): TestJob {
    if (!id || id.length > 200) throw new Error('Testanropets lokala referens krävs.');
    const systemId = this.system(registerId), payload = JSON.stringify(body);
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT body FROM jobs WHERE id=?').get(id) as { body: string } | undefined;
      if (row) {
        const previous = JSON.parse(row.body) as TestJob;
        if (previous.payload !== payload || previous.registerId !== registerId || previous.kind !== kind) throw new Error('Samma referens får inte användas för en annan transaktion.');
        return previous;
      }
      const job: TestJob = { id, registerId, systemId, kind, key: randomUUID(), payload, status: 'prepared', recordId: null, firstSentAt: null, remoteState: null, remoteMode: null, lastIssue: null };
      this.db.prepare('INSERT INTO jobs(id,body) VALUES(?,?)').run(id, JSON.stringify(job)); return job;
    }).immediate();
  }
  opening(id: string, registerId: string) { return this.stage(id, registerId, 'opening', openingPayload(this.system(registerId))); }
  closing(id: string, registerId: string) { return this.stage(id, registerId, 'closing', closingPayload(this.system(registerId))); }
  intention(id: string, registerId: string) { return this.stage(id, registerId, 'intention', transactionIntentionPayload(this.system(registerId))); }
  receipt(id: string, receipt: Receipt, intentionId: string, original?: Receipt) {
    const intention = this.get(intentionId);
    if (!['intention', 'duplicate'].includes(intention.kind) || intention.registerId !== receipt.registerId || !intention.recordId || intention.remoteState !== 'COMPLETED' || intention.remoteMode !== 'FINISHED') throw new Error('Kvittot kräver ett avslutat TEST-intentionssvar för samma kassa.');
    const operation = receiptOperation(receipt, original);
    if (intention.kind === 'duplicate') {
      const source = this.get(intention.id.slice('copy:'.length));
      if (id !== `completion:${intention.id}` || JSON.stringify(operation) !== JSON.stringify(JSON.parse(source.payload).content.operation)) throw new Error('Kopian måste bevara det ursprungliga TEST-kvittot och sin fasta referens.');
    }
    return this.stage(id, receipt.registerId, intention.kind === 'duplicate' ? 'copy-receipt' : 'receipt', transactionPayload(intention.recordId, operation));
  }
  duplicate(id: string, registerId: string, originalJobId: string, reason: string) {
    const original = this.get(originalJobId);
    if (original.kind !== 'receipt' || original.registerId !== registerId || !original.recordId || original.remoteState !== 'COMPLETED' || original.remoteMode !== 'FINISHED') throw new Error('Kopian kräver en färdig TEST-kvittoreferens för samma kassa.');
    // Stable local id per original prevents issuing a second logical copy.
    if (id !== `copy:${originalJobId}`) throw new Error('Kopian ska använda originalets fasta kopiereferens.');
    return this.stage(id, registerId, 'duplicate', duplicateIntentionPayload(this.system(registerId), original.recordId, reason));
  }
  private received(job: TestJob, value: unknown): TestJob {
    const parsed = responseSchema.safeParse(value);
    const expectedType = ['receipt', 'copy-receipt'].includes(job.kind) ? 'TRANSACTION' : 'INTENTION';
    if (!parsed.success || parsed.data.content.system.id !== job.systemId || parsed.data.content.type !== expectedType || job.recordId && job.recordId !== parsed.data.content.id) throw new FiskalyTestError('RESPONSE');
    const content = parsed.data.content;
    return this.save({ ...job, status: 'received-unverified', recordId: content.id, remoteState: content.state, remoteMode: content.mode, lastIssue: null });
  }
  async send(id: string): Promise<TestJob> {
    if (this.inFlight.has(id)) return this.inFlight.get(id)!;
    const pending = this.dispatch(id); this.inFlight.set(id, pending);
    try { return await pending; } finally { this.inFlight.delete(id); }
  }
  private async dispatch(id: string): Promise<TestJob> {
    let job = this.get(id);
    if (job.recordId) return job; // Follow up by GET; never recreate a known record.
    // The published default idempotency retention is 24h. Stop before expiry,
    // also on a backwards clock; never infer absence from silence or an old key.
    if (job.firstSentAt !== null && (this.now() < job.firstSentAt || this.now() - job.firstSentAt >= 23 * 3600_000)) {
      this.save({ ...job, status: 'unknown', lastIssue: 'RECONCILIATION_REQUIRED' });
      throw new Error('Osäkert testanrop ligger utanför säkert omsändningsfönster. Leverantörsavstämning krävs; ingen ny registrering skickades.');
    }
    job = this.save({ ...job, status: 'unknown', firstSentAt: job.firstSentAt ?? this.now(), lastIssue: null });
    try { return this.received(job, await this.client.createRecord(JSON.parse(job.payload), job.key)); }
    catch (error) {
      this.save({ ...job, status: 'unknown', lastIssue: error instanceof FiskalyTestError ? error.code : 'UNKNOWN' });
      throw error;
    }
  }
  async lookup(id: string) {
    const job = this.get(id);
    if (!job.recordId) return job;
    // A failed/404 lookup never clears recordId or creates another registration.
    return this.received(job, await this.client.getRecord(job.recordId));
  }
}
