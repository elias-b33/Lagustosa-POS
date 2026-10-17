import { mkdirSync,writeFileSync } from 'node:fs';
import { build,loadEnv } from 'vite';
import { collectNotices } from '../../scripts/generate-third-party-notices.mjs';
const env=loadEnv('production','portal','VITE_');
const serviceUrl=process.env.VITE_ADMIN_SUPABASE_URL??env.VITE_ADMIN_SUPABASE_URL;
if(process.argv.includes('--cloud')){
  const url=process.env.VITE_ADMIN_SUPABASE_URL??env.VITE_ADMIN_SUPABASE_URL;
  const key=process.env.VITE_ADMIN_SUPABASE_KEY??env.VITE_ADMIN_SUPABASE_KEY;
  let publicKey=Boolean(key?.startsWith('sb_publishable_'));
  if(key?.split('.').length===3){try{publicKey=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role==='anon';}catch{}}
  if(!url?.startsWith('https://')||!publicKey)throw new Error('Molnbygget kräver HTTPS-adress och en publishable/anon-nyckel. Hemliga service-nycklar får aldrig hamna i webbläsaren.');
}
const result=collectNotices();mkdirSync('portal/web/public/licenses',{recursive:true});writeFileSync('portal/web/public/licenses/THIRD-PARTY-NOTICES.txt',result.notices);
await build({configFile:'portal/vite.config.ts'});
const connect=serviceUrl?new URL(serviceUrl).origin:'';
writeFileSync('dist/portal/_headers',`/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${connect}; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  X-Robots-Tag: noindex, nofollow
`);
