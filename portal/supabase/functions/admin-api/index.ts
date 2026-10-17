import { createClient } from '@supabase/supabase-js';
import { deliverySchema, querySchema, type PortalDay } from '../../../shared/model.ts';
import { analytics, exportCsv, dateShift, receiptPage } from '../../../shared/analytics.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const publicKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const origin = Deno.env.get('PORTAL_ORIGIN')!;
const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2,'0')).join('');
Deno.serve(async (request: Request) => {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' });
  if (request.headers.get('origin') === origin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Access-Control-Allow-Headers','authorization,apikey,content-type'); headers.set('Access-Control-Allow-Methods','GET,POST,OPTIONS'); }
  const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const address = new URL(request.url), route = address.pathname.split('/').at(-1);
    if (route === 'ingest' && request.method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer /,'') ?? '';
      if (token.length < 32 || token.length > 256) return respond({ message:'Synknyckel saknas.' },401);
      const text = await request.text();
      if (text.length > 8_000_000) return respond({ message:'Leveransen är för stor.' },413);
      const body = deliverySchema.parse(JSON.parse(text));
      const admin = createClient(url,secretKey,{ auth:{ persistSession:false,autoRefreshToken:false } });
      const { data,error } = await admin.rpc('portal_ingest',{ p_body:body,p_token_hash:await digest(token),p_digest:await digest(JSON.stringify(body.days)) });
      if (error) return respond({ message:error.message.includes('UNAUTHORIZED') ? 'Synknyckeln är ogiltig.' : 'Synkpositionen behöver kontrolleras.', code:error.message },error.message.includes('UNAUTHORIZED') ? 401 : 409);
      return respond(data);
    }
    if (request.method !== 'GET') return respond({ message:'Metoden stöds inte.' },405);
    const authorization = request.headers.get('authorization') ?? '';
    const client = createClient(url,publicKey,{ global:{ headers:{ Authorization:authorization } },auth:{ persistSession:false,autoRefreshToken:false } });
    const { data:identity,error:authError } = await client.auth.getUser(authorization.replace(/^Bearer /,''));
    if (authError || !identity.user) return respond({ message:'Logga in för att fortsätta.' },401);
    // RLS independently requires aal2 and an active restaurant membership for every read.
    const { data:installs,error } = await client.from('portal_installations').select('id,metadata,received_at,snapshot_at').is('revoked_at',null);
    if (error || !installs?.length) return respond({ message:'Tvåstegsverifiering och restaurangbehörighet krävs.' },403);
    const installation = installs.find(row => row.id === address.searchParams.get('installationId')) ?? (installs.length === 1 ? installs[0] : null);
    if (!installation) return respond({ message:'Välj en behörig installation.' },403);
    if (!installation.metadata) return respond({ message:'Väntar på första synkningen.' },503);
    if (route === 'meta') {
      const { data:current } = await client.from('portal_days').select('date').eq('installation_id',installation.id).eq('payload->>status','open').limit(1);
      return respond({ ...installation.metadata, receivedAt:installation.received_at,currentDay:current?.[0]?.date ?? null });
    }
    const query = querySchema.parse({ from:address.searchParams.get('from'),to:address.searchParams.get('to'),...(address.searchParams.get('registerId') ? {registerId:address.searchParams.get('registerId')} : {}) });
    const span = Math.round((Date.parse(query.to)-Date.parse(query.from))/86400000)+1;
    // One PostgreSQL statement keeps the window consistent and avoids PostgREST's row cap.
    const { data:stored,error:readError } = await client.rpc('portal_read_window',{p_installation:installation.id,p_from:dateShift(query.from,-span),p_to:query.to});
    if (readError) throw readError;
    const days = (stored ?? []) as PortalDay[];
    if (route === 'receipts') return respond(receiptPage(days,{...query,search:(address.searchParams.get('search') ?? '').slice(0,160),kind:address.searchParams.get('kind') ?? '',page:Math.max(1,Number(address.searchParams.get('page')) || 1)}));
    const result = analytics(days,query);
    if (route === 'export') { headers.set('Content-Type','text/csv; charset=utf-8'); headers.set('Content-Disposition','attachment; filename="eleva-statistik-test.csv"'); return new Response(exportCsv(days,query,Object.fromEntries(address.searchParams)),{headers}); }
    if (route !== 'analytics') return respond({message:'Sidan finns inte.'},404);
    return respond(result);
  } catch (error) { return respond({ message: error instanceof Error && error.name === 'ZodError' ? 'Kontrollera datum och filter.' : 'Uppgifterna kunde inte hämtas.' },400); }
});
