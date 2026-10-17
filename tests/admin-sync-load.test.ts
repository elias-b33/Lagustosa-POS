import { describe,it,expect } from 'vitest';
import Fastify from 'fastify';
import { fork,type ChildProcess } from 'node:child_process';
import { randomUUID,createHash } from 'node:crypto';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import { fixture,key } from './helpers';
import { replica,provision,ingest,readReplica } from '../portal/local/replica';
import { SyncWorker } from '../portal/sync/worker';
import { analytics,exportCsv } from '../portal/shared/analytics';
import { registerAdminRuntime } from '../server/admin-runtime';
import type { Payment,PrintJob,Ticket } from '../shared/types';

describe('Eleva Admin: återstart och belastning',()=>{
  it('återupptar en diskbaserad leverans när serverns bekräftelse försvinner',async()=>{
    const f=fixture({},true);f.open();const db=await replica(),app=Fastify();
    const installation=randomUUID(),token='retry-test-'.repeat(5);await provision(db,randomUUID(),installation,token,randomUUID());
    let loseReply=true;
    app.post('/ingest',async(request,reply)=>{const result=await ingest(db,request.body,token);if(loseReply){loseReply=false;return reply.code(503).send({message:'Simulerad förlorad bekräftelse'});}return result;});
    const endpoint=await app.listen({host:'127.0.0.1',port:0});
    const config={database:f.filename,stateDir:path.join(f.directory,'sync'),installationId:installation,endpoint:endpoint+'/ingest',token};
    let worker=new SyncWorker(config);
    try{
      const tab=f.tab();f.command(tab.id,{action:'add',itemId:'bread'});f.command(tab.id,{action:'send'});await f.pay(tab.id);
      await expect(worker.once()).rejects.toThrow('503');
      const pending=JSON.parse(readFileSync(path.join(config.stateDir,'sync-state.json'),'utf8'));expect(pending.cursor.sequence).toBe(0);expect(pending.pending).toHaveLength(1);
      worker.close();worker=new SyncWorker(config);await worker.once();
      const stored=await readReplica(db,installation);expect(stored!.days[0].totals.salesCount).toBe(1);
      expect(JSON.parse(readFileSync(path.join(config.stateDir,'sync-state.json'),'utf8')).pending).toBeNull();
      // Replace the source with an older independent backup; never bypass audit immutability.
      worker.close();const restored=fixture({},true);restored.open();worker=new SyncWorker({...config,database:restored.filename});
      await expect(worker.once()).rejects.toThrow('SOURCE_DIVERGED');
    }finally{worker.close();await app.close();await db.close();}
  },30000);

  it('klarar 90 gäster, tre kassor, kök och molnavbrott med synkning i separat process',async()=>{
    const f=fixture({},true),day=f.open();
    const staff=[f.admin,f.actor('admin','SERVERING-1'),f.actor('admin','SERVERING-2')];
    const db=await replica(),app=Fastify(),installation=randomUUID(),token='load-test-'.repeat(5);
    await provision(db,randomUUID(),installation,token,randomUUID());
    let offline=false,received=0,failures=0;const messages:{ok:boolean;message?:string}[]=[];
    app.post('/ingest',async(request,reply)=>{if(offline){failures++;return reply.code(503).send({message:'Simulerat internetavbrott'});}const result=await ingest(db,request.body,token);received++;return result;});
    const endpoint=await app.listen({host:'127.0.0.1',port:0});
    const config={database:f.filename,stateDir:path.join(f.directory,'sync'),installationId:installation,endpoint:endpoint+'/ingest',token};
    let child:ChildProcess|undefined;
    const waitFor=async(check:()=>boolean)=>{const until=Date.now()+20000;while(!check()){if(Date.now()>until)throw new Error('Synkprocessen svarade inte i tid.');await new Promise(resolve=>setTimeout(resolve,30));}};
    const timings:number[]=[],start=performance.now();
    try{
      const tabs=Array.from({length:30},(_,i)=>{
        const actor=staff[i%3],tab=f.service.createTab(actor,{key:key(),tableId:null,guestCount:3,serviceMode:'dine_in'});
        for(const itemId of ['bread','margherita','redwine'])f.command(tab.id,{action:'add',itemId,quantity:3},actor);
        f.command(tab.id,{action:'send'},actor);f.command(tab.id,{action:'fire'},actor);return{tab,actor};
      });
      child=fork(path.resolve('tests/fixtures/admin-sync-worker.ts'),[],{execArgv:['--import','tsx'],env:{...process.env,ADMIN_TEST_SYNC_CONFIG:JSON.stringify(config)},stdio:['ignore','ignore','pipe','ipc']});
      child.on('message',message=>messages.push(message as {ok:boolean}));await waitFor(()=>messages.some(row=>row.ok));
      for(let guest=0;guest<90;guest++){
        if(guest===20){offline=true;await waitFor(()=>failures>0);}
        if(guest===50)offline=false;
        const {tab,actor}=tabs[guest%30],total=f.service.tab(tab.id).lines.reduce((sum,line)=>sum+line.unitPriceOre*line.quantity,0);
        const before=performance.now();await f.pay(tab.id,{amountOre:total/3,tipOre:100},actor);timings.push(performance.now()-before);
      }
      for(const payment of f.store.all<Payment>('payment').filter(row=>row.kind==='sale').slice(0,3))await f.service.refund(f.admin,payment.id,{key:key(),amountOre:1001,reason:'Belastningsprov retur',simulation:'approved',fiscalSimulation:'confirmed'});
      for(const ticket of f.store.all<Ticket>('ticket'))for(const status of ['started','ready','served'] as const)f.service.updateTicket(f.admin,ticket.id,status);
      f.service.closeDay(f.admin,day.id,{key:key(),countedCashOre:150000});
      const journalBefore=JSON.stringify(f.store.journal()),receiptsBefore=JSON.stringify(f.store.all('receipt')),dayBefore=JSON.stringify(f.store.get('day',day.id));
      const cursor=f.store.journal().at(-1)!.id;
      await waitFor(()=>messages.some(row=>row.ok&&(row as unknown as {cursor:{sequence:number}}).cursor.sequence===cursor));
      const current=(await readReplica(db,installation))!,summary=analytics(current.days,{from:day.date,to:day.date}),report=f.service.report(day.id);
      expect(summary.total.salesCount).toBe(90);expect(summary.total.refundsCount).toBe(3);expect(summary.total.tipsOre).toBe(9000);
      expect(summary.total.salesOre-summary.total.refundsOre).toBe(report.netOre);expect(summary.total.salesVatOre-summary.total.refundsVatOre).toBe(report.vatOre);
      expect(summary.registers.filter(row=>row.totals.salesCount>0)).toHaveLength(3);
      for(const register of summary.registers)expect(analytics(current.days,{from:day.date,to:day.date,registerId:register.key}).total).toEqual(register.totals);
      expect(current.meta.operations.openTabs).toHaveLength(0);expect(current.meta.operations.kitchen).toBe(0);
      expect(JSON.stringify(f.store.journal())).toBe(journalBefore);expect(JSON.stringify(f.store.all('receipt'))).toBe(receiptsBefore);expect(JSON.stringify(f.store.get('day',day.id))).toBe(dayBefore);
      expect(f.store.all<PrintJob>('print').some(job=>job.status==='printing')).toBe(false);
      const exported=exportCsv(current.days,{from:day.date,to:day.date},{view:'sales',kind:'refund'});expect(exported.match(/"Retur"/g)).toHaveLength(3);
      const productExport=exportCsv(current.days,{from:day.date,to:day.date},{view:'products',productSearch:'margherita',sort:'quantity'});expect(productExport).toContain('Margherita');expect(productExport).not.toContain('Bröd');
      timings.sort((a,b)=>a-b);mkdirSync('artifacts',{recursive:true});
      writeFileSync('artifacts/admin-load-results.json',JSON.stringify({guests:90,tabs:30,registers:3,sales:summary.total.salesCount,refunds:3,netOre:report.netOre,vatOre:report.vatOre,tipsOre:9000,paymentP95ms:timings[Math.ceil(timings.length*.95)-1],paymentMaxMs:timings.at(-1),elapsedMs:performance.now()-start,syncDeliveries:received,simulatedInternetFailures:failures,journalUnchangedByFinalSync:true,journalSha256:createHash('sha256').update(journalBefore).digest('hex'),physicalPrints:0},null,2));
      expect(failures).toBeGreaterThan(0);expect(received).toBeGreaterThan(1);
    }finally{if(child&&!child.killed){child.send('stop');await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());setTimeout(()=>{child?.kill();resolve();},3000).unref();});}await app.close();await db.close();}
  },90000);

  it('lämnar enbart driftstatus till lokal nyckelinnehavare utan rapporthändelse',async()=>{
    const f=fixture(),app=Fastify(),token='runtime-secret-'.repeat(3);registerAdminRuntime(app,f.service,token);
    const before=f.store.journal();try{
      expect((await app.inject({url:'/api/v1/admin-sync/runtime',remoteAddress:'127.0.0.1'})).statusCode).toBe(403);
      expect((await app.inject({url:'/api/v1/admin-sync/runtime',remoteAddress:'192.168.1.1',headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(403);
      const result=await app.inject({url:'/api/v1/admin-sync/runtime',remoteAddress:'127.0.0.1',headers:{authorization:`Bearer ${token}`}});expect(result.statusCode).toBe(200);expect(Object.keys(result.json()).sort()).toEqual(['at','devices']);expect(f.store.journal()).toEqual(before);
    }finally{await app.close();}
  });
});
