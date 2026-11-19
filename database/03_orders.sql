-- =====================================================================
-- Update 3 (Part 2): Min/Max levels, distributors, orders.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once.
-- =====================================================================
set client_min_messages = warning;

-- Your analysis settings. Admin can change these values in the
-- settings table; the app reads them every time it calculates.
insert into public.settings (key, value, description) values
  ('order_open_days', '2',  'An order counts as "on order" for this many days (or until marked received).'),
  ('delivery_days',   '2',  'Days between placing an order and stock arriving.'),
  ('min_days_fast',   '7',  'Fast: order when stock drops below this many days.'),
  ('max_days_fast',   '11', 'Fast: order up to this many days.'),
  ('min_days_average','8',  'Average: order when stock drops below this many days.'),
  ('max_days_average','12', 'Average: order up to this many days.'),
  ('busy_day_buffer_fast',    '2.05', 'Fast: busy-day buffer (higher = more spare stock).'),
  ('busy_day_buffer_average', '1.65', 'Average: busy-day buffer.'),
  ('stopped_days',    '21', 'No sale for this many days = stop ordering.'),
  ('dead_days',       '90', 'No sale for this many days = dead stock.'),
  ('expiry_warning_days', '60', 'Holding more than this many days of stock = warning.'),
  ('min_order_qty',   '2',  'Smallest order line for Fast / Average medicines.')
on conflict (key) do nothing;

update public.settings
   set description = 'Bill lines older than this many days are deleted. 3650 = keep about 10 years.'
 where key = 'sales_keep_days';

