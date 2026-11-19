-- =====================================================================
-- Purchase Order App — database, part 1
-- Login & roles, warehouses, item master, sales upload, stock upload.
--
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: it only creates what is missing and replaces functions.
-- =====================================================================

set client_min_messages = warning;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- "Amlopres-AT Tablet " and "amlopres at tablet" become the same key,
-- so spelling/space/capital differences don't split one medicine in two.
create or replace function public.norm_text(t text)
returns text language sql immutable parallel safe as $$
  select lower(regexp_replace(coalesce(t, ''), '[^a-zA-Z0-9]', '', 'g'))
$$;

-- ---------------------------------------------------------------------
-- Users and roles
--   pending  : signed up, waiting for Admin to give a role (sees nothing)
--   admin    : everything, manages users / warehouses / item master
--   manager  : sales upload, purchase upload, reports
--   purchase : stock upload, order suggestions, order sheets
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'pending'
             check (role in ('pending', 'admin', 'manager', 'purchase')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Every new sign-up gets a profile. The very first person becomes Admin;
-- everyone after that waits as 'pending' until an Admin approves them.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles where role = 'admin') then 'pending' else 'admin' end
  )
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid() and active
$$;

create or replace function public.has_role(variadic roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = any(roles), false)
$$;

-- any approved user
create or replace function public.is_staff()
returns boolean language sql stable as $$
  select public.has_role('admin', 'manager', 'purchase')
$$;

-- ---------------------------------------------------------------------
-- Settings (Admin edits from the screen)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  key         text primary key,
  value       text not null,
  description text
);

