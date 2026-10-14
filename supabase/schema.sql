-- =====================================================================
-- CFS Destuffing Portal — Supabase database schema
-- Run this whole file once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- It is safe to run again later (it updates functions and policies in place).
-- =====================================================================

-- ---------- Roles ----------
do $$ begin
  create type app_role as enum ('pending','superadmin','both','ops','supervisor','readonly','customer');
exception when duplicate_object then null; end $$;

-- ---------- Tables ----------
create table if not exists customers (
  code        text primary key check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  full_name     text not null default '',
  role          app_role not null default 'pending',
  customer_code text references customers(code) on update cascade on delete set null,
  created_at    timestamptz not null default now()
);
-- Login IDs created by the superadmin (no email needed) and disabled flag
alter table profiles add column if not exists username text;
alter table profiles add column if not exists disabled boolean not null default false;
create unique index if not exists profiles_username on profiles (lower(username));

create table if not exists containers (
  id            uuid primary key default gen_random_uuid(),
  container_no  text not null check (length(container_no) between 1 and 20),
  size          text not null default '',
  customer_code text references customers(code) on update cascade on delete restrict,
  consol        text not null default '',
  vessel        text not null default '',
  liner         text not null default '',
  port          text not null default '',
  pnr_date      date,
  igm_no        text not null default '',
  item          text not null default '',
  cfs_arrival   timestamptz,
  status        text not null default 'awaiting' check (status in ('awaiting','queued','in_progress','completed')),
  mode          text check (mode in ('manual','mechanical','combined')),
  bay           text,
  crew          int,
  start_remarks text,
  started_at    timestamptz,
  started_by    uuid references auth.users(id) on delete set null,
  queue_pos     int,
  bypass        jsonb,
  completed_at  timestamptz,
  duration_ms   bigint,
  completed_by  uuid references auth.users(id) on delete set null,
  packages      int,
  end_remarks   text,
  sample        boolean not null default false,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null
);
create unique index if not exists containers_active_no on containers(container_no) where status <> 'completed';
create index if not exists containers_status on containers(status);
create index if not exists containers_customer on containers(customer_code);
create index if not exists containers_completed_at on containers(completed_at);

create table if not exists overrides (
  container_id uuid primary key references containers(id) on delete cascade,
  at           timestamptz not null default now(),
  by           uuid default auth.uid() references auth.users(id) on delete set null,
  reason       text not null check (length(trim(reason)) > 0)
);

create table if not exists audit (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  by           uuid default auth.uid() references auth.users(id) on delete set null,
  action       text not null,
  container_no text not null default '',
  container_id uuid,
  detail       text not null default ''
);
create index if not exists audit_at on audit(at desc);

create table if not exists attachments (
  id               uuid primary key default gen_random_uuid(),
  container_id     uuid not null references containers(id) on delete cascade,
  container_no     text not null default '',
  name             text not null,
  type             text not null default '',
  size             bigint not null default 0,
  path             text not null unique,
  thumb            text,
  stage            text not null default '',
  customer_visible boolean not null default false,
  by               uuid default auth.uid() references auth.users(id) on delete set null,
  at               timestamptz not null default now()
);
create index if not exists attachments_container on attachments(container_id);

-- ---------- Who is calling? (security definer so policies don't recurse) ----------
create or replace function my_role() returns app_role
language sql stable security definer set search_path = public as $$
  select coalesce((select role from profiles where id = auth.uid()), 'pending'::app_role)
$$;
create or replace function my_customer() returns text
language sql stable security definer set search_path = public as $$
  select customer_code from profiles where id = auth.uid() and role = 'customer'
$$;
create or replace function is_staff() returns boolean language sql stable as $$
  select my_role() in ('superadmin','both','ops','supervisor','readonly') $$;
create or replace function can_write() returns boolean language sql stable as $$
  select my_role() in ('superadmin','both','ops','supervisor') $$;
create or replace function can_inv() returns boolean language sql stable as $$
  select my_role() in ('superadmin','both','ops') $$;
create or replace function can_sup() returns boolean language sql stable as $$
  select my_role() in ('superadmin','both','supervisor') $$;
create or replace function is_admin() returns boolean language sql stable as $$
  select my_role() = 'superadmin' $$;

-- ---------- New sign-ups get a profile. The very first account becomes superadmin. ----------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name, username, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''),
          nullif(lower(new.raw_user_meta_data->>'username'), ''),
          case when exists (select 1 from profiles where role = 'superadmin') then 'pending'::app_role else 'superadmin'::app_role end)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- Container guard: direct edits can never touch job/FIFO fields ----------
