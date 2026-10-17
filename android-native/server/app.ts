import { z } from 'zod';
import { createApp, type AppOptions } from '../../server/app';
import { demand } from '../../server/errors';
import { ticketText } from '../../server/printing';
import type { Payment, Ticket, PrintJob } from '../../shared/types';

const decrementSchema = z.object({
  key: z.string().min(1).max(100), version: z.number().int().min(1),
  lineId: z.string().min(1).max(100), expectedQuantity: z.number().int().min(2).max(100),
  reason: z.string().trim().min(3).max(1000),
}).strict();

/** An opt-in native server. Importing the normal web server never registers these routes. */
export async function createNativeApp(options: AppOptions) {
  const cookie = options.sessionCookieName ?? 'native_demo_session';
  const result = await createApp({ ...options, sessionCookieName: cookie });
  const { app, service, store } = result;
  app.get('/api/v1/native/capabilities', async () => ({ decrement: true, version: 1 }));
  app.post('/api/v1/native/tabs/:id/decrement', async request => {
    const actor = service.session(request.cookies[cookie]);
    service.require(actor, ['admin', 'cashier', 'waiter']);
    demand(actor.device.kind !== 'display', 'En försäljningsenhet krävs.', 403);
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params);
    const input = decrementSchema.parse(request.body);
    // Version and expected quantity belong to the immutable intent. A stale operation is
    // rejected, never rebased silently. A lost response replays the same saved result.
    return service.command(input.key, [id, actor.device.id, input], 'native.tab.decrement', actor, () => {
      service.requireDay();
      const tab = service.tab(id);
      service.version(tab, input.version);
      demand(tab.status === 'open', 'Notan är avslutad. Rättelser görs som returer.', 409, 'TAB_CLOSED');
      demand(!store.all<Payment>('payment').some(payment => payment.tabId === id && payment.kind === 'sale'
        && ['approved', 'pending', 'unknown'].includes(payment.status)), 'Betalning har påbörjats. Raden är låst.', 409, 'TAB_LOCKED');
      const line = tab.lines.find(row => row.id === input.lineId && row.status !== 'void');
      demand(line, 'Raden finns inte.', 409, 'LINE_MISSING');
      demand(line.quantity === input.expectedQuantity, 'Antalet har ändrats. Kontrollera raden igen.', 409, 'QUANTITY_CONFLICT');
      const before = structuredClone(tab);
      if (!['draft', 'held'].includes(line.status)) {
        service.require(actor, ['admin', 'cashier']);
        service.makeTickets(tab, [{ ...structuredClone(line), quantity: 1 }], actor, 'cancel', input.reason);
        for (const ticket of store.all<Ticket>('ticket').filter(t => t.tabId === id && t.kind === 'order')) {
          const item = ticket.items.find(row => row.id === line.id && row.status !== 'void');
          if (!item) continue;
          demand(item.quantity > 1, 'Bongens antal stämmer inte. Be ansvarig kontrollera den.', 409, 'TICKET_QUANTITY_CONFLICT');
          item.quantity--;
          ticket.updatedAt = service.timestamp();
          store.put('ticket', ticket);
          const updatedPrintIds: string[] = [];
          for (const job of store.all<PrintJob>('print').filter(p => p.sourceId === ticket.id && p.status === 'queued' && !p.reprintOf)) {
            store.put('print', { ...job, text: ticketText(ticket) });
            updatedPrintIds.push(job.id);
          }
          service.log(actor, 'native.ticket.quantity_reduced', ticket.id, { lineId: line.id, quantity: item.quantity, removed: 1, reason: input.reason, updatedPrintIds });
        }
      }
      // Keep original prices, modifiers, tax, guest, course and preparation status.
      // Like whole-row cancellations, prepared stock is not automatically returned.
      line.quantity--;
      tab.version++;
      tab.updatedAt = service.timestamp();
      store.put('tab', tab);
      service.log(actor, 'native.tab.decrement', id, { before, tab, lineId: line.id, removed: 1, reason: input.reason });
      return tab;
    });
  });
  return result;
}
