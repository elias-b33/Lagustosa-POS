import { afterEach,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture,key } from './helpers';
import type { BusinessDay,MenuItem } from '../shared/types';
import { SourceReader,projectDay } from '../portal/sync/project';
import { analytics,csv,dateShift,stockholmDate } from '../portal/shared/analytics';
import { initialCursor,querySchema,deliverySchema,net,type Snapshot } from '../portal/shared/model';
import { deliveries } from '../portal/sync/worker';
import { replica,provision,ingest,readReplica } from '../portal/local/replica';
import { passwordHash,passwordMatches,totp,verifyTotp } from '../portal/local/auth';

describe('Eleva Admin: bokföringsunderlag utan sidoeffekter',()=>{
  it('stämmer av delbetalningar, rabatter, olika moms, dricks, returer och historiska namn',async()=>{
    const f=fixture({},true),day=f.open(),tab=f.tab();
    f.command(tab.id,{action:'add',itemId:'bread',quantity:2});f.command(tab.id,{action:'add',itemId:'redwine'});
    f.command(tab.id,{action:'discount',discountBps:1733,reason:'Isolerat rabattprov'});f.command(tab.id,{action:'send'});
    const first=await f.pay(tab.id,{amountOre:7001,tipOre:501});await f.pay(tab.id);
    await f.service.refund(f.admin,first.id,{key:key(),amountOre:3001,reason:'Test av delretur',simulation:'approved',fiscalSimulation:'confirmed'});
    const original=f.store.get<MenuItem>('menu','bread')!;f.service.saveMenu(f.admin,{...original,name:'Dagens nya namn',category:'Ny kategori'});
    const before=JSON.stringify(f.store.journal()),reader=new SourceReader(f.filename);
    try{
      const snapshot=reader.capture(randomUUID()),result=analytics(snapshot.days,{from:day.date,to:day.date}),report=f.service.report(day.id);
      expect(result.total).toMatchObject({salesOre:report.salesOre,refundsOre:report.refundsOre,tipsOre:501,discountsOre:report.training!.discountsOre,salesCount:2,refundsCount:1});
      expect(net(result.total)).toBe(report.netOre);expect(result.total.salesVatOre-result.total.refundsVatOre).toBe(report.vatOre);
      expect(result.products.some(row=>row.name===original.name)).toBe(true);expect(result.products.some(row=>row.category==='Ny kategori')).toBe(false);
      expect(result.products.reduce((sum,row)=>sum+net(row.totals),0)).toBe(report.netOre);
      expect(result.products.some(row=>row.unknownQuantity>0)).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain('Isolerat rabattprov');expect(JSON.stringify(snapshot)).not.toContain('pinHash');
      expect(JSON.stringify(f.store.journal())).toBe(before);
      expect(()=>reader.db.prepare("UPDATE entities SET body=body WHERE kind='menu'").run()).toThrow();
    }finally{reader.close();}
  });
  it('håller returen på den nya dagen och bevarar stängt dagsavslut',async()=>{
    let now=new Date('2026-10-13T20:00:00Z');const f=fixture({now:()=>now},true),first=f.open(),tab=f.tab();
    f.command(tab.id,{action:'add',itemId:'bread'});f.command(tab.id,{action:'send'});const payment=await f.pay(tab.id);
    const closed=f.service.closeDay(f.admin,first.id,{key:key(),countedCashOre:150000});const frozen=JSON.stringify(closed);
    now=new Date('2026-10-14T20:00:00Z');const second=f.open();await f.service.refund(f.admin,payment.id,{key:key(),amountOre:payment.amountOre,reason:'Retur följande dag',simulation:'approved',fiscalSimulation:'confirmed'});
    const reader=new SourceReader(f.filename);try{const snapshot=reader.capture(randomUUID());const sale=analytics(snapshot.days,{from:first.date,to:first.date});const refund=analytics(snapshot.days,{from:second.date,to:second.date});expect(net(sale.total)).toBe(payment.amountOre);expect(net(refund.total)).toBe(-payment.amountOre);expect(refund.previous.salesOre).toBe(payment.amountOre);expect(JSON.stringify(f.store.get('day',first.id))).toBe(frozen);}finally{reader.close();}
  });
  it('redovisar öppna notor separat och räknar bara godkända belopp',async()=>{
    const f=fixture({},true),day=f.open(),tab=f.tab();f.command(tab.id,{action:'add',itemId:'bread',quantity:3});f.command(tab.id,{action:'send'});
    const sale=await f.pay(tab.id,{amountOre:1000});await f.pay(tab.id,{simulation:'declined'});
    const reader=new SourceReader(f.filename);try{const snapshot=reader.capture(randomUUID());expect(snapshot.days[0].totals.salesOre).toBe(sale.amountOre);expect(snapshot.operations.openTabs[0].paidOre).toBe(1000);expect(snapshot.operations.openTabs[0].remainingOre).toBe(f.service.report(day.id).training!.openTabAmountOre);expect(snapshot.operations.devices.every(row=>row.connections===null)).toBe(true);}finally{reader.close();}
  });
  it('identifierar avvikande journal efter återställning',()=>{
    const f=fixture({},true);f.open();const reader=new SourceReader(f.filename);try{expect(()=>reader.capture(randomUUID(),{sequence:1,hash:'f'.repeat(64)})).toThrow('SOURCE_DIVERGED');}finally{reader.close();}
  });
  it('behåller äldre totalsummor utan att hitta på artiklar',()=>{
    const f=fixture();const day:BusinessDay={id:'legacy',number:1,date:'2026-10-01',status:'closed',openedAt:'2026-10-01T10:00:00Z',closedAt:'2026-10-01T20:00:00Z',openedBy:'admin',closedBy:'admin',floatOre:0,countedCashOre:0,report:{dayId:'legacy',salesOre:12345,refundsOre:0,netOre:12345,tipsOre:0,vatOre:1323,receipts:1,methods:[],vat:[],expectedCashOre:0,differenceOre:0,unresolved:0,openTabs:0}};
    const result=projectDay(day,f.store.journal());expect(result.totals.salesOre).toBe(12345);expect(result.products).toEqual([]);expect(result.coverage.length).toBeGreaterThan(0);expect(analytics([result],{from:day.date,to:day.date,registerId:'legacy-unassigned'}).total.salesOre).toBe(12345);
  });
  it('hanterar datum, sommartid, tom historik och exportens filter',()=>{
    expect(stockholmDate(new Date('2026-10-24T22:30:00Z'))).toBe('2026-10-25');expect(dateShift('2026-10-25',1)).toBe('2026-10-26');
    expect(querySchema.safeParse({from:'2026-02-30',to:'2026-03-01'}).success).toBe(false);
    expect(querySchema.safeParse({from:'2025-01-01',to:'2026-02-01'}).success).toBe(false);
    const result=analytics([],{from:'2026-10-01',to:'2026-10-03'});expect(result.series).toHaveLength(3);expect(result.total.salesOre).toBe(0);expect(csv(result,true)).toContain('Exklusive moms');
  });
});

