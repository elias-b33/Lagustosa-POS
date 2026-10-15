import Fastify, { type FastifyRequest, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { Store } from './db';
import { AppError, demand } from './errors';
import { KassaService } from './service';
import type { Actor, BusinessDay, PrinterProfile } from '../shared/types';
import * as schema from './validation';
import { exportCsv, exportXml, exportJournalJson, journalExportCoverage, validJournalDate } from './export';
import type { PaymentAdapter } from './adapters';
import { SoftpaySandboxAdapter } from './softpay-adapter';
import { readSoftpaySandboxConfig } from './softpay-config';
import { EpsonTestPrintAdapter } from './epson-test-printer';

const journalQuery = z.object({ from: z.string().refine(validJournalDate, 'Ogiltigt kalenderdatum').optional(), to: z.string().refine(validJournalDate, 'Ogiltigt kalenderdatum').optional(), registerId: z.string().min(1).max(72).optional() }).strict();

export interface AppOptions {
  database: string; backupDir?: string; webDir?: string;
  https?: { key: Buffer; cert: Buffer }; now?: () => Date; logger?: boolean; development?: boolean;
  sessionCookieName?: string;
  safeTest?: { instanceId: string; launchId: string; sessionId: string };
  paymentFactory?: (store: Store) => PaymentAdapter;
}

export function assertTrainingMode(env: NodeJS.ProcessEnv): void {
  const mode = env.APP_MODE ?? 'training';
  demand(mode === 'training', 'Produktionsläget är spärrat. Riktiga betalnings-, kontrollenhets- och skrivarkopplingar samt tillverkardeklaration krävs först.', 500, 'PRODUCTION_BLOCKED');
  demand(['simulator', 'softpay-sandbox'].includes(env.PAYMENT_ADAPTER ?? 'simulator') && (env.FISCAL_ADAPTER ?? 'simulator') === 'simulator' && ['preview', 'epson-test'].includes(env.PRINT_ADAPTER ?? 'preview'), 'Välj simulator eller Softpay sandbox. Riktiga betalningar och kontrollenhetskopplingar är spärrade.', 500, 'ADAPTER_UNAVAILABLE');
  demand(env.TEST_ENVIRONMENT !== 'safe-test' || (env.PAYMENT_ADAPTER ?? 'simulator') === 'simulator', 'Den säkra övningsmiljön använder bara lokala simulatorer.', 500, 'SAFE_TEST_ADAPTER');
}

export async function createApp(options: AppOptions) {
  assertTrainingMode(process.env);
  const sessionCookieName = options.sessionCookieName ?? 'lagustosa_session';
  demand(/^[a-zA-Z0-9_]{1,100}$/.test(sessionCookieName), 'Ogiltigt namn för inloggningssessionen.', 500);
  demand(!options.safeTest || sessionCookieName !== 'lagustosa_session', 'Testmiljön behöver en separat inloggningssession.', 500);
  const commonOptions = { logger: options.logger ?? false, bodyLimit: 256 * 1024, requestTimeout: 15000, forceCloseConnections: true };
  const app = (options.https ? Fastify({ ...commonOptions, https: options.https }) : Fastify(commonOptions)) as unknown as FastifyInstance;
  const store = new Store(options.database);
  const events = new EventEmitter();
  events.setMaxListeners(100);
  let service: KassaService;
  try {
    const payment = options.paymentFactory?.(store) ?? (process.env.PAYMENT_ADAPTER === 'softpay-sandbox' ? new SoftpaySandboxAdapter(store, readSoftpaySandboxConfig(process.env)) : undefined);
    demand(!payment || payment.kind !== 'live', 'Riktiga betalningar är spärrade i träningsversionen.', 500, 'PRODUCTION_BLOCKED');
    demand(!options.safeTest || !payment || payment.kind === 'simulator', 'Den säkra övningsmiljön använder bara lokala simulatorer.', 500, 'SAFE_TEST_ADAPTER');
    demand(payment?.kind === 'sandbox' || !store.get('meta', 'payment-profile'), 'Den här databasen tillhör Softpay sandbox. Starta med samma koppling.', 500, 'PAYMENT_PROFILE_MISMATCH');
    const printer = process.env.PRINT_ADAPTER === 'epson-test' ? new EpsonTestPrintAdapter(process.env.EPSON_TEST_HOST ?? '', process.env.EPSON_TEST_PROFILE ?? '') : undefined;
    service = new KassaService(store, { backupDir: options.backupDir, now: options.now, notify: () => events.emit('change'), payment, printer });
    demand(!printer || store.get<PrinterProfile>('printer', printer.integration().printerId)?.active, 'Epson-testet kräver en befintlig aktiv skrivarprofil.', 500, 'TEST_PRINTER_PROFILE');
  }
  catch (error) { store.close(); throw error; }
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION', message: 'Kontrollera de ifyllda uppgifterna.', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
    if (error instanceof AppError) return reply.code(error.status).send({ code: error.code, message: error.message, details: error.details });
    app.log.error(error);
    const statusCode = (error as { statusCode?: number }).statusCode;
    reply.code(statusCode && statusCode < 500 ? statusCode : 500).send({ code: 'SERVER_ERROR', message: 'Ändringen kunde inte genomföras. Kontrollera resultatet innan du försöker igen.' });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      const ownOrigin = `${request.protocol}://${request.headers.host}`;
      const developmentOrigin = options.development && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin ?? '');
      demand(!origin || origin === ownOrigin || developmentOrigin, 'Anropet kom från en annan webbplats.', 403, 'ORIGIN_REJECTED');
      demand(request.headers['sec-fetch-site'] !== 'cross-site', 'Anropet kom från en annan webbplats.', 403, 'ORIGIN_REJECTED');
      demand(request.headers['content-type']?.startsWith('application/json'), 'Använd JSON för ändringar.', 415);
    }
  });
  const actor = (request: FastifyRequest): Actor => service.session(request.cookies[sessionCookieName]);
  const paramId = (request: FastifyRequest): string => z.object({ id: z.string().min(1).max(100) }).parse(request.params).id;

  app.get('/api/v1/health', async () => ({ ok: true, mode: 'training', version: '0.1.0', environment: options.safeTest ? 'safe-test' : 'training', instanceId: options.safeTest?.instanceId, launchId: options.safeTest?.launchId, testRoundId: options.safeTest?.sessionId, processId: options.safeTest ? process.pid : undefined, adapters: { payment: service.paymentAdapter.integration?.().provider ?? 'simulator', fiscal: 'simulator', print: service.printAdapter.kind }, testPrinter: service.printAdapter.integration?.() }));
  // Liveness above identifies the process. Readiness also exercises the database;
  // it does not attest to bank connectivity, physical printers or a completed sale.
  app.get('/api/v1/ready', async (_request, reply) => {
    try {
      store.db.prepare('SELECT id FROM entities LIMIT 1').get();
      return { ok: true, mode: 'training', checks: { databaseRead: 'ok' } };
    } catch (error) {
      app.log.error(error, 'Database readiness check failed');
      return reply.code(503).send({ ok: false, mode: 'training', checks: { databaseRead: 'unavailable' } });
    }
  });
  app.get('/api/v1/auth/staff', async () => service.publicStaff().filter(staff => staff.active));
  app.post('/api/v1/auth/login', async (request, reply) => {
    const input = schema.loginSchema.parse(request.body);
    const result = service.login(input.staffId, input.pin, input.deviceCode, request.ip);
    reply.setCookie(sessionCookieName, result.token, { path: '/', httpOnly: true, secure: Boolean(options.https), sameSite: 'strict', maxAge: 16 * 3600 });
    return { actor: result.actor };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    service.logout(request.cookies[sessionCookieName]!, actor(request));
    reply.clearCookie(sessionCookieName, { path: '/' });
    return { ok: true };
  });
  app.get('/api/v1/bootstrap', async request => ({ ...service.bootstrap(actor(request)), printIntegration: service.printAdapter.integration?.(), ...(options.safeTest ? { testEnvironment: 'safe-test' as const, testRoundId: options.safeTest.sessionId } : {}) }));
  app.get('/api/v1/events', async (request, reply) => {
    const identity = actor(request);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    reply.raw.write('retry: 1500\nevent: change\ndata: ready\n\n');
    const change = () => { if (!reply.raw.destroyed) reply.raw.write(`event: change\ndata: ${service.timestamp()}\n\n`); };
    events.on('change', change);
    const deviceConnection = service.connectDevice(identity.device.id);
    const heartbeat = setInterval(() => {
      try { actor(request); deviceConnection.touch(); reply.raw.write(': heartbeat\n\n'); } catch { reply.raw.end(); }
    }, 20000);
    const cleanup = () => { clearInterval(heartbeat); events.off('change', change); deviceConnection.close(); };
    reply.raw.on('close', cleanup);
    request.raw.on('aborted', cleanup);
  });
  app.get('/api/v1/menu', async request => { actor(request); return service.menu(); });
  app.put('/api/v1/menu/:id', async request => {
    const input = schema.menuSchema.parse(request.body);
    demand(input.id === paramId(request), 'Artikelns identifierare stämmer inte.');
    return service.saveMenu(actor(request), input);
  });
  app.get('/api/v1/tables', async request => { actor(request); return store.all('table'); });
  app.put('/api/v1/tables/:id', async request => {
    const input = schema.tableSchema.parse(request.body);
    demand(input.id === paramId(request), 'Bordets identifierare stämmer inte.');
    return service.saveTable(actor(request), input);
  });
  app.post('/api/v1/tabs', async request => service.createTab(actor(request), schema.createTabSchema.parse(request.body)));
  app.get('/api/v1/tabs/:id', async request => { service.require(actor(request), ['admin', 'cashier', 'waiter']); return service.tab(paramId(request)); });
  app.post('/api/v1/tabs/:id/commands', async request => service.updateTab(actor(request), paramId(request), schema.commandSchema.parse(request.body)));
  app.post('/api/v1/tickets/:id/status', async request => service.updateTicket(actor(request), paramId(request), schema.ticketSchema.parse(request.body).status));
  app.post('/api/v1/tabs/:id/payments', async request => service.startPayment(actor(request), paramId(request), schema.paymentSchema.parse(request.body)));
  app.get('/api/v1/payment-attempts/:id', async request => service.paymentAttempt(actor(request), paramId(request)));
  app.get('/api/v1/payments/:id/terminal', async request => service.terminalPaymentInfo(actor(request), paramId(request)));
  app.post('/api/v1/payments/:id/check', async request => { z.object({}).strict().parse(request.body); return service.checkPayment(actor(request), paramId(request)); });
  app.post('/api/v1/payments/:id/cancel', async request => { z.object({}).strict().parse(request.body); return service.checkPayment(actor(request), paramId(request), true); });
  app.post('/api/v1/payments/:id/refunds', async request => service.refund(actor(request), paramId(request), schema.refundSchema.parse(request.body)));
  app.post('/api/v1/receipts/:id/verify', async request => { z.object({}).strict().parse(request.body); return service.verifyFiscal(actor(request), paramId(request)); });
  app.post('/api/v1/print-jobs/:id/actions', async request => {
    const input = schema.printSchema.parse(request.body);
    return service.print(actor(request), paramId(request), input.action, input.outcome, input.reason, input.printerId);
  });
  app.post('/api/v1/drawer/open', async request => service.drawer(actor(request), z.object({ reason: z.string().trim().min(3).max(500) }).strict().parse(request.body).reason));
  app.post('/api/v1/cash-movements', async request => service.moveCash(actor(request), schema.cashMovementSchema.parse(request.body)));
  app.post('/api/v1/business-days', async request => service.openDay(actor(request), schema.openDaySchema.parse(request.body)));
  app.post('/api/v1/business-days/:id/close', async request => {
    const day = service.closeDay(actor(request), paramId(request), schema.closeDaySchema.parse(request.body));
    try { await service.backup('system'); } catch (error) { app.log.error(error); }
    return day;
  });
  app.get('/api/v1/business-days/:id/report', async request => service.takeReport(actor(request), paramId(request)));
  app.get('/api/v1/business-days/:id/register-reports.json', async (request, reply) => {
    const query = z.object({ registerId: z.string().min(1).max(72).optional() }).strict().parse(request.query);
    const report = service.takeReport(actor(request), paramId(request));
    const reports = (report.registers ?? []).filter(entry => !query.registerId || entry.registerId === query.registerId || entry.legacyRegisterId === query.registerId);
    demand(!query.registerId || reports.length > 0, 'Kassan finns inte i denna dagsrapport.', 404);
    reply.type('application/json; charset=utf-8').header('Content-Disposition', 'attachment; filename="lagustosa-register-reports-test.json"');
    return { mode: 'training', dayId: report.dayId, reports };
  });
  app.get('/api/v1/business-days/:id/report.csv', async (request, reply) => {
    service.require(actor(request), ['admin', 'cashier']);
    const day = store.get<BusinessDay>('day', paramId(request));
    demand(day, 'Verksamhetsdagen finns inte.', 404);
    reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="lagustosa-${day.date}-test.csv"`);
    return exportCsv(day, service.takeReport(actor(request), day.id));
  });
  app.get('/api/v1/journal.xml', async (request, reply) => {
    const identity = actor(request);
    service.require(identity, ['admin', 'cashier']);
    const query = journalQuery.parse(request.query);
    const xml = exportXml(store, identity.staff.name, service.timestamp(), query.from, query.to, query.registerId, service.registerFor(identity).id);
    reply.type('application/xml; charset=utf-8').header('Content-Disposition', 'attachment; filename="lagustosa-journal-test.xml"');
    service.log(identity, 'journal.export', 'journal', { from: query.from, to: query.to, selectedRegisterId: query.registerId ?? null });
    return xml;
  });
  app.get('/api/v1/journal.json', async (request, reply) => {
    const identity = actor(request);
    service.require(identity, ['admin']);
    const query = journalQuery.parse(request.query);
    const json = exportJournalJson(store, identity.staff.name, service.timestamp(), query.from, query.to, query.registerId, service.registerFor(identity).id);
    reply.type('application/json; charset=utf-8').header('Content-Disposition', 'attachment; filename="lagustosa-journal-test.json"');
    service.log(identity, 'journal.export_json', 'journal', { from: query.from, to: query.to, selectedRegisterId: query.registerId ?? null });
    return json;
  });
  app.get('/api/v1/journal', async request => { service.require(actor(request), ['admin']); return { intact: store.verifyJournal(), entries: store.journal() }; });
  app.get('/api/v1/journal/coverage', async request => {
    service.require(actor(request), ['admin', 'cashier']);
    const query = journalQuery.parse(request.query);
    return journalExportCoverage(store, service.timestamp(), query.from, query.to, query.registerId);
  });
  app.put('/api/v1/settings', async request => service.saveSettings(actor(request), schema.settingsSchema.parse(request.body)));
  app.put('/api/v1/staff/:id', async request => {
    const input = schema.staffSchema.parse(request.body);
    demand(input.id === paramId(request), 'Personalens identifierare stämmer inte.');
    return service.saveStaff(actor(request), input);
  });
  app.post('/api/v1/devices', async request => service.saveDevice(actor(request), schema.deviceSchema.parse(request.body)));
  app.put('/api/v1/devices/:id', async request => service.saveDevice(actor(request), schema.deviceSchema.parse(request.body), paramId(request)));
  app.get('/api/v1/printers', async request => { service.require(actor(request), ['admin', 'cashier']); return store.all('printer'); });
  app.put('/api/v1/printers/:id', async request => {
    const input = schema.printerSchema.parse(request.body);
    demand(input.id === paramId(request), 'Skrivarens identifierare stämmer inte.');
    return service.savePrinter(actor(request), input);
  });
  app.post('/api/v1/backups', async request => { z.object({}).strict().parse(request.body); const identity = actor(request); service.require(identity, ['admin', 'cashier'], true); const result = await service.backup(identity); return { at: result.at }; });

  if (options.webDir && existsSync(options.webDir)) {
    await app.register(staticFiles, { root: path.resolve(options.webDir), index: ['index.html'], dotfiles: 'deny', list: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ code: 'NOT_FOUND', message: 'API-anropet finns inte.' });
      return reply.code(404).send({ message: 'Sidan finns inte.' });
    });
  }
  app.addHook('onClose', async () => { events.removeAllListeners(); store.close(); });
  return { app, store, service };
}
