import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { Store } from '../server/db';
import { KassaService } from '../server/service';
import type { BusinessDay, Receipt } from '../shared/types';
import { fixture, key } from './helpers';

afterEach(() => vi.unstubAllEnvs());

async function sale(f: ReturnType<typeof fixture>, fiscalSimulation: 'confirmed' | 'unknown' = 'confirmed') {
  f.open(); const tab = f.tab();
  f.command(tab.id, { action: 'add', itemId: 'bread' });
  f.command(tab.id, { action: 'send' });
  await f.pay(tab.id, { fiscalSimulation });
  return f.store.all<Receipt>('receipt')[0];
}

describe('Bevarad kassahistorik och produktionsspärr', () => {
  it('skyddar hela kvittots identitet och innehåll även mot null och borttagna fält', async () => {
    const f = fixture(); const receipt = await sale(f);
    const changes: Record<string, unknown>[] = [
      { payment: null }, { tab: null }, { number: null }, { company: { ...receipt.company, name: 'Annat företag' } },
      { cashier: 'Annan kassör' }, { registerId: 'ANNAN-KASSA' }, { createdAt: '2000-01-01T00:00:00Z' },
      { originalReceiptId: 'annat-kvitto' }, { dayId: 'annan-dag' }, { paymentId: 'annan-betalning' }, { kind: 'refund' },
    ];
    for (const change of changes) expect(() => f.store.put('receipt', { ...receipt, ...change })).toThrow();
    const withoutPayment: Record<string, unknown> = { ...receipt }; delete withoutPayment.payment;
    expect(() => f.store.db.prepare("UPDATE entities SET body=? WHERE kind='receipt' AND id=?").run(JSON.stringify(withoutPayment), receipt.id)).toThrow();
    expect(() => f.store.db.prepare("UPDATE entities SET kind='meta' WHERE kind='receipt' AND id=?").run(receipt.id)).toThrow();
    expect(() => f.store.db.prepare("UPDATE entities SET id='nytt-id' WHERE kind='receipt' AND id=?").run(receipt.id)).toThrow();
    expect(() => f.store.db.prepare("DELETE FROM entities WHERE kind='receipt' AND id=?").run(receipt.id)).toThrow();
    expect(() => f.store.db.prepare("INSERT OR REPLACE INTO entities(kind,id,body) VALUES('receipt',?,?)").run(receipt.id, JSON.stringify({ ...receipt, number: 999 }))).toThrow();
    expect(f.store.get('receipt', receipt.id)).toEqual(receipt);
  });

  it('tillåter återhämtning av okänt kontrollsvar men fryser bekräftade kontrolluppgifter', async () => {
    const f = fixture(); const pending = await sale(f, 'unknown');
    expect(pending.fiscalStatus).toBe('unknown');
    const confirmed = await f.service.verifyFiscal(f.admin, pending.id);
    expect(confirmed.fiscalStatus).toBe('confirmed');
    expect(confirmed.payment).toEqual(pending.payment);
    expect(() => f.store.put('receipt', { ...confirmed, fiscalStatus: 'unknown' })).toThrow();
    expect(() => f.store.put('receipt', { ...confirmed, controlCode: null })).toThrow();
    expect(() => f.store.put('receipt', { ...confirmed, controlCode: 'TEST-ANNAT' })).toThrow();
    expect(() => f.store.put('receipt', confirmed)).not.toThrow();
    expect(f.store.verifyJournal()).toBe(true);
  });

  it('skyddar sparade dagsavslut mot ändring, radering och ersättning', async () => {
    const f = fixture(); await sale(f);
    const closed = f.service.closeDay(f.admin, f.service.currentDay()!.id, { key: key(), countedCashOre: 150000 });
    expect(() => f.store.put('day', { ...closed, status: 'open' })).toThrow();
    expect(() => f.store.put('day', { ...closed, report: { ...closed.report!, salesOre: 1 } })).toThrow();
    expect(() => f.store.db.prepare("DELETE FROM entities WHERE kind='day' AND id=?").run(closed.id)).toThrow();
    expect(() => f.store.db.prepare("INSERT OR REPLACE INTO entities(kind,id,body) VALUES('day',?,?)").run(closed.id, JSON.stringify({ ...closed, report: null }))).toThrow();
    expect(f.store.get<BusinessDay>('day', closed.id)).toEqual(closed);
    expect(f.service.report(closed.id)).toEqual(closed.report);
  });

  it('bevarar godkända betalningar och hanterar rättelse som en separat retur', async () => {
    const f = fixture(); const receipt = await sale(f); const payment = receipt.payment;
    expect(() => f.store.put('payment', { ...payment, amountOre: 1 })).toThrow();
    expect(() => f.store.put('payment', { ...payment, status: 'cancelled' })).toThrow();
    expect(() => f.store.db.prepare("DELETE FROM entities WHERE kind='payment' AND id=?").run(payment.id)).toThrow();
    const refund = await f.service.refund(f.admin, payment.id, { key: key(), amountOre: payment.amountOre, reason: 'Test av separat retur', simulation: 'approved', fiscalSimulation: 'confirmed' });
    expect(refund.status).toBe('approved');
    expect(refund.parentId).toBe(payment.id);
    expect(f.store.get('payment', payment.id)).toEqual(payment);
    expect(f.service.report(payment.dayId).netOre).toBe(0);
  });

  it('installerar samma historikskydd när en tidigare databas öppnas igen', async () => {
    const f = fixture({}, true); const receipt = await sale(f);
    f.store.db.exec('DROP TRIGGER receipt_content_immutable_v2; DROP TRIGGER receipt_confirmed_immutable;');
    f.store.close();
    const reopened = new Store(f.filename);
    try {
      expect(reopened.get('receipt', receipt.id)).toEqual(receipt);
      expect(() => reopened.put('receipt', { ...receipt, company: null })).toThrow();
      expect(() => reopened.put('receipt', { ...receipt, controlCode: null })).toThrow();
    } finally { reopened.close(); }
  });

  it('stoppar uppstart med bruten journal utan att lägga till nya poster', () => {
    const f = fixture(); const count = f.store.journal().length;
    f.store.db.exec('DROP TRIGGER audit_no_update;');
    f.store.db.prepare("UPDATE audit SET actor='ändrad' WHERE id=(SELECT MIN(id) FROM audit)").run();
    expect(f.store.verifyJournal()).toBe(false);
    expect(() => new KassaService(f.store)).toThrow('Journalens kontrollsummor');
    expect(f.store.journal()).toHaveLength(count);
  });

  it('skyddar journalen även mot SQL REPLACE', () => {
    const f = fixture(); const entry = f.store.journal()[0];
    expect(() => f.store.db.prepare('INSERT OR REPLACE INTO audit VALUES(?,?,?,?,?,?,?,?)').run(entry.id, entry.at, 'ändrad', entry.action, entry.entityId, '{}', entry.hash, entry.previousHash)).toThrow();
    expect(f.store.verifyJournal()).toBe(true);
  });

  it.each(['production', 'live', 'TRAINING'])('spärrar %s även via direkt skapande av API-servern', async mode => {
    vi.stubEnv('APP_MODE', mode);
    await expect(createApp({ database: ':memory:' })).rejects.toMatchObject({ code: 'PRODUCTION_BLOCKED' });
  });
  it.each(['PAYMENT_ADAPTER', 'FISCAL_ADAPTER', 'PRINT_ADAPTER'])('spärrar en riktig adapter i %s', async name => {
    vi.stubEnv('APP_MODE', 'training'); vi.stubEnv(name, 'live');
    await expect(createApp({ database: ':memory:' })).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });
});