describe('Eleva Admin: faktisk PostgreSQL-synkning och åtkomst',()=>{
  const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
  async function setup(){const db=await replica();cleanup.push(()=>db.close());const restaurant=randomUUID(),installation=randomUUID(),user=randomUUID(),token='local-test-secret-'.repeat(3);await provision(db,restaurant,installation,token,user);const f=fixture({},true);f.open();const reader=new SourceReader(f.filename);const snapshot=reader.capture(installation);reader.close();return{db,restaurant,installation,user,token,snapshot};}
  it('visar ingen halv leverans och accepterar omsändning utan dubbelräkning',async()=>{
    const s=await setup();const batch=deliveries(s.snapshot,{}).parts[0];const one={...batch,parts:2},two={...batch,parts:2,part:1,days:[]};
    expect((await ingest(s.db,one,s.token)).committed).toBe(false);expect(await readReplica(s.db,s.installation)).toBe(null);
    expect((await ingest(s.db,two,s.token)).committed).toBe(true);const before=await readReplica(s.db,s.installation);
    expect((await ingest(s.db,one,s.token)).committed).toBe(true);expect(await readReplica(s.db,s.installation)).toEqual(before);
    expect((await s.db.query('select * from portal_days')).rows).toHaveLength(1);
  },30000);
  it('avvisar nyckelfel, återkallad nyckel, gamla positioner och ändrade leveransdelar',async()=>{
    const s=await setup(),batch=deliveries(s.snapshot,{}).parts[0];await expect(ingest(s.db,batch,'wrong')).rejects.toThrow('UNAUTHORIZED');
    await ingest(s.db,{...batch,parts:2},s.token);await expect(ingest(s.db,{...batch,parts:2,days:[]},s.token)).rejects.toThrow('PART_CONFLICT');
    await ingest(s.db,{...batch,parts:2,part:1,days:[]},s.token);
    await expect(ingest(s.db,{...batch,batchId:randomUUID(),generatedAt:new Date(Date.now()+1000).toISOString()},s.token)).rejects.toThrow('CURSOR_CONFLICT');
    await s.db.query('update portal_installations set revoked_at=now() where id=$1',[s.installation]);await expect(ingest(s.db,batch,s.token)).rejects.toThrow('UNAUTHORIZED');
  },30000);
  it('kräver aal2, isolerar restauranger och nekar klientskrivningar',async()=>{
    const s=await setup();await ingest(s.db,deliveries(s.snapshot,{}).parts[0],s.token);
    const otherUser=randomUUID(),otherInstall=randomUUID();await provision(s.db,randomUUID(),otherInstall,s.token,otherUser);
    await s.db.exec('set role authenticated');
    const claims=async(user:string,aal:string)=>{await s.db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,aal})]);};
    await claims(s.user,'aal1');expect((await s.db.query('select * from portal_days')).rows).toHaveLength(0);
    await claims(s.user,'aal2');expect((await s.db.query('select * from portal_days')).rows).toHaveLength(1);
    const window=()=>s.db.query<{result:unknown[]}>('select portal_read_window($1,$2,$3) as result',[s.installation,'2026-01-01','2026-12-31']);
    expect((await window()).rows[0].result).toHaveLength(1);
    await expect(s.db.query('select token_hash from portal_installations')).rejects.toThrow('permission');
    await expect(s.db.query('delete from portal_days')).rejects.toThrow('permission');
    await claims(otherUser,'aal2');expect((await s.db.query('select * from portal_days')).rows).toHaveLength(0);
    expect((await window()).rows[0].result).toEqual([]);
    await s.db.exec('reset role');await s.db.query('update portal_members set active=false where user_id=$1',[s.user]);await s.db.exec('set role authenticated');await claims(s.user,'aal2');expect((await s.db.query('select * from portal_days')).rows).toHaveLength(0);await s.db.exec('reset role');
  },30000);
  it('överför bara ändrade dagar och tillåter separat driftuppdatering',async()=>{
    const s=await setup(),first=deliveries(s.snapshot,{});await ingest(s.db,first.parts[0],s.token);
    const second=deliveries({...s.snapshot,previous:s.snapshot.cursor,generatedAt:new Date(Date.now()+1000).toISOString()},first.days);expect(second.parts[0].days).toEqual([]);
    expect((await ingest(s.db,second.parts[0],s.token)).committed).toBe(true);expect((await readReplica(s.db,s.installation))!.days).toHaveLength(1);
  },30000);
});
describe('Lokal testinloggning',()=>{
  it('kontrollerar TOTP mot RFC 6238 och lösenordshashar',()=>{
    const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';expect(totp(secret,59000)).toBe('287082');expect(verifyTotp(secret,'287082',59000)).toBe(true);expect(verifyTotp(secret,'000000',59000)).toBe(false);expect(verifyTotp(secret,'287082',200000)).toBe(false);
    const hash=passwordHash('correct-horse-test');expect(passwordMatches('correct-horse-test',hash)).toBe(true);expect(passwordMatches('incorrect',hash)).toBe(false);
  });
});