insert into public.settings (key, value, description) values
  ('sales_keep_days', '400',
   'Bill lines older than this many days are not kept. The analysis looks back 360 days at most.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Warehouses
-- ---------------------------------------------------------------------
create table if not exists public.warehouses (
  id         integer generated always as identity primary key,
  name       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.warehouses (name) values ('Gaur City'), ('Sect 101'), ('Indirapuram')
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- Item master
--   One row per medicine + pack size. loose_per_strip comes from the
--   Strips sheet (Zincovit Tablet, 15 Tablet -> 15).
-- ---------------------------------------------------------------------
create table if not exists public.items (
  id              integer generated always as identity primary key,
  name            text not null,
  pack_size       text not null default '',
  norm_key        text generated always as
                  (public.norm_text(name) || '|' || public.norm_text(pack_size)) stored unique,
  loose_per_strip numeric(10,3) check (loose_per_strip > 0),
  status          text not null default 'active' check (status in ('active', 'discontinued')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists items_touch on public.items;
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();

-- A tablet/capsule pack whose number doesn't match Qty in Loose
-- ("10 Capsules" but 1) is almost always a typing mistake.
create or replace function public.conversion_problem(p_pack text, p_loose numeric)
returns text language sql immutable as $$
  select case
    when p_loose is null then 'No conversion'
    when p_pack ~* '^\s*[0-9.]+\s*(tablet|tablets|capsule|capsules)\s*$'
     and (regexp_match(p_pack, '^\s*([0-9]+(\.[0-9]+)?)'))[1]::numeric <> p_loose
      then 'Qty in Loose does not match pack size'
  end
$$;

create or replace view public.items_to_check with (security_invoker = true) as
select i.id, i.name, i.pack_size, i.loose_per_strip,
       public.conversion_problem(i.pack_size, i.loose_per_strip) as problem
from public.items i
where i.status = 'active' and public.conversion_problem(i.pack_size, i.loose_per_strip) is not null;

-- ---------------------------------------------------------------------
-- Customers: mobile numbers live only here, and only Admin can read
-- this table. Sales lines keep a customer number, never the mobile.
-- ---------------------------------------------------------------------
create table if not exists public.customers (
  id     integer generated always as identity primary key,
  mobile text not null unique
);

-- ---------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------
create table if not exists public.sales_uploads (
  id             bigint generated always as identity primary key,
  warehouse_id   integer not null references public.warehouses(id),
  uploaded_by    uuid references auth.users(id) default auth.uid(),
  file_name      text,
  first_date     date,
  last_date      date,
  rows_in_file   integer not null default 0,
  rows_saved     integer not null default 0,
  rows_already   integer not null default 0,   -- already uploaded earlier, skipped
  rows_too_old   integer not null default 0,   -- older than sales_keep_days
  rows_skipped   integer not null default 0,   -- blank / zero / return lines
  status         text not null default 'running' check (status in ('running', 'done', 'failed')),
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);

-- One line per medicine per bill. The primary key doubles as the
-- duplicate check, so uploading an overlapping file never counts twice.
-- Kept deliberately narrow so 7 warehouses fit the free 500 MB.
create table if not exists public.sales_lines (
  warehouse_id integer not null references public.warehouses(id),
  sale_date    date    not null,
  bill_no      text    not null,
  sale_time    time,                -- for hourly sales analysis
  item_id      integer not null references public.items(id),
  customer_id  integer references public.customers(id),
  qty          numeric(10,3) not null,
  amount       numeric(12,2),
  primary key (warehouse_id, sale_date, bill_no, item_id)
);

-- "Sales uploaded up to" for every warehouse
create or replace function public.sales_status()
returns table (warehouse_id integer, warehouse text, first_date date, last_date date,
               last_upload_at timestamptz, last_upload_by text)
language sql stable security definer set search_path = public as $$
  select w.id, w.name,
         (select min(s.sale_date) from sales_lines s where s.warehouse_id = w.id),
         (select max(s.sale_date) from sales_lines s where s.warehouse_id = w.id),
         u.created_at, p.full_name
  from warehouses w
  left join lateral (
    select su.created_at, su.uploaded_by from sales_uploads su
    where su.warehouse_id = w.id and su.status = 'done'
    order by su.created_at desc limit 1) u on true
  left join profiles p on p.user_id = u.uploaded_by
  where w.active and public.is_staff()
  order by w.name
$$;

create or replace function public.start_sales_upload(p_warehouse_id integer, p_file_name text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not public.has_role('admin', 'manager') then
    raise exception 'Only Admin or Manager can upload sales';
  end if;
  if not exists (select 1 from warehouses where id = p_warehouse_id and active) then
    raise exception 'Unknown warehouse';
  end if;
  insert into sales_uploads (warehouse_id, uploaded_by, file_name)
  values (p_warehouse_id, auth.uid(), p_file_name) returning id into v_id;
  return v_id;
end $$;

-- p_rows: [{"d":"2026-11-08","t":"14:35:22","b":"2143","m":"9876543210","n":"Dolo 650 Tablet",
--           "p":"15 Tablet","q":2,"a":64.5}, ...]   (send ~2,000 rows per call)
create or replace function public.import_sales_batch(p_upload_id bigint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_wh integer; v_cut date;
  v_total integer; v_old integer; v_bad integer; v_lines integer; v_saved integer;
begin
  if not public.has_role('admin', 'manager') then
    raise exception 'Only Admin or Manager can upload sales';
  end if;
  select warehouse_id into v_wh from sales_uploads where id = p_upload_id and status = 'running';
  if v_wh is null then raise exception 'Upload % is not open', p_upload_id; end if;

  v_cut := current_date - coalesce((select value::int from settings where key = 'sales_keep_days'), 400);

  create temp table _rows on commit drop as
  select nullif(r ->> 'd', '')::date                                     as d,
         nullif(r ->> 't', '')::time                                     as t,
         nullif(trim(r ->> 'b'), '')                                     as b,
         nullif(regexp_replace(coalesce(r ->> 'm', ''), '\D', '', 'g'), '') as m,
         nullif(trim(r ->> 'n'), '')                                     as n,
         coalesce(trim(r ->> 'p'), '')                                   as p,
         nullif(r ->> 'q', '')::numeric                                  as q,
         nullif(r ->> 'a', '')::numeric                                  as a
  from jsonb_array_elements(p_rows) r;

  select count(*) into v_total from _rows;
  select count(*) into v_old from _rows where d is not null and d < v_cut;
  delete from _rows where d is not null and d < v_cut;
  select count(*) into v_bad from _rows where d is null or b is null or n is null or q is null or q <= 0;
  delete from _rows where d is null or b is null or n is null or q is null or q <= 0;

  -- new medicines go into the item master (without a conversion yet)
  insert into items (name, pack_size)
  select distinct on (public.norm_text(n) || '|' || public.norm_text(p)) n, p
  from _rows
  on conflict (norm_key) do nothing;

  insert into customers (mobile)
  select distinct m from _rows where m is not null
  on conflict (mobile) do nothing;

  -- the same medicine twice on one bill (e.g. two spellings) is added up
  with grouped as (
    select r.d, r.b, i.id as item_id, min(r.t) as t, max(c.id) as customer_id, sum(r.q) as q, sum(r.a) as a
    from _rows r
    join items i on i.norm_key = public.norm_text(r.n) || '|' || public.norm_text(r.p)
    left join customers c on c.mobile = r.m
    group by r.d, r.b, i.id
  ), ins as (
    insert into sales_lines (warehouse_id, sale_date, bill_no, item_id, sale_time, customer_id, qty, amount)
    select v_wh, d, b, item_id, t, customer_id, q, a from grouped
    on conflict do nothing
    returning 1
  )
  select (select count(*) from grouped), (select count(*) from ins) into v_lines, v_saved;

  update sales_uploads set
    rows_in_file = rows_in_file + v_total,
    rows_saved   = rows_saved + v_saved,
    rows_already = rows_already + (v_lines - v_saved),
    rows_too_old = rows_too_old + v_old,
    rows_skipped = rows_skipped + v_bad,
    first_date   = least(first_date, (select min(d) from _rows)),
    last_date    = greatest(last_date, (select max(d) from _rows))
  where id = p_upload_id;

  return jsonb_build_object('rows', v_total, 'saved', v_saved, 'already', v_lines - v_saved,
                            'too_old', v_old, 'skipped', v_bad);
end $$;

create or replace function public.finish_sales_upload(p_upload_id bigint, p_ok boolean default true)
returns sales_uploads language plpgsql security definer set search_path = public as $$
declare v sales_uploads;
begin
  if not public.has_role('admin', 'manager') then raise exception 'Not allowed'; end if;
  update sales_uploads
     set status = case when p_ok then 'done' else 'failed' end, finished_at = now()
   where id = p_upload_id and status = 'running'
  returning * into v;
  return v;
end $$;

-- Deletes bill lines older than sales_keep_days. Run daily (the GitHub
-- job does this) or by hand from the SQL editor.
create or replace function public.purge_old_sales()
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if auth.uid() is not null and not public.has_role('admin') then raise exception 'Not allowed'; end if;
  delete from sales_lines
  where sale_date < current_date - coalesce((select value::int from settings where key = 'sales_keep_days'), 400);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Stock (Purchase Team uploads: Medicine Name, Pack Size, Stock in Loose)
-- Only the loose count is stored. Strips are worked out when read, so
-- fixing a conversion in the item master fixes the stock straight away.
-- ---------------------------------------------------------------------
create table if not exists public.stock_uploads (
  id           bigint generated always as identity primary key,
  warehouse_id integer not null references public.warehouses(id),
  uploaded_by  uuid references auth.users(id) default auth.uid(),
  file_name    text,
  rows_in_file integer not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists public.stock_lines (
  upload_id bigint  not null references public.stock_uploads(id) on delete cascade,
  item_id   integer not null references public.items(id),
  loose_qty numeric(12,3) not null,
  primary key (upload_id, item_id)
);

-- p_rows: [{"n":"Zincovit Tablet","p":"15 Tablet","l":45}, ...]
create or replace function public.import_stock(p_warehouse_id integer, p_file_name text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_total integer; v_bad integer; v_new integer;
begin
  if not public.has_role('admin', 'purchase') then
    raise exception 'Only Admin or Purchase Team can upload stock';
  end if;
  if not exists (select 1 from warehouses where id = p_warehouse_id and active) then
    raise exception 'Unknown warehouse';
  end if;

  create temp table _st on commit drop as
  select nullif(trim(r ->> 'n'), '') as n, coalesce(trim(r ->> 'p'), '') as p,
         nullif(r ->> 'l', '')::numeric as l
  from jsonb_array_elements(p_rows) r;

  select count(*) into v_total from _st;
  select count(*) into v_bad from _st where n is null or l is null or l < 0;
  delete from _st where n is null or l is null or l < 0;

  with ins as (
    insert into items (name, pack_size)
    select distinct on (public.norm_text(n) || '|' || public.norm_text(p)) n, p from _st
    on conflict (norm_key) do nothing returning 1)
  select count(*) into v_new from ins;

  insert into stock_uploads (warehouse_id, uploaded_by, file_name, rows_in_file)
  values (p_warehouse_id, auth.uid(), p_file_name, v_total) returning id into v_id;

  insert into stock_lines (upload_id, item_id, loose_qty)
  select v_id, i.id, sum(s.l)
  from _st s join items i on i.norm_key = public.norm_text(s.n) || '|' || public.norm_text(s.p)
  group by i.id;

  return jsonb_build_object('upload_id', v_id, 'rows', v_total, 'skipped', v_bad, 'new_items', v_new,
    'lines', (select count(*) from stock_lines where upload_id = v_id),
    'no_conversion', (select count(*) from stock_lines sl join items i on i.id = sl.item_id
                      where sl.upload_id = v_id and i.loose_per_strip is null and sl.loose_qty > 0));
end $$;

-- Latest stock for each warehouse, converted to strips.
create or replace view public.latest_stock with (security_invoker = true) as
with last_upload as (
  select distinct on (warehouse_id) id, warehouse_id, created_at
  from public.stock_uploads order by warehouse_id, created_at desc
)
select lu.warehouse_id, lu.id as upload_id, lu.created_at as counted_at,
       i.id as item_id, i.name, i.pack_size, i.loose_per_strip, sl.loose_qty,
       case when i.loose_per_strip is not null then round(sl.loose_qty / i.loose_per_strip, 3) end as strips,
       case when i.loose_per_strip is not null then floor(sl.loose_qty / i.loose_per_strip) end as full_strips,
       case when i.loose_per_strip is not null
            then sl.loose_qty - floor(sl.loose_qty / i.loose_per_strip) * i.loose_per_strip end as extra_loose,
       coalesce(case when sl.loose_qty > 0 then public.conversion_problem(i.pack_size, i.loose_per_strip) end, 'OK') as flag,
       (sl.loose_qty > 0 and public.conversion_problem(i.pack_size, i.loose_per_strip) is not null) as attention
from last_upload lu
join public.stock_lines sl on sl.upload_id = lu.id
join public.items i on i.id = sl.item_id;

-- ---------------------------------------------------------------------
-- Item master upload (the Strips sheet: Item Name, Pack Size, Qty in Loose)
-- ---------------------------------------------------------------------
-- p_rows: [{"n":"Zincovit Tablet","p":"15 Tablet","l":15}, ...]
-- Same item listed twice with different values is NOT loaded; it is
-- returned in "conflicts" so someone decides which value is right.
create or replace function public.import_item_master(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_total integer; v_added integer; v_updated integer;
begin
  if not public.has_role('admin') then raise exception 'Only Admin can change the item master'; end if;

  create temp table _im on commit drop as
  select nullif(trim(r ->> 'n'), '') as n, coalesce(trim(r ->> 'p'), '') as p,
         nullif(r ->> 'l', '')::numeric as l
  from jsonb_array_elements(p_rows) r;
  select count(*) into v_total from _im;
  delete from _im where n is null;

  create temp table _imk on commit drop as
  select public.norm_text(n) || '|' || public.norm_text(p) as k,
         min(n) as n, min(p) as p,
         count(distinct l) filter (where l > 0) as nvals,
         max(l) filter (where l > 0) as l,
         string_agg(distinct l::text, ' / ') as vals
  from _im group by 1;

  with ins as (
    insert into items (name, pack_size, loose_per_strip)
    select n, p, case when nvals = 1 then l end from _imk
    on conflict (norm_key) do nothing returning 1)
  select count(*) into v_added from ins;

  with upd as (
    update items i set loose_per_strip = k.l
    from _imk k
    where i.norm_key = k.k and k.nvals = 1 and i.loose_per_strip is distinct from k.l
    returning 1)
  select count(*) into v_updated from upd;

  return jsonb_build_object(
    'rows', v_total, 'added', v_added, 'conversion_set', v_updated,
    'conflicts', coalesce((select jsonb_agg(jsonb_build_object('name', n, 'pack', p, 'values', vals))
                           from _imk where nvals > 1), '[]'::jsonb));
end $$;


-- Items needing a conversion fix, busiest first, so the ones that
-- matter for ordering get fixed first.
create or replace function public.items_needing_check()
returns table (id integer, name text, pack_size text, loose_per_strip numeric, problem text,
               sold_90d numeric, has_stock boolean)
language sql stable security definer set search_path = public as $$
  with c as (select * from items_to_check),
  sold as (
    select s.item_id, sum(s.qty) as q
    from sales_lines s
    where s.sale_date >= current_date - 90 and s.item_id in (select c.id from c)
    group by s.item_id),
  stocked as (select distinct ls.item_id from latest_stock ls where ls.loose_qty > 0)
  select c.id, c.name, c.pack_size, c.loose_per_strip, c.problem,
         coalesce(sold.q, 0), stocked.item_id is not null
  from c
  left join sold on sold.item_id = c.id
  left join stocked on stocked.item_id = c.id
  where public.has_role('admin')
  order by 6 desc, 7 desc, 2
$$;

-- ---------------------------------------------------------------------
-- Admin: reset a staff member's password without email.
-- (Supabase's free email service only reaches project team members,
--  so emailed reset links don't work for staff. This does.)
-- ---------------------------------------------------------------------
create or replace function public.admin_set_password(p_user_id uuid, p_new_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.has_role('admin') then raise exception 'Only Admin can reset passwords'; end if;
  if length(coalesce(p_new_password, '')) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = p_user_id;
  if not found then raise exception 'User not found'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Row level security: the database itself enforces who sees what.
-- Writes to sales / stock / item master only happen through the
-- functions above, which check the role first.
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.settings      enable row level security;
alter table public.warehouses    enable row level security;
alter table public.items         enable row level security;
alter table public.customers     enable row level security;
alter table public.sales_uploads enable row level security;
alter table public.sales_lines   enable row level security;
alter table public.stock_uploads enable row level security;
alter table public.stock_lines   enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.has_role('admin'));
drop policy if exists profiles_admin on public.profiles;
create policy profiles_admin on public.profiles for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (public.is_staff());
drop policy if exists settings_admin on public.settings;
create policy settings_admin on public.settings for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

drop policy if exists warehouses_read on public.warehouses;
create policy warehouses_read on public.warehouses for select to authenticated using (public.is_staff());
drop policy if exists warehouses_admin_ins on public.warehouses;
create policy warehouses_admin_ins on public.warehouses for insert to authenticated
  with check (public.has_role('admin'));
drop policy if exists warehouses_admin_upd on public.warehouses;
create policy warehouses_admin_upd on public.warehouses for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

drop policy if exists items_read on public.items;
create policy items_read on public.items for select to authenticated using (public.is_staff());
drop policy if exists items_admin_ins on public.items;
create policy items_admin_ins on public.items for insert to authenticated
  with check (public.has_role('admin'));
drop policy if exists items_admin_upd on public.items;
create policy items_admin_upd on public.items for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

drop policy if exists customers_admin on public.customers;
create policy customers_admin on public.customers for select to authenticated
  using (public.has_role('admin'));

drop policy if exists sales_uploads_read on public.sales_uploads;
create policy sales_uploads_read on public.sales_uploads for select to authenticated using (public.is_staff());
drop policy if exists sales_lines_read on public.sales_lines;
create policy sales_lines_read on public.sales_lines for select to authenticated using (public.is_staff());
drop policy if exists stock_uploads_read on public.stock_uploads;
create policy stock_uploads_read on public.stock_uploads for select to authenticated using (public.is_staff());
drop policy if exists stock_lines_read on public.stock_lines;
create policy stock_lines_read on public.stock_lines for select to authenticated using (public.is_staff());

-- Nobody outside the app (not logged in) can call anything.
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
