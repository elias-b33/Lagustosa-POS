export type Role = 'admin' | 'cashier' | 'waiter' | 'kitchen' | 'bar';
export type Station = 'kitchen' | 'bar';
export type ServiceMode = 'dine_in' | 'takeaway';
export type Course = 'starter' | 'main' | 'dessert' | 'drink';
export type TaxClass = 'food' | 'alcohol' | 'standard';
export type LineStatus = 'draft' | 'held' | 'sent' | 'started' | 'ready' | 'served' | 'void';
export type PaymentMethod = 'card' | 'swish' | 'cash';
export type PaymentStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'unknown';
export type Simulation = 'approved' | 'declined' | 'cancelled' | 'unknown';
export interface Staff { id: string; name: string; role: Role; active: boolean }
export interface Device { id: string; name: string; kind: 'main' | 'serving' | 'display'; station: Station | null; active: boolean }
export interface Actor { staff: Staff; device: Device }
export interface ModifierOption { id: string; name: string; priceOre: number }
export interface ModifierGroup { id: string; name: string; min: number; max: number; options: ModifierOption[] }
export interface MenuItem {
  id: string; name: string; category: string; description: string; priceOre: number;
  takeawayPriceOre: number | null; taxClass: TaxClass; course: Course; station: Station;
  available: boolean; example: boolean; modifiers: ModifierGroup[];
}
export interface DiningTable { id: string; name: string; seats: number; area: string; x: number; y: number; active: boolean }
export interface TaxRule { id: string; taxClass: TaxClass; mode: ServiceMode; from: string; until: string | null; rateBps: number }
export interface OrderLine {
  id: string; itemId: string; name: string; quantity: number; guest: number;
  baseUnitOre: number; unitPriceOre: number; vatBps: number; course: Course;
  station: Station; modifiers: ModifierOption[]; notes: string; status: LineStatus;
  createdAt: string; overrideReason?: string;
}
export interface Tab {
  id: string; dayId: string; number: number; tableId: string | null; label: string;
  guestCount: number; serviceMode: ServiceMode; status: 'open' | 'paid' | 'void';
  version: number; lines: OrderLine[]; discountBps: number; discountReason: string;
  openedAt: string; updatedAt: string; openedBy: string;
}
export interface CalculatedLine { lineId: string; originalOre: number; discountOre: number; grossOre: number; vatOre: number; vatBps: number }
export interface TabTotals { originalOre: number; discountOre: number; grossOre: number; vatOre: number; lines: CalculatedLine[] }
export interface Ticket {
  id: string; tabId: string; tabLabel: string; station: Station; kind: 'order' | 'cancel';
  status: 'queued' | 'started' | 'ready' | 'served'; items: OrderLine[];
  createdAt: string; updatedAt: string; createdBy: string; reason: string;
  movedFrom?: string;
}
export interface Allocation { lineId: string; grossOre: number; vatOre: number; vatBps: number }
export interface Payment {
  id: string; key: string; fingerprint: string; tabId: string; dayId: string;
  kind: 'sale' | 'refund'; parentId: string | null; method: PaymentMethod;
  status: PaymentStatus; amountOre: number; tipOre: number; allocations: Allocation[];
  tenderedOre: number | null; changeOre: number; reason: string; simulation: Simulation; fiscalSimulation: 'confirmed' | 'unknown';
  createdAt: string; updatedAt: string; staffId: string; deviceId: string;
}
export interface Receipt {
  id: string; paymentId: string; dayId: string; number: number; kind: 'sale' | 'refund';
  createdAt: string; fiscalStatus: 'pending' | 'confirmed' | 'unknown'; controlCode: string | null;
  originalReceiptId: string | null; payment: Payment; tab: Tab; company: Company;
  cashier: string; registerId: string;
}
export interface PrintJob {
  id: string; kind: 'guest' | 'kitchen' | 'bar' | 'closing' | 'drawer';
  sourceId: string; status: 'queued' | 'printing' | 'printed' | 'failed' | 'uncertain';
  text: string; createdAt: string; reprintOf: string | null; attempts: number;
}
export interface BusinessDay {
  id: string; number: number; date: string; status: 'open' | 'closed'; openedAt: string; closedAt: string | null;
  openedBy: string; closedBy: string | null; floatOre: number; countedCashOre: number | null;
  report: DayReport | null;
}
export interface MethodTotals { method: PaymentMethod; salesOre: number; refundsOre: number; tipsOre: number; netOre: number }
export interface DayReport {
  dayId: string; salesOre: number; refundsOre: number; netOre: number; tipsOre: number; vatOre: number;
  receipts: number; methods: MethodTotals[]; vat: { vatBps: number; grossOre: number; vatOre: number }[];
  expectedCashOre: number; differenceOre: number | null; unresolved: number; openTabs: number;
}
export interface Company { name: string; organizationNumber: string; address: string; city: string; phone: string }
export interface Settings { company: Company; registerId: string; taxRules: TaxRule[] }
export interface AuditEntry { id: number; at: string; actor: string; action: string; entityId: string; details: unknown; hash: string; previousHash: string }
export interface Bootstrap {
  mode: 'training'; actor: Actor; menu: MenuItem[]; tables: DiningTable[]; tabs: Tab[];
  tickets: Ticket[]; payments: Payment[]; receipts: Receipt[]; printJobs: PrintJob[];
  days: BusinessDay[]; currentDay: BusinessDay | null; report: DayReport | null;
  settings: Settings; staff: Staff[]; devices: Device[];
  backup: { lastAt: string | null; error: string | null; external: boolean };
}