-- Start / complete / requeue go through the functions below, which run as the table owner.
create or replace function containers_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated','anon') then return new; end if;  -- trusted functions / dashboard

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.container_no := upper(regexp_replace(new.container_no, '[\s-]', '', 'g'));
    if new.sample and is_admin() then return new; end if;   -- superadmin loading example data
    new.sample := false;
    new.created_at := now();
    new.mode := null; new.bay := null; new.crew := null; new.start_remarks := null;
    new.started_at := null; new.started_by := null; new.queue_pos := null; new.bypass := null;
    new.completed_at := null; new.duration_ms := null; new.completed_by := null;
    new.packages := null; new.end_remarks := null;
    new.status := case when new.cfs_arrival is null then 'awaiting' else 'queued' end;
    return new;
  end if;

  -- UPDATE
  if old.status in ('in_progress','completed') then
    raise exception 'Locked: destuffing has already started for %', old.container_no;
  end if;
  if (new.mode, new.bay, new.crew, new.start_remarks, new.started_at, new.started_by, new.queue_pos,
      new.bypass, new.completed_at, new.duration_ms, new.completed_by, new.packages, new.end_remarks,
      new.sample, new.created_at, new.created_by)
     is distinct from
     (old.mode, old.bay, old.crew, old.start_remarks, old.started_at, old.started_by, old.queue_pos,
      old.bypass, old.completed_at, old.duration_ms, old.completed_by, old.packages, old.end_remarks,
      old.sample, old.created_at, old.created_by) then
    raise exception 'Job details can only change through Start / Complete';
  end if;
  if old.cfs_arrival is not null and new.cfs_arrival is distinct from old.cfs_arrival and not is_admin() then
    raise exception 'Only a superadmin can change a saved CFS arrival time (it sets the FIFO position)';
  end if;
  new.container_no := upper(regexp_replace(new.container_no, '[\s-]', '', 'g'));
  new.status := case when new.cfs_arrival is null then 'awaiting' else 'queued' end;
  return new;
end $$;
drop trigger if exists containers_guard on containers;
create trigger containers_guard before insert or update on containers
  for each row execute function containers_guard();

-- ---------- FIFO order (single source of truth) ----------
create or replace function fifo_queue()
returns table (container_id uuid, pos int, total int)
language sql stable security definer set search_path = public as $$
  select c.id,
         (row_number() over (order by (o.container_id is null), o.at, c.cfs_arrival, c.created_at, c.container_no))::int,
         (count(*) over ())::int
  from containers c left join overrides o on o.container_id = c.id
  where c.status = 'queued'
$$;
revoke execute on function fifo_queue() from public, anon;

