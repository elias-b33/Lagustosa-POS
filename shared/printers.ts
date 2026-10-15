import type { PrinterDestination, PrintJob, TestPrinterIntegration } from './types';

export function connectedPrinterIds(integration?: TestPrinterIntegration): string[] {
  return integration ? integration.printerIds ?? [integration.printerId] : [];
}

export const printerDestinationNames: Record<PrinterDestination, string> = { guest: 'Gästkvitton & dagsavslut', kitchen: 'Köksbongar', bar: 'Barbongar' };
export function printerDestination(kind: PrintJob['kind']): PrinterDestination {
  return kind === 'kitchen' || kind === 'bar' ? kind : 'guest';
}
