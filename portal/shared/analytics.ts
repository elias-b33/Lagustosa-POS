import { addTotals, zeroTotals, net, querySchema, type AnalyticsQuery, type PortalDay, type Product, type Snapshot, type Totals } from './model.ts';

export function dateShift(date: string, days: number): string { return new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10); }
export function stockholmDate(now = new Date()): string { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(now); }
function quantityAdd(a: Product['sold'], b: Product['sold']) {
  let top = BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator);
  let bottom = BigInt(a.denominator) * BigInt(b.denominator);
  let x = top, y = bottom;
  while (y) [x, y] = [y, x % y];
  if (x) { top /= x; bottom /= x; }
  return { numerator: String(top), denominator: String(bottom) };
}
export function analytics(days: PortalDay[], input: AnalyticsQuery) {
  const query = querySchema.parse(input);
  const matches = (row: { registerId: string }) => !query.registerId || row.registerId === query.registerId;
  const selected = days.filter(day => day.date >= query.from && day.date <= query.to);
  const duration = Math.round((Date.parse(query.to) - Date.parse(query.from)) / 86400000) + 1;
  const previousFrom = dateShift(query.from, -duration), previousTo = dateShift(query.from, -1);
  const dayTotals = (day: PortalDay) => query.registerId ? day.registers.filter(matches).reduce((sum, row) => addTotals(sum, row.totals), zeroTotals()) : day.totals;
  const total = selected.reduce((sum, day) => addTotals(sum, dayTotals(day)), zeroTotals());
  const previous = days.filter(day => day.date >= previousFrom && day.date <= previousTo).reduce((sum, day) => addTotals(sum, dayTotals(day)), zeroTotals());
  const series = Array.from({ length: duration }, (_, index) => {
    const date = dateShift(query.from, index);
    return { date, totals: selected.filter(day => day.date === date).reduce((sum, day) => addTotals(sum, dayTotals(day)), zeroTotals()) };
  });
  const group = (field: 'methods' | 'vat' | 'registers' | 'hours') => {
    const result = new Map<string, Totals>();
    for (const day of selected) for (const row of day[field].filter(matches)) result.set(row.key, addTotals(result.get(row.key) ?? zeroTotals(), row.totals));
    return [...result].map(([key, totals]) => ({ key, totals })).sort((a, b) => a.key.localeCompare(b.key, 'sv'));
  };
  const products = new Map<string, Product>();
  for (const day of selected) for (const row of day.products.filter(matches)) {
    // A renamed product remains a separate historical label/category rather than rewriting old records.
    const key = JSON.stringify([row.itemId, row.name, row.category]);
    const current = products.get(key);
    if (!current) products.set(key, structuredClone(row));
    else { addTotals(current.totals, row.totals); current.sold = quantityAdd(current.sold, row.sold); current.refunded = quantityAdd(current.refunded, row.refunded); current.unknownQuantity += row.unknownQuantity; }
  }
  return {
    query, total, previous, previousFrom, previousTo, series,
    partial: selected.some(day => day.status === 'open'),
    coverage: [...new Set(selected.flatMap(day => day.coverage))],
    products: [...products.values()].sort((a, b) => net(b.totals) - net(a.totals) || a.name.localeCompare(b.name, 'sv')),
    methods: group('methods'), vat: group('vat'), registers: group('registers'), hours: group('hours'),
  };
}
export type Analytics = ReturnType<typeof analytics>;
type ReceiptQuery = AnalyticsQuery & { search?: string; kind?: string; page?: number };
function receiptRows(days: PortalDay[], query: ReceiptQuery) {
  querySchema.parse({ from: query.from, to: query.to, ...(query.registerId ? { registerId: query.registerId } : {}) });
  const search = (query.search ?? '').toLocaleLowerCase('sv');
  return days.filter(day => day.date >= query.from && day.date <= query.to).flatMap(day => day.receipts.map(receipt => ({ ...receipt, date: day.date })))
    .filter(row => (!query.registerId || row.registerId === query.registerId) && (!query.kind || row.kind === query.kind) && (!search || `${row.number ?? ''} ${row.tabNumber ?? ''} ${row.registerId}`.toLocaleLowerCase('sv').includes(search)))
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
export function receiptPage(days: PortalDay[], query: ReceiptQuery) {
  const rows=receiptRows(days,query);
  const page = Math.max(1, Math.min(Math.ceil(rows.length / 25) || 1, Math.floor(query.page ?? 1)));
  return { rows: rows.slice((page - 1) * 25, page * 25), total: rows.length, page, pages: Math.max(1, Math.ceil(rows.length / 25)) };
}
function csvRows(rows: (string | number)[][]): string {
  const cell = (value: string | number) => {
    let text = typeof value === 'number' ? value.toLocaleString('sv-SE',{useGrouping:false,maximumFractionDigits:2}) : value;
    if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n');
}
export function csv(result: Analytics, exclusive: boolean): string {
  const rows: (string | number)[][] = [['ELEVA ADMIN · TRÄNING'], ['Från', result.query.from, 'Till', result.query.to, 'Kassa', result.query.registerId ?? 'Alla'], ['Belopp i SEK', exclusive ? 'Exklusive moms' : 'Inklusive moms'], ['Datum', 'Försäljning efter returer', 'Försäljningar', 'Returer', 'Dricks', 'Försäljningskvitton']];
  for (const row of result.series) rows.push([row.date, net(row.totals, exclusive) / 100, (row.totals.salesOre - (exclusive ? row.totals.salesVatOre : 0)) / 100, (row.totals.refundsOre - (exclusive ? row.totals.refundsVatOre : 0)) / 100, row.totals.tipsOre / 100, row.totals.salesCount]);
  rows.push([], ['Artikel', 'Kategori', 'Försäljning efter returer', 'Dokumenterat sålt antal', 'Dokumenterat returnerat antal', 'Antal utan säkert underlag']);
  for (const row of result.products) rows.push([row.name, row.category, net(row.totals, exclusive) / 100, `${row.sold.numerator}/${row.sold.denominator}`, `${row.refunded.numerator}/${row.refunded.denominator}`, row.unknownQuantity]);
  for (const issue of result.coverage) rows.push(['Ofullständigt underlag', issue]);
  return csvRows(rows);
}
export type ProductFilters={search:string;category:string;sort:string};
export function filterProducts(products:Product[],filters:ProductFilters,exclusive=false){
  return products.filter(row=>(!filters.category||row.category===filters.category)&&row.name.toLocaleLowerCase('sv').includes(filters.search.toLocaleLowerCase('sv'))).sort((a,b)=>{
    if(filters.sort==='name')return a.name.localeCompare(b.name,'sv');
    if(filters.sort==='refunds')return b.totals.refundsOre-(exclusive?b.totals.refundsVatOre:0)-a.totals.refundsOre+(exclusive?a.totals.refundsVatOre:0);
    if(filters.sort==='quantity'){const diff=BigInt(b.sold.numerator)*BigInt(a.sold.denominator)-BigInt(a.sold.numerator)*BigInt(b.sold.denominator);return diff>0n?1:diff<0n?-1:0;}
    return net(b.totals,exclusive)-net(a.totals,exclusive);
  });
}
export function exportCsv(days:PortalDay[],query:AnalyticsQuery,options:Record<string,string|undefined>){
  const exclusive=options.exclusive==='true',result=analytics(days,query);
  if(options.view==='sales'){
    const rows:(string|number)[][]=[['ELEVA ADMIN · TRÄNING'],['Från',query.from,'Till',query.to,'Kassa',query.registerId??'Alla'],['Sökning',options.search??'','Typ',options.kind??'Alla'],['Kvitto','Nota','Tidpunkt','Kassa','Typ','Betalningssätt','Belopp inkl. moms','Dricks']];
    for(const row of receiptRows(days,{...query,search:options.search,kind:options.kind}))rows.push([row.number??'Saknas',row.tabNumber??'',row.at,row.registerId,row.kind==='sale'?'Försäljning':'Retur',row.method,(row.kind==='sale'?1:-1)*row.amountOre/100,row.tipOre/100]);
    return csvRows(rows);
  }
  if(options.view==='products'){
    const filters={search:options.productSearch??'',category:options.category??'',sort:options.sort??'sales'};
    const rows:(string|number)[][]=[['ELEVA ADMIN · TRÄNING'],['Från',query.from,'Till',query.to,'Kassa',query.registerId??'Alla'],['Sökning',filters.search,'Kategori',filters.category,'Sortering',filters.sort],['Belopp i SEK',exclusive?'Exklusive moms':'Inklusive moms'],['Artikel','Kategori','Returer','Efter returer','Dokumenterat sålt antal','Dokumenterat returnerat antal','Fördelningar utan säkert antal']];
    for(const row of filterProducts(result.products,filters,exclusive))rows.push([row.name,row.category,(row.totals.refundsOre-(exclusive?row.totals.refundsVatOre:0))/100,net(row.totals,exclusive)/100,`${row.sold.numerator}/${row.sold.denominator}`,`${row.refunded.numerator}/${row.refunded.denominator}`,row.unknownQuantity]);
    for(const issue of result.coverage)rows.push(['Ofullständigt underlag',issue]);
    return csvRows(rows);
  }
  return csv(result,exclusive);
}
export type PortalMeta = Pick<Snapshot, 'generatedAt' | 'restaurantName' | 'operations' | 'registers' | 'mode'> & { receivedAt: string; installationId: string; currentDay: string | null };
