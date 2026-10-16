-- Start window: the first N containers in the queue can be started at the same time.
-- Paste into Supabase → SQL Editor → New Snippet → Run. Safe to run more than once.
create table if not exists public.settings (
  id           int primary key default 1 check (id = 1),
  start_window int not null default 5 check (start_window between 1 and 50),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);
insert into public.settings (id) values (1) on conflict (id) do nothing;
alter table public.settings enable row level security;
do $$ begin
  create policy settings_read  on public.settings for select to authenticated using (is_staff());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy settings_write on public.settings for update to authenticated using (is_admin()) with check (is_admin());
exception when duplicate_object then null; end $$;

create or replace function public.can_sup() returns boolean language sql stable set search_path = public as $$
  select my_role() in ('superadmin','both','ops','supervisor') $$;

create or replace function public.start_job(p_id uuid, p_mode text, p_bay text default '', p_crew int default null,
                                     p_remarks text default '', p_reason text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_role app_role := my_role(); v_c containers; v_pos int; v_win int;
begin
  if not can_sup() then raise exception 'Your role cannot start destuffing jobs.'; end if;
  if p_mode is null or p_mode not in ('manual','mechanical','combined') then raise exception 'Choose a destuffing mode first.'; end if;
  perform pg_advisory_xact_lock(7311001);
  select * into v_c from containers where id = p_id for update;
  if not found or v_c.status <> 'queued' then raise exception 'This container was just started by someone else, or is no longer in the queue. Pick the next one.'; end if;
  if v_c.on_hold then raise exception 'This container is on hold. Release the hold first.'; end if;
  select q.pos into v_pos from fifo_queue() q where q.container_id = p_id;
  v_win := coalesce((select start_window from settings where id = 1), 1);
  if v_pos > v_win then
    if v_role <> 'superadmin' then raise exception 'FIFO is locked: only the first % containers in the queue can be started. Only a superadmin can start this one out of turn.', v_win; end if;
    if coalesce(trim(p_reason), '') = '' then raise exception 'Enter the reason for bypassing FIFO.'; end if;
  end if;
  update containers set status = 'in_progress', mode = p_mode, bay = coalesce(trim(p_bay), ''), crew = p_crew,
         start_remarks = coalesce(trim(p_remarks), ''), started_at = now(), started_by = auth.uid(), queue_pos = v_pos,
         bypass = case when v_pos > v_win then jsonb_build_object('reason', trim(p_reason), 'by', auth.uid(), 'at', now(), 'skipped', v_pos - v_win, 'window', v_win) end
   where id = p_id;
  delete from overrides where container_id = p_id;
  insert into audit (by, action, container_no, container_id, detail)
  values (auth.uid(),
          case when v_pos > v_win then 'Started out of turn (FIFO bypass)' else 'Destuffing started' end,
          v_c.container_no, p_id,
          (case p_mode when 'manual' then 'Manual' when 'mechanical' then 'Mechanical' else 'Manual + Mechanical' end)
          || case when coalesce(trim(p_bay), '') <> '' then ' · ' || trim(p_bay) else '' end
          || ' · position ' || v_pos
          || case when v_pos > v_win then ' · outside the first ' || v_win || ' · ' || trim(p_reason) else '' end);
  return jsonb_build_object('position', v_pos);
end $$;
