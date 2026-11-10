-- ICD page: a separate sheet of containers sent to the ICD, each with optional photos.
-- Adds two new tables only; nothing existing is changed.
create table if not exists icd_rows (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity,
  container_no  text not null default '',
  truck_no      text not null default '',
  size          text not null default '',
  destination   text not null default '',
  stuffing_date date,
  packages      integer check (packages is null or packages >= 0),
  remarks       text not null default '',
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now()
);
create index if not exists icd_rows_seq on icd_rows(seq desc);

create table if not exists icd_photos (
  id      uuid primary key default gen_random_uuid(),
  row_id  uuid not null references icd_rows(id) on delete cascade,
  name    text not null,
  type    text not null default 'image/jpeg',
  size    bigint not null default 0,
  path    text not null unique,
  thumb   text,
  by      uuid default auth.uid() references auth.users(id) on delete set null,
  at      timestamptz not null default now()
);
create index if not exists icd_photos_row on icd_photos(row_id);

create or replace function icd_touch() returns trigger language plpgsql set search_path = public as $$
begin
  new.container_no := upper(regexp_replace(coalesce(new.container_no, ''), '[\s-]', '', 'g'));
  new.updated_at := now(); new.updated_by := coalesce(auth.uid(), new.updated_by);
  if tg_op = 'UPDATE' then new.created_by := old.created_by; new.created_at := old.created_at; end if;
  return new;
end $$;
drop trigger if exists icd_rows_touch on icd_rows;
create trigger icd_rows_touch before insert or update on icd_rows for each row execute function icd_touch();

alter table icd_rows enable row level security;
alter table icd_photos enable row level security;
drop policy if exists icd_rows_read on icd_rows;   drop policy if exists icd_rows_insert on icd_rows;
drop policy if exists icd_rows_update on icd_rows; drop policy if exists icd_rows_delete on icd_rows;
create policy icd_rows_read   on icd_rows for select to authenticated using (is_staff());
create policy icd_rows_insert on icd_rows for insert to authenticated with check (can_write());
create policy icd_rows_update on icd_rows for update to authenticated using (can_write()) with check (can_write());
create policy icd_rows_delete on icd_rows for delete to authenticated using (is_admin() or (can_write() and created_by = auth.uid()));
drop policy if exists icd_photos_read on icd_photos; drop policy if exists icd_photos_insert on icd_photos; drop policy if exists icd_photos_delete on icd_photos;
create policy icd_photos_read   on icd_photos for select to authenticated using (is_staff());
create policy icd_photos_insert on icd_photos for insert to authenticated with check (can_write() and by = auth.uid());
create policy icd_photos_delete on icd_photos for delete to authenticated using (is_admin() or (can_write() and by = auth.uid()) or can_inv());

do $$ declare t text; begin
  foreach t in array array['icd_rows','icd_photos'] loop
    begin execute format('alter publication supabase_realtime add table %I', t); exception when duplicate_object then null; end;
  end loop;
end $$;
