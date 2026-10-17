import type { AuditEntry, Receipt } from '../shared/types';
import type { Store } from './db';
import { demand } from './errors';
import { exportJournalJson, type JournalExportCoverage, type JournalScope } from './export';

// A lossless application format, deliberately NOT the Skatteverket namespace.
// In particular a simulated control code cannot be padded into a real code,
// and training copies cannot be labelled as offline fiscal receipts.
const escape = (value: unknown): string => {
  const text = String(value);
  demand(!/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(text), 'Underlaget innehåller tecken som XML inte kan återge. Använd JSON-exporten.', 409, 'XML_TEXT_INVALID');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
};
const element = (name: string, value: unknown) => `<${name}>${escape(value)}</${name}>`;
const json = (name: string, value: unknown) => `<${name} encoding="json">${escape(JSON.stringify(value))}</${name}>`;

export function exportTrainingJournalXml(store: Store, user: string, at: string, from?: string, to?: string, registerId?: string, exportingRegisterId?: string): string {
  // Reuse the verified selection, hash chain and credential guard. No writes.
  const source = exportJournalJson(store, user, at, from, to, registerId, exportingRegisterId);
  const data = JSON.parse(source) as {
    exportedBy: string; exportedAt: string; exportingRegisterId: string; period: unknown;
    scope: { entries: (JournalScope & { entryId: number })[] }; coverage: JournalExportCoverage;
    integrity: unknown; referencedReceipts: { entryId: number; receipt: Receipt }[]; entries: AuditEntry[];
  };
  const originalReceipts = new Map(data.referencedReceipts.map(item => [item.receipt.id, item.receipt]));
  for (const entry of data.entries) {
    const receipt = (entry.details as { receipt?: Receipt }).receipt;
    if (entry.action === 'receipt.create' && receipt) originalReceipts.set(receipt.id, receipt);
  }
  const copies = data.entries.filter(entry => entry.action === 'print.reprint' && (entry.details as { kind?: string }).kind === 'guest').map(entry => {
    const details = entry.details as { receiptId?: string; sourceId?: string; originalId?: string; reason?: string; dayId?: string; registerId?: string; amountOre?: number };
    const receiptId = details.receiptId ?? details.sourceId;
    const original = receiptId ? originalReceipts.get(receiptId) : undefined;
    return `<ReceiptCopy journalEntryId="${entry.id}" originalAvailable="${Boolean(original)}">` +
      element('CopyPrintJobId', entry.entityId) + element('CreatedAt', entry.at) + element('IssuingRegisterId', details.registerId ?? '') +
      element('OriginalReceiptId', receiptId ?? '') + element('OriginalPrintJobId', details.originalId ?? '') +
      element('BusinessDayId', details.dayId ?? '') + element('Reason', details.reason ?? '') +
      (details.amountOre === undefined ? '' : element('AmountOre', details.amountOre)) +
      (original ? element('OriginalRegisterId', original.registerId) + element('OriginalReceiptNumber', original.number) + element('OriginalCreatedAt', original.createdAt) + element('OriginalKind', original.kind) + json('OriginalReceipt', original) : '') +
      '</ReceiptCopy>';
  }).join('\n');
  const scopes = new Map(data.scope.entries.map(scope => [scope.entryId, scope]));
  const entries = data.entries.map(entry => `<Entry id="${entry.id}">` + element('At', entry.at) + element('Actor', entry.actor) + element('Action', entry.action) + element('EntityId', entry.entityId) +
    json('Scope', scopes.get(entry.id)) + json('Details', entry.details) + element('PreviousHash', entry.previousHash) + element('Hash', entry.hash) + '</Entry>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ElevaTrainingJournal xmlns="urn:eleva:training-journal:1" version="1" training="true" skatteverketStandard="false">\n' +
    element('Notice', 'ÖVNINGSUNDERLAG. Innehåller journal och kvittokopior med ursprungliga referenser. Detta är Elevas XML-format, inte standardexport enligt SKVFS 2021:16 eller bevis om regeluppfyllelse.') +
    element('ExportedBy', data.exportedBy) + element('ExportedAt', data.exportedAt) + element('ExportingRegisterId', data.exportingRegisterId) +
    json('Period', data.period) + json('Scope', data.scope) + json('Integrity', data.integrity) + json('StandardExportCoverage', data.coverage) +
    `<ReceiptCopies count="${data.entries.filter(entry => entry.action === 'print.reprint' && (entry.details as { kind?: string }).kind === 'guest').length}">${copies}</ReceiptCopies>\n` +
    json('ReferencedReceipts', data.referencedReceipts) + `<Entries count="${data.entries.length}">${entries}</Entries>\n</ElevaTrainingJournal>`;
}
