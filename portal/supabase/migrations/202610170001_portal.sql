create table public.portal_restaurants (id uuid primary key, name text not null);
create table public.portal_members (restaurant_id uuid references public.portal_restaurants(id), user_id uuid references auth.users(id), active boolean not null default true, primary key (restaurant_id,user_id));
create table public.portal_installations (
  id uuid primary key, restaurant_id uuid not null references public.portal_restaurants(id), token_hash text not null,
  revoked_at timestamptz, source_sequence bigint not null default 0, source_hash text not null default repeat('0',64),
  snapshot_at timestamptz, received_at timestamptz, metadata jsonb,
  constraint valid_token_hash check (token_hash ~ '^[a-f0-9]{64}$')
);
create table public.portal_days (installation_id uuid references public.portal_installations(id), day_id text, date date not null, payload jsonb not null, primary key(installation_id,day_id));
create index portal_days_date on public.portal_days(installation_id,date);
create table public.portal_batches (id uuid primary key, installation_id uuid not null references public.portal_installations(id), parts int not null, header jsonb not null, committed boolean not null default false, created_at timestamptz not null default now());
create table public.portal_parts (batch_id uuid references public.portal_batches(id) on delete cascade, part int, digest text not null, days jsonb not null, primary key(batch_id,part));

alter table public.portal_restaurants enable row level security;
alter table public.portal_members enable row level security;
alter table public.portal_installations enable row level security;
alter table public.portal_days enable row level security;
alter table public.portal_batches enable row level security;
alter table public.portal_parts enable row level security;

-- Only explicitly provisioned memberships can read; no client can write or assign itself a restaurant.
create policy member_self on public.portal_members for select to authenticated using (user_id = auth.uid() and active and (select auth.jwt()->>'aal') = 'aal2');
create policy restaurant_member on public.portal_restaurants for select to authenticated using (exists(select 1 from public.portal_members m where m.restaurant_id=id and m.user_id=auth.uid()));
-- Installation rows contain a hashed credential; API returns only selected public columns.
create policy installation_member on public.portal_installations for select to authenticated using (revoked_at is null and exists(select 1 from public.portal_members m where m.restaurant_id=portal_installations.restaurant_id and m.user_id=auth.uid()));
create policy days_member on public.portal_days for select to authenticated using (exists(select 1 from public.portal_installations i where i.id=installation_id));
revoke all on public.portal_restaurants,public.portal_members,public.portal_installations,public.portal_days,public.portal_batches,public.portal_parts from anon,authenticated;
grant select on public.portal_restaurants,public.portal_members,public.portal_days to authenticated;
grant select(id,restaurant_id,revoked_at,source_sequence,source_hash,snapshot_at,received_at,metadata) on public.portal_installations to authenticated;
grant all on public.portal_restaurants,public.portal_members,public.portal_installations,public.portal_days,public.portal_batches,public.portal_parts to service_role;

-- A single snapshot for the full comparison window, without the REST row limit.
-- SECURITY INVOKER retains the caller's MFA/membership RLS checks.
create function public.portal_read_window(p_installation uuid,p_from date,p_to date) returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(payload order by date,day_id),'[]'::jsonb)
  from public.portal_days
  where installation_id=p_installation and date between p_from and p_to and p_to-p_from between 0 and 731
$$;
revoke all on function public.portal_read_window(uuid,date,date) from public,anon;
grant execute on function public.portal_read_window(uuid,date,date) to authenticated,service_role;

-- A multipart delivery becomes visible only after every part has arrived.
-- The same function is exercised by the local PostgreSQL replica tests.
create or replace function public.portal_ingest(p_body jsonb,p_token_hash text,p_digest text) returns jsonb
language plpgsql security definer set search_path = public,pg_temp as $$
declare
  inst public.portal_installations%rowtype;
  batch public.portal_batches%rowtype;
  existing_digest text;
  header jsonb := p_body - 'days' - 'part';
  item jsonb;
  delivery_cursor bigint := (p_body->'cursor'->>'sequence')::bigint;
begin
  select * into inst from public.portal_installations where id=(p_body->>'installationId')::uuid for update;
  if not found or inst.revoked_at is not null or inst.token_hash <> p_token_hash then raise exception 'SYNC_UNAUTHORIZED'; end if;
  select * into batch from public.portal_batches where id=(p_body->>'batchId')::uuid;
  if found then
    if batch.installation_id <> inst.id or batch.header <> header then raise exception 'BATCH_CONFLICT'; end if;
    if batch.committed then
      if not exists(select 1 from public.portal_parts where batch_id=batch.id and part=(p_body->>'part')::int and digest=p_digest) then raise exception 'PART_CONFLICT'; end if;
      return jsonb_build_object('committed',true,'cursor',p_body->'cursor');
    end if;
  end if;
  if (p_body->'previous'->>'sequence')::bigint <> inst.source_sequence or p_body->'previous'->>'hash' <> inst.source_hash then raise exception 'CURSOR_CONFLICT'; end if;
  if delivery_cursor < inst.source_sequence or (delivery_cursor = inst.source_sequence and p_body->'cursor'->>'hash' <> inst.source_hash) then raise exception 'SOURCE_DIVERGED'; end if;
  if inst.snapshot_at is not null and (p_body->>'generatedAt')::timestamptz < inst.snapshot_at then raise exception 'STALE_SNAPSHOT'; end if;
  if batch.id is null then
    insert into public.portal_batches(id,installation_id,parts,header) values((p_body->>'batchId')::uuid,inst.id,(p_body->>'parts')::int,header);
  end if;
  select digest into existing_digest from public.portal_parts where batch_id=(p_body->>'batchId')::uuid and part=(p_body->>'part')::int;
  if found and existing_digest <> p_digest then raise exception 'PART_CONFLICT'; end if;
  insert into public.portal_parts values((p_body->>'batchId')::uuid,(p_body->>'part')::int,p_digest,p_body->'days') on conflict do nothing;
  if (select count(*) from public.portal_parts where batch_id=(p_body->>'batchId')::uuid) <> (p_body->>'parts')::int then return jsonb_build_object('committed',false); end if;
  if exists(select value->>'id' from public.portal_parts p cross join lateral jsonb_array_elements(p.days) where p.batch_id=(p_body->>'batchId')::uuid group by value->>'id' having count(*)>1) then raise exception 'DUPLICATE_DAY'; end if;
  for item in select value from public.portal_parts p cross join lateral jsonb_array_elements(p.days) where p.batch_id=(p_body->>'batchId')::uuid loop
    insert into public.portal_days values(inst.id,item->>'id',(item->>'date')::date,item)
    on conflict(installation_id,day_id) do update set date=excluded.date,payload=excluded.payload;
  end loop;
  update public.portal_installations set source_sequence=delivery_cursor,source_hash=p_body->'cursor'->>'hash',snapshot_at=(p_body->>'generatedAt')::timestamptz,received_at=now(),metadata=header - 'previous' - 'cursor' - 'batchId' - 'parts' where id=inst.id;
  update public.portal_batches set committed=true where id=(p_body->>'batchId')::uuid;
  -- Old completed batches are no longer needed for retry once their cursor has advanced.
  delete from public.portal_batches where installation_id=inst.id and created_at < now()-interval '7 days' and id<>(p_body->>'batchId')::uuid;
  return jsonb_build_object('committed',true,'cursor',p_body->'cursor');
end;
$$;
revoke all on function public.portal_ingest(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.portal_ingest(jsonb,text,text) to service_role;
