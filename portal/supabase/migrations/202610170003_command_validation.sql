-- Reject malformed direct RPC calls before they reach the POS queue.
create or replace function public.portal_queue_command(p_installation uuid,p_body jsonb) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare access_role text; command_id uuid; prior portal_commands;
begin
 select m.role into access_role from portal_members m join portal_installations i on i.restaurant_id=m.restaurant_id where i.id=p_installation and i.revoked_at is null and m.user_id=auth.uid() and m.active and auth.jwt()->>'aal'='aal2';
 if access_role is null or access_role='viewer' then raise exception 'UNAUTHORIZED'; end if;
 if p_body->>'kind' in ('restaurant','staff','device','printer','table') and access_role<>'owner' then raise exception 'OWNER_REQUIRED'; end if;
 if jsonb_typeof(p_body) is distinct from 'object'
   or (select count(*) from jsonb_object_keys(p_body)) <> 5
   or not (p_body ?& array['id','kind','target','baseVersion','value'])
   or jsonb_typeof(p_body->'kind') is distinct from 'string'
   or jsonb_typeof(p_body->'target') is distinct from 'string'
   or length(p_body->>'target') not between 1 and 100
   or not (p_body->'baseVersion'='null'::jsonb or (jsonb_typeof(p_body->'baseVersion')='string' and p_body->>'baseVersion' ~ '^[a-f0-9]{64}$'))
   or jsonb_typeof(p_body->'value') is distinct from 'object' then raise exception 'INVALID_COMMAND'; end if;
 if p_body->>'kind' not in ('restaurant','product','category','global-category','modifier','coupon','campaign','stock','staff','device','printer','table') or length(p_body::text)>200000 then raise exception 'INVALID_COMMAND'; end if;
 command_id:=(p_body->>'id')::uuid;
 select * into prior from portal_commands where id=command_id;
 if found then
  if prior.installation_id<>p_installation or prior.created_by<>auth.uid() or prior.body<>p_body then raise exception 'KEY_REUSED'; end if;
  return command_id;
 end if;
 -- Serialize capacity checks for this installation, including concurrent RPC callers.
 perform 1 from portal_installations where id=p_installation for update;
 if (select count(*) from portal_commands where installation_id=p_installation and status='queued')>=200 then raise exception 'QUEUE_FULL'; end if;
 insert into portal_commands(id,installation_id,created_by,body) values(command_id,p_installation,auth.uid(),p_body);
 return command_id;
end $$;
revoke all on function public.portal_queue_command(uuid,jsonb) from public,anon;
grant execute on function public.portal_queue_command(uuid,jsonb) to authenticated,service_role;
