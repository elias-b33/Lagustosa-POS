-- Administration is opt-in per member. Existing read-only accounts stay viewers.
alter table public.portal_members add column role text not null default 'viewer' check(role in ('owner','editor','viewer'));
create table public.portal_management(installation_id uuid primary key references public.portal_installations(id),sequence bigint not null,payload jsonb not null,received_at timestamptz not null default now());
create table public.portal_commands(id uuid primary key,installation_id uuid not null references public.portal_installations(id),created_by uuid not null references auth.users(id),body jsonb not null,status text not null default 'queued' check(status in ('queued','applied','conflict','rejected')),result jsonb,created_at timestamptz not null default now());
create index portal_commands_pending on public.portal_commands(installation_id,created_at) where status='queued';
alter table public.portal_management enable row level security;
alter table public.portal_commands enable row level security;
create policy management_member on public.portal_management for select to authenticated using(exists(select 1 from public.portal_installations i where i.id=installation_id));
create policy commands_member on public.portal_commands for select to authenticated using(exists(select 1 from public.portal_installations i where i.id=installation_id));
grant select on public.portal_management,public.portal_commands to authenticated;
grant all on public.portal_management,public.portal_commands to service_role;

create function public.portal_queue_command(p_installation uuid,p_body jsonb) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare access_role text; command_id uuid; prior portal_commands;
begin
 select m.role into access_role from portal_members m join portal_installations i on i.restaurant_id=m.restaurant_id where i.id=p_installation and i.revoked_at is null and m.user_id=auth.uid() and m.active and auth.jwt()->>'aal'='aal2';
 if access_role is null or access_role='viewer' then raise exception 'UNAUTHORIZED'; end if;
 if p_body->>'kind' in ('restaurant','staff','device','printer','table') and access_role<>'owner' then raise exception 'OWNER_REQUIRED'; end if;
 if p_body->>'kind' not in ('restaurant','product','category','global-category','modifier','coupon','campaign','stock','staff','device','printer','table') or length(p_body::text)>200000 then raise exception 'INVALID_COMMAND'; end if;
 command_id:=(p_body->>'id')::uuid;
 select * into prior from portal_commands where id=command_id;
 if found then
  if prior.installation_id<>p_installation or prior.created_by<>auth.uid() or prior.body<>p_body then raise exception 'KEY_REUSED'; end if;
  return command_id;
 end if;
 if (select count(*) from portal_commands where installation_id=p_installation and status='queued')>=200 then raise exception 'QUEUE_FULL'; end if;
 insert into portal_commands(id,installation_id,created_by,body) values(command_id,p_installation,auth.uid(),p_body);
 return command_id;
end $$;
revoke all on function public.portal_queue_command(uuid,jsonb) from public,anon;
grant execute on function public.portal_queue_command(uuid,jsonb) to authenticated,service_role;

-- The sync identity can only exchange data for its own installation.
create function public.portal_management_exchange(p_installation uuid,p_token_hash text,p_snapshot jsonb default null,p_results jsonb default '[]'::jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare installation portal_installations; item jsonb; queued jsonb; prior portal_commands;
begin
 select * into installation from portal_installations where id=p_installation and token_hash=p_token_hash and revoked_at is null for update;
 if not found then raise exception 'UNAUTHORIZED'; end if;
 if jsonb_array_length(p_results)>20 then raise exception 'INVALID_RESULTS'; end if;
 for item in select value from jsonb_array_elements(p_results) loop
  if item->>'status' not in ('applied','conflict','rejected') or length(item->>'message')>1000 then raise exception 'INVALID_RESULT'; end if;
  select * into prior from portal_commands where id=(item->>'id')::uuid and installation_id=p_installation for update;
  if not found then raise exception 'UNKNOWN_COMMAND'; end if;
  if prior.status<>'queued' and prior.result<>item then raise exception 'RESULT_CONFLICT'; end if;
  update portal_commands set status=item->>'status',result=item where id=prior.id;
 end loop;
 if p_snapshot is not null then
  if p_snapshot->>'schemaVersion'<>'1' or (p_snapshot->>'sequence')::bigint>installation.source_sequence or length(p_snapshot::text)>6000000 then raise exception 'SNAPSHOT_AHEAD'; end if;
  insert into portal_management(installation_id,sequence,payload) values(p_installation,(p_snapshot->>'sequence')::bigint,p_snapshot)
  on conflict(installation_id) do update set sequence=excluded.sequence,payload=excluded.payload,received_at=now()
  where portal_management.sequence<=excluded.sequence and (portal_management.payload->>'generatedAt')::timestamptz<=(excluded.payload->>'generatedAt')::timestamptz;
 end if;
 -- Recheck authors after queuing: revocation prevents execution of queued work.
 update portal_commands c set status='rejected',result=jsonb_build_object('id',c.id,'status','rejected','message','Behörigheten har återkallats.','at',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
 where c.installation_id=p_installation and c.status='queued' and not exists(select 1 from portal_members m where m.restaurant_id=installation.restaurant_id and m.user_id=c.created_by and m.active and m.role in ('owner','editor') and (c.body->>'kind' not in ('restaurant','staff','device','printer','table') or m.role='owner'));
 select coalesce(jsonb_agg(jsonb_build_object('command',body,'actorId',created_by) order by created_at,id),'[]'::jsonb) into queued from (select * from portal_commands where installation_id=p_installation and status='queued' order by created_at,id limit 20) c;
 return queued;
end $$;
revoke all on function public.portal_management_exchange(uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.portal_management_exchange(uuid,text,jsonb,jsonb) to service_role;