-- ---------- Job actions (strict FIFO enforced here, on the server) ----------
create or replace function start_job(p_id uuid, p_mode text, p_bay text default '', p_crew int default null,
                                     p_remarks text default '', p_reason text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_role app_role := my_role(); v_c containers; v_pos int;
begin
  if v_role not in ('superadmin','both','supervisor') then raise exception 'Your role cannot start destuffing jobs.'; end if;
  if p_mode is null or p_mode not in ('manual','mechanical','combined') then raise exception 'Choose a destuffing mode first.'; end if;
  perform pg_advisory_xact_lock(7311001);              -- one start at a time, so two supervisors can't race
  select * into v_c from containers where id = p_id for update;
  if not found or v_c.status <> 'queued' then raise exception 'This container is no longer in the queue.'; end if;
  select q.pos into v_pos from fifo_queue() q where q.container_id = p_id;
  if v_pos > 1 then
    if v_role <> 'superadmin' then raise exception 'FIFO is locked. Only a superadmin can start a container out of turn.'; end if;
    if coalesce(trim(p_reason), '') = '' then raise exception 'Enter the reason for bypassing FIFO.'; end if;
  end if;
  update containers set status = 'in_progress', mode = p_mode, bay = coalesce(trim(p_bay), ''), crew = p_crew,
         start_remarks = coalesce(trim(p_remarks), ''), started_at = now(), started_by = auth.uid(), queue_pos = v_pos,
         bypass = case when v_pos > 1 then jsonb_build_object('reason', trim(p_reason), 'by', auth.uid(), 'at', now(), 'skipped', v_pos - 1) end
   where id = p_id;
  delete from overrides where container_id = p_id;
  insert into audit (by, action, container_no, container_id, detail)
  values (auth.uid(),
          case when v_pos > 1 then 'Started out of turn (FIFO bypass)' else 'Destuffing started' end,
          v_c.container_no, p_id,
          (case p_mode when 'manual' then 'Manual' when 'mechanical' then 'Mechanical' else 'Manual + Mechanical' end)
          || case when coalesce(trim(p_bay), '') <> '' then ' · ' || trim(p_bay) else '' end
          || case when v_pos > 1 then ' · skipped ' || (v_pos - 1) || ' · ' || trim(p_reason) else '' end);
  return jsonb_build_object('position', v_pos);
end $$;

create or replace function complete_job(p_id uuid, p_packages int default null, p_remarks text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_c containers; v_ms bigint;
begin
  if not can_sup() then raise exception 'Your role cannot close jobs.'; end if;
  select * into v_c from containers where id = p_id for update;
  if not found or v_c.status <> 'in_progress' then raise exception 'This job is not running.'; end if;
  v_ms := (extract(epoch from (now() - v_c.started_at)) * 1000)::bigint;
  update containers set status = 'completed', completed_at = now(), duration_ms = v_ms, completed_by = auth.uid(),
         packages = p_packages, end_remarks = coalesce(trim(p_remarks), '')
   where id = p_id;
  insert into audit (by, action, container_no, container_id, detail)
  values (auth.uid(), 'Destuffing completed', v_c.container_no, p_id, round(v_ms / 60000.0) || ' min');
  return jsonb_build_object('duration_ms', v_ms);
end $$;

create or replace function requeue_job(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_c containers;
begin
  if not is_admin() then raise exception 'Only a superadmin can return a running job to the queue.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Enter a reason.'; end if;
  select * into v_c from containers where id = p_id for update;
  if not found or v_c.status <> 'in_progress' then raise exception 'This job is not running.'; end if;
  update containers set status = 'queued', mode = null, bay = null, crew = null, start_remarks = null,
         started_at = null, started_by = null, queue_pos = null, bypass = null where id = p_id;
  insert into audit (by, action, container_no, container_id, detail)
  values (auth.uid(), 'Returned to queue', v_c.container_no, p_id,
          'Clock discarded after ' || round(extract(epoch from now() - v_c.started_at) / 60) || ' min · ' || trim(p_reason));
end $$;

-- ---------- Customer read access (only their own containers, limited columns) ----------
create or replace function customer_containers(p_days int default 60)
returns table (id uuid, container_no text, size text, consol text, vessel text, liner text, port text,
               pnr_date date, igm_no text, item text, cfs_arrival timestamptz, status text,
               queue_position int, queue_total int, mode text, started_at timestamptz,
               completed_at timestamptz, duration_ms bigint, packages int, files int)
language sql stable security definer set search_path = public as $$
  select c.id, c.container_no, c.size, c.consol, c.vessel, c.liner, c.port, c.pnr_date, c.igm_no, c.item,
         c.cfs_arrival, c.status, q.pos, q.total, c.mode, c.started_at, c.completed_at, c.duration_ms, c.packages,
         (select count(*)::int from attachments a where a.container_id = c.id and a.customer_visible)
  from containers c
  left join fifo_queue() q on q.container_id = c.id
  where c.customer_code is not null
    and c.customer_code = my_customer()
    and (c.status <> 'completed' or c.completed_at > now() - make_interval(days => least(greatest(p_days, 1), 366)))
  order by case c.status when 'in_progress' then 0 when 'queued' then 1 when 'awaiting' then 2 else 3 end,
           q.pos nulls last, c.completed_at desc nulls last, c.created_at
$$;

create or replace function customer_attachments(p_container uuid)
returns table (id uuid, name text, type text, size bigint, path text, thumb text, at timestamptz)
language sql stable security definer set search_path = public as $$
  select a.id, a.name, a.type, a.size, a.path, a.thumb, a.at
  from attachments a join containers c on c.id = a.container_id
  where a.container_id = p_container and a.customer_visible
    and c.customer_code is not null and c.customer_code = my_customer()
  order by a.at
$$;

create or replace function customer_can_read_object(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from attachments a join containers c on c.id = a.container_id
                 where a.path = p_path and a.customer_visible
                   and c.customer_code is not null and c.customer_code = my_customer())
$$;

-- ---------- Row-level security ----------
alter table customers   enable row level security;
alter table profiles    enable row level security;
alter table containers  enable row level security;
alter table overrides   enable row level security;
alter table audit       enable row level security;
alter table attachments enable row level security;

drop policy if exists customers_read  on customers;
drop policy if exists customers_write on customers;
create policy customers_read  on customers for select to authenticated using (is_staff() or code = my_customer());
create policy customers_write on customers for all    to authenticated using (is_admin()) with check (is_admin());

drop policy if exists profiles_read  on profiles;
drop policy if exists profiles_admin on profiles;
create policy profiles_read  on profiles for select to authenticated using (id = auth.uid() or is_staff());
create policy profiles_admin on profiles for update to authenticated using (is_admin()) with check (is_admin());

drop policy if exists containers_read   on containers;
drop policy if exists containers_insert on containers;
drop policy if exists containers_update on containers;
drop policy if exists containers_delete on containers;
create policy containers_read   on containers for select to authenticated using (is_staff());
create policy containers_insert on containers for insert to authenticated with check (can_inv());
create policy containers_update on containers for update to authenticated using (can_inv()) with check (can_inv());
create policy containers_delete on containers for delete to authenticated using (
  (can_inv() and status = 'awaiting') or (is_admin() and (status = 'queued' or sample)));

drop policy if exists overrides_read  on overrides;
drop policy if exists overrides_write on overrides;
create policy overrides_read  on overrides for select to authenticated using (is_staff());
create policy overrides_write on overrides for all    to authenticated using (is_admin()) with check (is_admin());

drop policy if exists audit_read   on audit;
drop policy if exists audit_insert on audit;
create policy audit_read   on audit for select to authenticated using (is_staff());
create policy audit_insert on audit for insert to authenticated with check (can_write() and by = auth.uid());

drop policy if exists attachments_read   on attachments;
drop policy if exists attachments_insert on attachments;
drop policy if exists attachments_update on attachments;
drop policy if exists attachments_delete on attachments;
create policy attachments_read   on attachments for select to authenticated using (is_staff());
create policy attachments_insert on attachments for insert to authenticated with check (can_write() and by = auth.uid());
create policy attachments_update on attachments for update to authenticated using (can_write()) with check (can_write());
create policy attachments_delete on attachments for delete to authenticated using (is_admin() or by = auth.uid() or can_inv());

-- Profiles: nobody but a superadmin may change role / customer link (policy above); block self-escalation via insert.
revoke insert, delete on profiles from authenticated, anon;

-- Functions callable by signed-in users only
revoke execute on function start_job(uuid, text, text, int, text, text), complete_job(uuid, int, text),
  requeue_job(uuid, text), customer_containers(int), customer_attachments(uuid), customer_can_read_object(text)
  from public, anon;
grant execute on function start_job(uuid, text, text, int, text, text), complete_job(uuid, int, text),
  requeue_job(uuid, text), customer_containers(int), customer_attachments(uuid), customer_can_read_object(text)
  to authenticated;

-- ---------- File storage for photos & files ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

drop policy if exists cfs_att_read   on storage.objects;
drop policy if exists cfs_att_insert on storage.objects;
drop policy if exists cfs_att_delete on storage.objects;
create policy cfs_att_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (is_staff() or customer_can_read_object(name)));
create policy cfs_att_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and can_write());
create policy cfs_att_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and can_write());

-- ---------- Live updates ----------
do $$
declare t text;
begin
  foreach t in array array['containers','overrides','attachments','audit','profiles','customers'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