describe('Inställningar och historik', () => {
  it('journalför uttryckliga rapportuttag men inte löpande avläsning av dagsöversikten', async () => {
    const f = await createApp({ database: ':memory:' });
    try {
      const login = await f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { staffId: 'admin', pin: '1234', deviceCode: 'LAGUSTOSA-TEST' } });
      const headers = { cookie: `lagustosa_session=${login.cookies[0].value}` };
      const actor = f.service.session(login.cookies[0].value);
      const day = f.service.openDay(actor, { key: key(), floatOre: 0 });
      await f.app.inject({ url: '/api/v1/bootstrap', headers });
      expect(f.store.journal().filter(row => row.action === 'report.x')).toHaveLength(0);
      const report = await f.app.inject({ url: `/api/v1/business-days/${day.id}/report`, headers });
      expect(report.statusCode).toBe(200);
      expect(f.store.journal().filter(row => row.action === 'report.x')).toHaveLength(1);
      const csv = await f.app.inject({ url: `/api/v1/business-days/${day.id}/report.csv`, headers });
      expect(csv.statusCode).toBe(200);
      expect(f.store.journal().filter(row => row.action === 'report.x')).toHaveLength(2);
      const closed = f.service.closeDay(actor, day.id, { key: key(), countedCashOre: 0 });
      const saved = await f.app.inject({ url: `/api/v1/business-days/${day.id}/report`, headers });
      expect(saved.json()).toEqual(closed.report);
      expect(f.store.journal().filter(row => row.action === 'report.z_read')).toHaveLength(1);
      expect(f.store.get('day', day.id)).toEqual(closed);
    } finally { await f.app.close(); }
  });

  it('låser företags- och kassaidentitet under en öppen dag och journalför före/efter', () => {
    const f = fixture(); const day = f.open(); const previous = structuredClone(f.service.settings());
    expect(() => f.service.saveSettings(f.admin, { ...previous, registerId: 'ANNAN-TESTKASSA' })).toThrow('Avsluta verksamhetsdagen');
    expect(() => f.service.saveSettings(f.admin, { ...previous, company: { ...previous.company, address: 'Ny adress' } })).toThrow('Avsluta verksamhetsdagen');
    expect(f.service.settings()).toEqual(previous);
    f.service.closeDay(f.admin, day.id, { key: key(), countedCashOre: 150000 });
    const next = { ...previous, registerId: 'NY-TESTKASSA' };
    f.service.saveSettings(f.admin, next);
    const entry = f.store.journal().findLast(row => row.action === 'settings.save')!;
    expect(entry.details).toMatchObject({ previous, settings: next });
    expect(f.store.verifyJournal()).toBe(true);
  });

  it.each(['2026-13-01', '2026-02-30', '2026-00-15'])('avvisar momsdatumet %s med valideringsfel och bevarar reglerna', invalid => {
    const f = fixture(); const previous = structuredClone(f.service.settings()); const changed = structuredClone(previous);
    changed.taxRules[0].from = invalid;
    expect(() => f.service.saveSettings(f.admin, changed)).toThrow('Momsregelns startdatum är ogiltigt');
    expect(f.service.settings()).toEqual(previous);
    expect(f.store.journal().filter(row => row.action === 'settings.save')).toHaveLength(0);
  });
});
