import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SOFTPAY_SANDBOX_API, SOFTPAY_SANDBOX_TOKEN, type SoftpayTransport } from '../../server/softpay-client';
import type { SoftpaySandboxConfig } from '../../server/softpay-config';

export const softpayTestConfig: SoftpaySandboxConfig = {
  clientId: 'contract-test-client', clientSecret: 'contract-test-secret',
  merchantReference: '00000000-0000-4000-8000-000000000001',
  terminals: ['main', 'serving-1', 'serving-2', 'serving-3', 'serving-4'].map((deviceId, index) => ({ deviceId, appId: `TST000000000${index}`, storeId: 42 })),
};
// Test double for the public v3 contract. These are invented test responses, not captured sandbox payments.
export class SoftpayContractHarness {
  calls: { url: string; method: string; body: unknown; headers: Headers; redirect: RequestRedirect | undefined }[] = [];
  transactions = new Map<string, { action: string; request?: Record<string, unknown>; state: string; result?: Record<string, unknown> }>();
  startReplyState = 'UNCLAIMED';
  abortCompletes = true;
  loseStartReply = false;
  failReads = false;
  fetch: SoftpayTransport = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body && init.headers && new Headers(init.headers).get('Content-Type') === 'application/json' ? JSON.parse(String(init.body)) : init.body;
    this.calls.push({ url, method, body, headers: new Headers(init.headers), redirect: init.redirect });
    if (url === SOFTPAY_SANDBOX_TOKEN) return Response.json({ access_token: 'contract-access-token', token_type: 'Bearer', expires_in: 3600 });
    if (!url.startsWith(SOFTPAY_SANDBOX_API)) throw new Error('Unexpected host');
    if (url === SOFTPAY_SANDBOX_API && method === 'POST') {
      const { action } = z.object({ action: z.enum(['PAYMENT', 'REFUND']) }).strict().parse(body);
      const requestId = randomUUID();
      this.transactions.set(requestId, { action, state: 'CREATED' });
      return Response.json({ requestId, expiresAt: '2027-01-01T00:00:00Z' });
    }
    const [requestId, operation] = url.slice(SOFTPAY_SANDBOX_API.length + 1).split('/');
    const transaction = this.transactions.get(requestId);
    if (!transaction) return Response.json({ message: 'Not found' }, { status: 404 });
    if (operation === 'abort' && method === 'PUT') {
      if (this.abortCompletes && !['COMPLETED', 'DECLINED'].includes(transaction.state)) transaction.state = 'ABORTED';
      return Response.json({ requestId, state: 'ABORTED' });
    }
    if (operation) throw new Error(`Unexpected operation ${operation}`);
    if (method === 'PUT') {
      const parsed = z.object({ appId: z.string().regex(/^[A-Z]{3}[0-9]{10}$/), amount: z.number().int().min(0).max(99999999), currencyCode: z.literal('SEK'), posReferenceNumber: z.string().regex(/^[A-Za-z0-9]{1,32}$/), options: z.object({ tipping: z.object({ indicator: z.literal('OFF') }).strict(), surcharge: z.literal(false), dcc: z.literal(false), suppressAppNotification: z.literal(false) }).strict() }).strict().parse(body);
      if (transaction.request) throw new Error('Repeated start would dispatch the terminal twice');
      transaction.request = parsed;
      transaction.state = 'UNCLAIMED';
      if (this.loseStartReply) throw new Error('Network response lost after server accepted PUT');
      return Response.json({ requestId, state: this.startReplyState });
    }
    if (method === 'GET') {
      if (this.failReads) throw new Error('Simulated connection loss');
      return Response.json({ requestId, state: transaction.state, ...transaction.result });
    }
    throw new Error('Unexpected method');
  };
  complete(requestId: string, overrides: Record<string, unknown> = {}) {
    const entry = this.transactions.get(requestId)!;
    entry.state = 'COMPLETED';
    entry.result = { requestId, state: 'COMPLETED', transactionId: randomUUID(), appId: entry.request!.appId, storeId: 42, amountValue: entry.request!.amount, currencyCode: 'SEK', type: entry.action === 'PAYMENT' ? 'PURCHASE' : 'REFUND', posReferenceNumber: entry.request!.posReferenceNumber, amountTips: 0, amountSurcharge: 0, responseCode: 'APPROVED', ...overrides };
  }
  starts() { return this.calls.filter(call => call.method === 'PUT' && !call.url.endsWith('/abort')); }
}
