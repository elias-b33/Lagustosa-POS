// Development-only server: never bundled into dist/server. The injected transport makes no network calls.
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createApp } from '../../server/app';
import { SoftpaySandboxAdapter } from '../../server/softpay-adapter';
import { SoftpaySandboxClient } from '../../server/softpay-client';
import { SoftpayContractHarness, softpayTestConfig } from './softpay-cloud';
import { demand } from '../../server/errors';
import type { Bootstrap, Payment } from '../../shared/types';

process.env.APP_MODE = 'training';
process.env.PAYMENT_ADAPTER = 'simulator';
process.env.FISCAL_ADAPTER = 'simulator';
process.env.PRINT_ADAPTER = 'preview';
delete process.env.TEST_ENVIRONMENT;
const dataDir = mkdtempSync(path.join(tmpdir(), 'eleva-payment-contract-'));
const cloud = new SoftpayContractHarness();
const scope = randomUUID();
const context = await createApp({ database: path.join(dataDir, 'training.sqlite'), backupDir: path.join(dataDir, 'backups'), webDir: path.resolve('dist/web'), sessionCookieName: 'eleva_contract_test', paymentFactory: store => new SoftpaySandboxAdapter(store, softpayTestConfig, new SoftpaySandboxClient(softpayTestConfig, cloud.fetch)) });
context.app.addHook('onSend', async (request, _reply, payload) => {
  if (request.url === '/api/v1/bootstrap' && typeof payload === 'string') {
    const data: Bootstrap = JSON.parse(payload);
    if (data.paymentIntegration) { data.paymentIntegration.contractTest = true; data.testRoundId = scope; }
    return JSON.stringify(data);
  }
  return payload;
});
context.app.post('/api/v1/contract-test/transaction', async request => {
  const actor = context.service.session(request.cookies.eleva_contract_test);
  context.service.require(actor, ['admin']);
  const input = z.object({ paymentId: z.uuid(), action: z.enum(['approve', 'decline', 'approve-lose-response', 'restore-connection']) }).strict().parse(request.body);
  const payment = context.store.get<Payment>('payment', input.paymentId);
  demand(payment, 'Testbetalningen saknas.', 404);
  const requestId = context.service.terminalPaymentInfo(actor, input.paymentId)?.requestId;
  demand(requestId, 'Testbetalningen har ingen terminalreferens.', 409);
  if (input.action === 'restore-connection') cloud.failReads = false;
  else if (input.action === 'decline') cloud.transactions.get(requestId)!.state = 'DECLINED';
  else {
    cloud.complete(requestId);
    cloud.failReads = input.action === 'approve-lose-response';
  }
  return { ok: true, mode: 'local-contract-test' };
});
context.app.get('/api/v1/contract-test/stats', async request => {
  context.service.require(context.service.session(request.cookies.eleva_contract_test), ['admin']);
  return { starts: cloud.starts().length, requests: cloud.transactions.size, externalNetworkCalls: 0 };
});
const port = Number(process.env.SOFTPAY_CONTRACT_PORT || 4793);
demand(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Ogiltig testport.');
await context.app.listen({ host: '127.0.0.1', port });
console.log(`Lokalt integrationstest — ingen anslutning till Softpay. http://127.0.0.1:${port}/\nTestdata: ${dataDir}`);
const shutdown = async () => { await context.app.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
