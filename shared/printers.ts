import type { PrinterDestination, PrintJob } from './types';

export const printerDestinationNames: Record<PrinterDestination, string> = { guest: 'Gästkvitton & dagsavslut', kitchen: 'Köksbongar', bar: 'Barbongar' };
export function printerDestination(kind: PrintJob['kind']): PrinterDestination {
  return kind === 'kitchen' || kind === 'bar' ? kind : 'guest';
}