-- ---------------------------------------------------------------------
-- Sales figures for the calculation, for one warehouse, "as of" a date
-- (the day after the last uploaded sales day = how your Python script
-- sees it when run the next morning).
--   items  : per medicine totals for 7..360 days, first/last sale,
--            weeks sold in (of 13), sale sizes over 90 and 120 days
--   recent : every bill line of the last 30 days, for the odd-sale and
--            busy-day checks
-- ---------------------------------------------------------------------
create or replace function public.analysis_data(p_warehouse_id integer, p_as_of date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_items jsonb; v_recent jsonb; v_first date; v_last date;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;

  select min(sale_date), max(sale_date) into v_first, v_last
  from sales_lines where warehouse_id = p_warehouse_id and sale_date < p_as_of;

  -- Each sales line is already one medicine on one bill (that is the
  -- table's key), so "bills" is a plain row count and a line's qty is
  -- the bill's quantity for that medicine.
  with s as materialized (
    select item_id, sale_date as d, customer_id as c, qty as q
    from sales_lines
    where warehouse_id = p_warehouse_id and sale_date >= p_as_of - 360 and sale_date < p_as_of
  ),
  sizes as (
    select item_id,
      percentile_cont(0.5) within group (order by q) filter (where d >= p_as_of - 90)  as n90,
      percentile_cont(0.9) within group (order by q) filter (where d >= p_as_of - 90)  as b90,
      max(q) filter (where d >= p_as_of - 90)                                          as x90,
      percentile_cont(0.5) within group (order by q)                                   as n120,
      percentile_cont(0.9) within group (order by q)                                   as b120,
      max(q)                                                                           as x120
    from s where d >= p_as_of - 120 group by item_id
  ),
  -- a customer counts in a period if their LAST purchase falls inside it
  cust_last as (
    select item_id, max(d) as last_d from s where c is not null group by item_id, c
  ),
  cust as (
    select item_id, jsonb_build_array(
      count(*) filter (where last_d >= p_as_of - 7),   count(*) filter (where last_d >= p_as_of - 15),
      count(*) filter (where last_d >= p_as_of - 30),  count(*) filter (where last_d >= p_as_of - 45),
      count(*) filter (where last_d >= p_as_of - 60),  count(*) filter (where last_d >= p_as_of - 90),
      count(*) filter (where last_d >= p_as_of - 120), count(*) filter (where last_d >= p_as_of - 180),
      count(*) filter (where last_d >= p_as_of - 270), count(*)) as cust
    from cust_last group by item_id
  ),
  weeks as (
    select item_id, count(distinct least((p_as_of - d) / 7, 12)) as weeks
    from s where d > p_as_of - 91 group by item_id
  ),
  agg as (
    select item_id,
      jsonb_build_array(
        coalesce(sum(q) filter (where d >= p_as_of - 7), 0),   coalesce(sum(q) filter (where d >= p_as_of - 15), 0),
        coalesce(sum(q) filter (where d >= p_as_of - 30), 0),  coalesce(sum(q) filter (where d >= p_as_of - 45), 0),
        coalesce(sum(q) filter (where d >= p_as_of - 60), 0),  coalesce(sum(q) filter (where d >= p_as_of - 90), 0),
        coalesce(sum(q) filter (where d >= p_as_of - 120), 0), coalesce(sum(q) filter (where d >= p_as_of - 180), 0),
        coalesce(sum(q) filter (where d >= p_as_of - 270), 0), coalesce(sum(q), 0)) as qty,
      jsonb_build_array(
        count(*) filter (where d >= p_as_of - 7),   count(*) filter (where d >= p_as_of - 15),
        count(*) filter (where d >= p_as_of - 30),  count(*) filter (where d >= p_as_of - 45),
        count(*) filter (where d >= p_as_of - 60),  count(*) filter (where d >= p_as_of - 90),
        count(*) filter (where d >= p_as_of - 120), count(*) filter (where d >= p_as_of - 180),
        count(*) filter (where d >= p_as_of - 270), count(*)) as bills
    from s group by item_id
  ),
  span as (
    select item_id, min(sale_date) as first_d, max(sale_date) as last_d
    from sales_lines
    where warehouse_id = p_warehouse_id and sale_date < p_as_of
    group by item_id
  )
  select jsonb_agg(jsonb_build_array(
           a.item_id, i.name, i.pack_size, a.qty, a.bills,
           coalesce(cu.cust, '[0,0,0,0,0,0,0,0,0,0]'::jsonb),
           sp.first_d, sp.last_d, coalesce(w.weeks, 0),
           coalesce(z.n90, 0), coalesce(z.b90, 0), coalesce(z.x90, 0),
           coalesce(z.n120, 0), coalesce(z.b120, 0), coalesce(z.x120, 0)))
    into v_items
  from agg a
  join items i on i.id = a.item_id
  join span sp on sp.item_id = a.item_id
  left join cust cu on cu.item_id = a.item_id
  left join weeks w on w.item_id = a.item_id
  left join sizes z on z.item_id = a.item_id;

  select jsonb_agg(jsonb_build_array(item_id, sale_date - p_as_of, bill_no, qty, customer_id))
    into v_recent
  from sales_lines
  where warehouse_id = p_warehouse_id and sale_date >= p_as_of - 30 and sale_date < p_as_of;

  return jsonb_build_object(
    'as_of', p_as_of, 'store_first', v_first, 'store_last', v_last,
    'items', coalesce(v_items, '[]'::jsonb), 'recent', coalesce(v_recent, '[]'::jsonb));
end $$;


-- After a sales upload, refresh the table statistics straight away so
-- the Min / Max calculation that follows gets a fast query plan.
create or replace function public.finish_sales_upload(p_upload_id bigint, p_ok boolean default true)
returns sales_uploads language plpgsql security definer set search_path = public as $$
declare v sales_uploads;
begin
  if not public.has_role('admin', 'manager') then raise exception 'Not allowed'; end if;
  update sales_uploads
     set status = case when p_ok then 'done' else 'failed' end, finished_at = now()
   where id = p_upload_id and status = 'running'
  returning * into v;
  if v.rows_saved > 0 then
    analyze public.sales_lines;
    analyze public.items;
    analyze public.customers;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Min / Max results, one row per medicine per warehouse
-- ---------------------------------------------------------------------
create table if not exists public.item_levels (
  warehouse_id  integer not null references public.warehouses(id) on delete cascade,
  item_id       integer not null references public.items(id),
  grp           text not null,
  growing       boolean not null default false,
  speed         text,
  pattern       text,
  why           text,
  per_day       numeric(10,3),
  normal_sale   numeric(10,2),
  big_sale      numeric(10,2),
  weeks_sold    smallint,
  min_stock     integer not null,
  max_stock     integer not null,
  can_order     boolean not null,
  lasts_days    numeric(8,1),
  warning       text,
  qty_30        numeric(10,2),
  qty_90        numeric(10,2),
  bills_30      integer,
  cust_30       integer,
  cust_90       integer,
  total_bills   integer,
  days_selling  integer,
  last_sold     date,
  days_since    integer,
  odd_note      text,
  primary key (warehouse_id, item_id)
);

create table if not exists public.level_runs (
  warehouse_id  integer primary key references public.warehouses(id) on delete cascade,
  as_of         date not null,
  sales_up_to   date,
  computed_at   timestamptz not null default now(),
  computed_by   uuid references auth.users(id),
  items         integer
);

create or replace function public.save_levels(p_warehouse_id integer, p_as_of date, p_sales_up_to date, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  delete from item_levels where warehouse_id = p_warehouse_id;
  insert into item_levels (warehouse_id, item_id, grp, growing, speed, pattern, why, per_day, normal_sale, big_sale,
    weeks_sold, min_stock, max_stock, can_order, lasts_days, warning, qty_30, qty_90, bills_30, cust_30, cust_90,
    total_bills, days_selling, last_sold, days_since, odd_note)
  select p_warehouse_id, x.* from jsonb_to_recordset(p_rows) as x(
    item_id integer, grp text, growing boolean, speed text, pattern text, why text, per_day numeric, normal_sale numeric,
    big_sale numeric, weeks_sold smallint, min_stock integer, max_stock integer, can_order boolean, lasts_days numeric,
    warning text, qty_30 numeric, qty_90 numeric, bills_30 integer, cust_30 integer, cust_90 integer, total_bills integer,
    days_selling integer, last_sold date, days_since integer, odd_note text);
  get diagnostics v_n = row_count;
  insert into level_runs (warehouse_id, as_of, sales_up_to, computed_at, computed_by, items)
  values (p_warehouse_id, p_as_of, p_sales_up_to, now(), auth.uid(), v_n)
  on conflict (warehouse_id) do update set as_of = excluded.as_of, sales_up_to = excluded.sales_up_to,
    computed_at = excluded.computed_at, computed_by = excluded.computed_by, items = excluded.items;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Distributors and orders
-- ---------------------------------------------------------------------
create table if not exists public.distributors (
  id         integer generated always as identity primary key,
  name       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id             bigint generated always as identity primary key,
  warehouse_id   integer not null references public.warehouses(id),
  distributor_id integer references public.distributors(id),
  placed_by      uuid references auth.users(id) default auth.uid(),
  placed_at      timestamptz not null default now(),
  note           text,
  lines          integer not null default 0,
  total_qty      numeric(12,2) not null default 0,
  received_at    timestamptz,                 -- set when marked received
  cancelled_at   timestamptz
);
create index if not exists orders_wh_time on public.orders (warehouse_id, placed_at desc);

create table if not exists public.order_lines (
  order_id      bigint  not null references public.orders(id) on delete cascade,
  item_id       integer not null references public.items(id),
  qty           numeric(10,2) not null check (qty > 0),
  suggested_qty numeric(10,2),
  primary key (order_id, item_id)
);

-- p_lines: [{"item_id":12,"qty":10,"suggested":8}, ...]
create or replace function public.place_order(p_warehouse_id integer, p_distributor_id integer, p_note text, p_lines jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not public.has_role('admin', 'purchase') then raise exception 'Only Admin or Purchase Team can place orders'; end if;
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then raise exception 'The order has no medicines'; end if;
  insert into orders (warehouse_id, distributor_id, placed_by, note)
  values (p_warehouse_id, p_distributor_id, auth.uid(), nullif(trim(p_note), '')) returning id into v_id;
  insert into order_lines (order_id, item_id, qty, suggested_qty)
  select v_id, (l ->> 'item_id')::integer, sum((l ->> 'qty')::numeric), max(nullif(l ->> 'suggested', '')::numeric)
  from jsonb_array_elements(p_lines) l
  where (l ->> 'qty')::numeric > 0
  group by 2;
  update orders set lines = (select count(*) from order_lines where order_id = v_id),
                    total_qty = (select coalesce(sum(qty), 0) from order_lines where order_id = v_id)
  where id = v_id;
  return v_id;
end $$;

create or replace function public.set_order_status(p_order_id bigint, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin', 'purchase', 'manager') then raise exception 'Not allowed'; end if;
  update orders set
    received_at  = case when p_status = 'received'  then now() when p_status = 'open' then null else received_at end,
    cancelled_at = case when p_status = 'cancelled' then now() when p_status = 'open' then null else cancelled_at end
  where id = p_order_id;
end $$;

-- What is already on order, per medicine, for one warehouse:
-- orders placed in the last order_open_days days that are not marked
-- received or cancelled. Also: was it ordered TODAY (India time)?
create or replace function public.on_order(p_warehouse_id integer)
returns table (item_id integer, open_qty numeric, today_qty numeric, last_at timestamptz,
               last_qty numeric, last_by text, last_distributor text)
language sql stable security definer set search_path = public as $$
  with l as (
    select ol.item_id, ol.qty, o.placed_at, o.received_at, o.distributor_id, o.placed_by
    from orders o
    join order_lines ol on ol.order_id = o.id
    where o.warehouse_id = p_warehouse_id and o.cancelled_at is null
      and o.placed_at >= now() - make_interval(days => greatest(
            coalesce((select value::int from settings where key = 'order_open_days'), 2), 1))
  )
  select l.item_id,
         sum(l.qty) filter (where l.received_at is null),
         sum(l.qty) filter (where (l.placed_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date),
         max(l.placed_at),
         (array_agg(l.qty order by l.placed_at desc))[1],
         (array_agg(p.full_name order by l.placed_at desc))[1],
         (array_agg(d.name order by l.placed_at desc))[1]
  from l
  left join profiles p on p.user_id = l.placed_by
  left join distributors d on d.id = l.distributor_id
  where public.is_staff()
  group by l.item_id
$$;

-- Everything the order screen needs in one call: levels + latest stock
-- + what's on order. Leaves out dead medicines that have no stock.
create or replace function public.order_sheet(p_warehouse_id integer)
returns table (
  item_id integer, name text, pack_size text, grp text, growing boolean, speed text, pattern text, why text,
  per_day numeric, normal_sale numeric, weeks_sold smallint, min_stock integer, max_stock integer, can_order boolean,
  lasts_days numeric, warning text, qty_30 numeric, qty_90 numeric, cust_30 integer, total_bills integer,
  days_selling integer, last_sold date, days_since integer, odd_note text,
  loose_qty numeric, loose_per_strip numeric, closing numeric, stock_flag text,
  open_qty numeric, today_qty numeric, last_order_at timestamptz, last_order_qty numeric, last_order_by text,
  last_order_distributor text)
language sql stable security definer set search_path = public as $$
  with st as (
    select ls.item_id, ls.loose_qty, ls.strips, ls.flag from latest_stock ls where ls.warehouse_id = p_warehouse_id
  ), oo as (select * from public.on_order(p_warehouse_id))
  select i.id, i.name, i.pack_size,
         coalesce(lv.grp, 'Not sold'), coalesce(lv.growing, false), lv.speed, lv.pattern, lv.why,
         lv.per_day, lv.normal_sale, lv.weeks_sold, coalesce(lv.min_stock, 0), coalesce(lv.max_stock, 0),
         coalesce(lv.can_order, false), lv.lasts_days, lv.warning, lv.qty_30, lv.qty_90, lv.cust_30, lv.total_bills,
         lv.days_selling, lv.last_sold, lv.days_since, lv.odd_note,
         st.loose_qty, i.loose_per_strip, st.strips, st.flag,
         oo.open_qty, oo.today_qty, oo.last_at, oo.last_qty, oo.last_by, oo.last_distributor
  from items i
  left join item_levels lv on lv.item_id = i.id and lv.warehouse_id = p_warehouse_id
  left join st on st.item_id = i.id
  left join oo on oo.item_id = i.id
  where public.is_staff()
    and (lv.item_id is not null or st.item_id is not null or oo.item_id is not null)
    and (coalesce(lv.can_order, false) or coalesce(st.loose_qty, 0) > 0 or oo.item_id is not null
         or lv.grp = 'New')
$$;

-- Database space used (Admin home)
create or replace function public.db_space()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public.has_role('admin') then jsonb_build_object(
    'used_mb', round(pg_database_size(current_database()) / 1048576.0, 1),
    'sales_mb', round(pg_total_relation_size('public.sales_lines') / 1048576.0, 1),
    'limit_mb', 500) end
$$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
alter table public.item_levels  enable row level security;
alter table public.level_runs   enable row level security;
alter table public.distributors enable row level security;
alter table public.orders       enable row level security;
alter table public.order_lines  enable row level security;

drop policy if exists item_levels_read on public.item_levels;
create policy item_levels_read on public.item_levels for select to authenticated using (public.is_staff());
drop policy if exists level_runs_read on public.level_runs;
create policy level_runs_read on public.level_runs for select to authenticated using (public.is_staff());

drop policy if exists distributors_read on public.distributors;
create policy distributors_read on public.distributors for select to authenticated using (public.is_staff());
drop policy if exists distributors_add on public.distributors;
create policy distributors_add on public.distributors for insert to authenticated
  with check (public.has_role('admin', 'purchase'));
drop policy if exists distributors_edit on public.distributors;
create policy distributors_edit on public.distributors for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated using (public.is_staff());
drop policy if exists order_lines_read on public.order_lines;
create policy order_lines_read on public.order_lines for select to authenticated using (public.is_staff());

drop policy if exists settings_admin on public.settings;
create policy settings_admin on public.settings for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

revoke all on public.item_levels, public.level_runs, public.distributors, public.orders, public.order_lines from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
