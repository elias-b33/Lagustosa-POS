import { afterEach, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { key } from './helpers';
import type { JournalExportCoverage } from '../server/export';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const context of apps.splice(0)) await context.app.close(); });

it('skyddar rapport- och exporturval och journalför exportören separat från urvalskassan', async () => {
  const f = await createApp({ database: ':memory:' }); apps.push(f);
  const login = async (staffId: string, pin: string, deviceCode = 'LAGUSTOSA-TEST') => {
    const response = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId, pin, deviceCode } });
    expect(response.statusCode).toBe(200);
    return `lagustosa_session=${response.cookies[0].value}`;
  };
  const cookie = await login('admin', '1234');
  const actor = f.service.session(cookie.split('=')[1]);
  const servingCookie = await login('admin', '1234', 'SERVERING-1');
  const serving = f.service.session(servingCookie.split('=')[1]);
  const mainId = f.service.registerFor(actor).id, servingId = f.service.registerFor(serving).id;
  const day = f.service.openDay(actor, { key: key(), floatOre: 0 });
  const bread = f.service.menu().find(item => item.id === 'bread')!;
  f.service.saveMenu(actor, { ...bread, itemKind: 'services' });
  let tab = f.service.createTab(serving, { key: key(), tableId: null, guestCount: 1, serviceMode: 'dine_in' });
  for (const command of [{ action: 'add' as const, itemId: 'bread' }, { action: 'send' as const }]) tab = f.service.updateTab(serving, tab.id, { key: key(), version: tab.version, ...command });
  await f.service.startPayment(serving, tab.id, { key: key(), version: tab.version, method: 'card', tipOre: 0, simulation: 'approved', fiscalSimulation: 'confirmed' });
  const reportUrl = `/api/v1/business-days/${day.id}/register-reports.json?registerId=${servingId}`;
  expect((await f.app.inject(reportUrl)).statusCode).toBe(401);
  const waiterCookie = await login('waiter', '3456', 'SERVERING-2');
  for (const url of [reportUrl, '/api/v1/journal/coverage', '/api/v1/journal.json', '/api/v1/journal.xml']) expect((await f.app.inject({ url, headers: { cookie: waiterCookie } })).statusCode).toBe(403);
  const report = await f.app.inject({ url: reportUrl, headers: { cookie } });
  expect(report.statusCode).toBe(200);
  expect(report.json().reports).toHaveLength(1);
  expect(report.json().reports[0]).toMatchObject({ registerId: servingId, training: { salesOre: bread.priceOre, receiptCounts: { sales: 1 } } });
  expect((await f.app.inject({ url: `/api/v1/business-days/${day.id}/register-reports.json?registerId=missing`, headers: { cookie } })).statusCode).toBe(404);
  expect((await f.app.inject({ url: '/api/v1/journal/coverage?from=2026-02-30', headers: { cookie } })).statusCode).toBe(400);
  expect((await f.app.inject({ url: '/api/v1/journal/coverage?extra=true', headers: { cookie } })).statusCode).toBe(400);
  const coverage = await f.app.inject({ url: `/api/v1/journal/coverage?registerId=${servingId}`, headers: { cookie } });
  expect(coverage.statusCode).toBe(200);
  expect(coverage.json<JournalExportCoverage>()).toMatchObject({ requestedRegisterId: servingId, registerIds: [servingId], canExportXml: true, fullComplianceVerified: false });
  for (let repeat = 0; repeat < 2; repeat++) {
    const xml = await f.app.inject({ url: `/api/v1/journal.xml?registerId=${servingId}`, headers: { cookie } });
    expect(xml.statusCode, xml.body).toBe(200);
    expect(xml.body).toContain(`<k:BeteckningPaDetKassaregisterSomExportAvDataFranJournalminnetSkerIfran>${mainId}</k:BeteckningPaDetKassaregisterSomExportAvDataFranJournalminnetSkerIfran>`);
    expect(f.store.journal().at(-1)?.details).toMatchObject({ registerId: mainId, selectedRegisterId: servingId });
  }
  const json = await f.app.inject({ url: `/api/v1/journal.json?registerId=${servingId}`, headers: { cookie } });
  expect(json.statusCode).toBe(200);
  expect(f.store.journal().at(-1)?.details).toMatchObject({ registerId: mainId, selectedRegisterId: servingId });
  const cashierCookie = await login('cashier', '2345');
  expect((await f.app.inject({ url: '/api/v1/journal.json', headers: { cookie: cashierCookie } })).statusCode).toBe(403);
  expect(f.store.verifyJournal()).toBe(true);
});
