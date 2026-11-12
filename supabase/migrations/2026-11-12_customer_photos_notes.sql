-- Customer portal: every photo on the customer's own containers is visible to them (other files still need
-- "Customer can see"), and the start / completion remarks are shown as notes. Run once in the SQL editor.
drop function if exists customer_containers(int);
create or replace function customer_containers(p_days int default 60)
returns table (id uuid, container_no text, size text, consol text, vessel text, liner text, port text,
               pnr_date date, igm_no text, item text, cfs_arrival timestamptz, status text,
               queue_position int, queue_total int, on_hold boolean, my_rank int, mode text, started_at timestamptz,
               completed_at timestamptz, duration_ms bigint, packages int, files int, photos int,
               start_remarks text, end_remarks text)
language sql stable security definer set search_path = public as $$
  select c.id, c.container_no, c.size, c.consol, c.vessel, c.liner, c.port, c.pnr_date, c.igm_no, c.item,
         c.cfs_arrival, c.status, q.pos, q.total, c.on_hold, c.customer_rank, c.mode, c.started_at, c.completed_at, c.duration_ms, c.packages,
         (select count(*)::int from attachments a where a.container_id = c.id and (a.customer_visible or a.type like 'image/%')),
         (select count(*)::int from attachments a where a.container_id = c.id and a.type like 'image/%'),
         nullif(trim(c.start_remarks), ''), nullif(trim(c.end_remarks), '')
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
  where a.container_id = p_container and (a.customer_visible or a.type like 'image/%')
    and c.customer_code is not null and c.customer_code = my_customer()
  order by a.at
$$;
create or replace function customer_can_read_object(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from attachments a join containers c on c.id = a.container_id
                 where a.path = p_path and (a.customer_visible or a.type like 'image/%')
                   and c.customer_code is not null and c.customer_code = my_customer())
$$;
revoke execute on function customer_containers(int), customer_attachments(uuid), customer_can_read_object(text) from public, anon;
grant execute on function customer_containers(int), customer_attachments(uuid), customer_can_read_object(text) to authenticated;
