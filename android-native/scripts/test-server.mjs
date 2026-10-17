import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Dedicated training data and loopback ports. Never points at an existing restaurant database.
const nativeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(process.argv[2] || path.join(nativeRoot, '..'));
const dataDir = await mkdtemp(path.join(tmpdir(), 'native-pos-test-'));
const backend = spawn(process.execPath, [process.argv[3] || 'dist/server/index.js'], { cwd: repo, windowsHide: true, stdio: ['ignore','pipe','pipe'], env: {
  ...process.env, DATA_DIR: dataDir, BACKUP_DIR: path.join(dataDir,'backups'), HOST: '127.0.0.1', PORT: '4200',
  TLS_CERT: '', TLS_KEY: '', NODE_ENV: 'production', APP_MODE: 'training', INSTALLATION_PROFILE: 'template',
  PAYMENT_ADAPTER: 'simulator', FISCAL_ADAPTER: 'simulator', PRINT_ADAPTER: 'preview', TEST_ENVIRONMENT: '',
  ADMIN_RUNTIME_TOKEN: '', SESSION_COOKIE_NAME: 'native_review_session',
}});
let startup = '', listening=false; backend.stderr.on('data', chunk => { startup += chunk; });
backend.stdout.on('data', chunk => { startup+=chunk; if(startup.includes('Server listening at http://127.0.0.1:4200'))listening=true; });
process.on('exit', () => backend.kill()); process.on('SIGINT', () => process.exit()); process.on('SIGTERM', () => process.exit());
// Wait for our own child's bind acknowledgement; never seed an unrelated process on this port.
for(let i=0;i<100&&!listening;i++) { if(backend.exitCode!==null)throw new Error(startup);await new Promise(r=>setTimeout(r,100)); }
if(!listening)throw new Error('Isolated backend did not bind its port: '+startup);
const health = await (await fetch('http://127.0.0.1:4200/api/v1/health')).json();
if (health.mode !== 'training' || health.adapters.payment !== 'simulator' || health.adapters.fiscal !== 'simulator') throw new Error('Expected isolated training server');
let deviceCode='',adminCookie='',productName='';
for(const candidate of ['KASSA-TEST','LAGUSTOSA-TEST']) {
  const response=await fetch('http://127.0.0.1:4200/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({staffId:'admin',pin:'1234',deviceCode:candidate})});
  if(response.ok){deviceCode=candidate;adminCookie=response.headers.get('set-cookie').split(';')[0];break;}
}
if(!adminCookie)throw new Error('Cannot sign into the newly created isolated training data');
const baseline=await (await fetch('http://127.0.0.1:4200/api/v1/bootstrap',{headers:{Cookie:adminCookie}})).json();
// Neutralise the legacy seed's branded sample dish only in this throwaway database.
for(const item of baseline.menu.filter(item=>/la\s*gustosa/i.test(item.name))) {
  const response=await fetch('http://127.0.0.1:4200/api/v1/menu/'+encodeURIComponent(item.id),{method:'PUT',headers:{Cookie:adminCookie,'Content-Type':'application/json'},body:JSON.stringify({...item,name:'Husets sallad'})});
  if(!response.ok)throw new Error(await response.text());
}
productName=baseline.menu.find(item=>item.available&&item.course==='drink'&&!item.modifiers.length)?.name;
if(!productName)throw new Error('Missing plain test drink');
let dropNext = false, dropKey = ''; const commands=[];
let seedState = { started:false, ready:false };
async function seedStress() {
  const login=await fetch('http://127.0.0.1:4200/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({staffId:'admin',pin:'1234',deviceCode})});
  if(!login.ok)throw new Error(await login.text());
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body?'POST':'GET')=>{
    const response=await fetch('http://127.0.0.1:4200/api/v1'+route,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    if(!response.ok)throw new Error(await response.text());return response.json();
  };
  const initial=await request('/bootstrap');if(!initial.currentDay)await request('/business-days',{key:randomUUID(),floatOre:0});
  for(let i=0;i<300;i++)await request('/menu/native-stress-'+i,{id:'native-stress-'+i,name:'Testartikel '+String(i).padStart(3,'0'),category:'Testgrupp '+(i%6),description:'Prestandaprov',position:1000+i,itemKind:'goods',takeawayItemKind:'goods',priceOre:10000+i,takeawayPriceOre:null,taxClass:'food',course:'main',station:'kitchen',available:true,example:true,modifiers:[]},'PUT');
  let next=0;await Promise.all(Array.from({length:4},async()=>{while(next<40){const i=next++;let tab=await request('/tabs',{key:randomUUID(),tableId:null,guestCount:2,serviceMode:'dine_in'});for(let j=0;j<25;j++)tab=await request('/tabs/'+tab.id+'/commands',{key:randomUUID(),version:tab.version,action:'add',itemId:'native-stress-'+((i*25+j)%300),quantity:1,hold:false});}}));
  seedState={started:true,ready:true};
}
const proxy=http.createServer(async(req,res)=>{
  if(req.url==='/api/v1/__native_test/config'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({deviceCode,productName}));return;}
  if(req.url==='/api/v1/__native_test/drop-next'){dropNext=true;res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;}
  if(req.url==='/api/v1/__native_test/stats'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({commands}));return;}
  if(req.url==='/api/v1/__native_test/release'){dropKey='';dropNext=false;res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;}
  if(req.url==='/api/v1/__native_test/seed-stress'){
    if(!seedState.started){seedState={started:true,ready:false};seedStress().catch(error=>{seedState={started:true,ready:false,error:error.message};});}
    res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;
  }
  if(req.url==='/api/v1/__native_test/seed-status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(seedState));return;}
  const body=[];for await(const chunk of req)body.push(chunk);const bytes=Buffer.concat(body);
  let dropped=false;
  if(req.url?.endsWith('/commands') && req.method==='POST'){
    const input=JSON.parse(bytes.toString()); commands.push({key:input.key,action:input.action,tab:req.url});
    if(dropNext&&input.action==='add'){dropNext=false;dropKey=input.key;}
    if(dropKey&&input.key===dropKey)dropped=true;
  }
  const upstream=http.request({hostname:'127.0.0.1',port:4200,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:4200'}},response=>{
    if(dropped){response.resume();response.on('end',()=>res.destroy());return;}
    res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>{if(!res.headersSent){res.writeHead(502);res.end('{"code":"TEST_PROXY","message":"Testservern svarade inte"}');}else res.destroy();});res.on('close',()=>upstream.destroy());upstream.end(bytes);
});
await new Promise(resolve=>proxy.listen(4196,'127.0.0.1',resolve));
await mkdir(path.join(nativeRoot,'artifacts'),{recursive:true});
await writeFile(path.join(nativeRoot,'artifacts','test-server.json'),JSON.stringify({pid:process.pid,backendPid:backend.pid,dataDir,hostURL:'http://127.0.0.1:4196',emulatorURL:'http://10.0.2.2:4196',health},null,2));
console.log('Native training server ready on http://127.0.0.1:4196');
