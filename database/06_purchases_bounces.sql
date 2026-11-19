-- =====================================================================
-- Update 6 (20 Nov 2026):
--  * order numbers (GC-201126-03) and warehouse codes
--  * receiving per line: supplied qty / bounced
--  * received-after-stock-count added to stock on the Order Sheet
--  * purchase upload (Date, Bill No, Distributor, Medicine, Pack, Inv Amount, Qty)
--    with automatic receive + bounce detection from Bill No
--  * data for same-day / 3-day repeat purchase reports
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- (Supabase may warn about "destructive operations": only FUNCTIONS are
--  dropped and recreated. No data is removed.)
-- =====================================================================
set client_min_messages = warning;

-- ---------------------------------------------------------------------
-- Warehouse codes and order numbers
-- ---------------------------------------------------------------------
alter table public.warehouses add column if not exists code text;
update public.warehouses set code = 'GC'   where code is null and name = 'Gaur City';
update public.warehouses set code = 'S101' where code is null and name = 'Sect 101';
update public.warehouses set code = 'IP'   where code is null and name = 'Indirapuram';
update public.warehouses set code = upper(left(regexp_replace(name, '[^A-Za-z0-9]', '', 'g'), 4)) where code is null;

alter table public.orders add column if not exists order_no text;
alter table public.orders add column if not exists received_by uuid references auth.users(id);
alter table public.orders add column if not exists received_source text;   -- 'manual' or 'purchase upload'
create unique index if not exists orders_order_no on public.orders (order_no);

alter table public.order_lines add column if not exists supplied_qty numeric(10,2);   -- null until received
alter table public.order_lines add column if not exists bounced boolean not null default false;

insert into public.settings (key, value, description) values
  ('repeat_days', '3', 'Purchase report: same medicine bought again within this many days = repeat.'),
  ('bounce_days', '3', 'A bounced line stays on the Order Sheet (ticked, in red) for this many days unless re-ordered.')
on conflict (key) do nothing;

-- next order number for a warehouse today (India time): GC-201126-03
create or replace function public.next_order_no(p_warehouse_id integer)
returns text language plpgsql security definer set search_path = public as $$
declare v_code text; v_day text; v_n integer;
begin
  perform pg_advisory_xact_lock(424242, p_warehouse_id);
  select coalesce(nullif(code, ''), 'W' || id) into v_code from warehouses where id = p_warehouse_id;
  v_day := to_char(now() at time zone 'Asia/Kolkata', 'DDMMYY');
  select count(*) + 1 into v_n from orders
   where warehouse_id = p_warehouse_id and order_no like v_code || '-' || v_day || '-%';
  return v_code || '-' || v_day || '-' || lpad(v_n::text, 2, '0');
end $$;

-- give numbers to orders placed before this update
do $$
declare r record;
begin
  for r in select o.id, o.warehouse_id, o.placed_at, coalesce(nullif(w.code, ''), 'W' || w.id) as code
           from orders o join warehouses w on w.id = o.warehouse_id
           where o.order_no is null order by o.placed_at loop
    update orders set order_no = r.code || '-' || to_char(r.placed_at at time zone 'Asia/Kolkata', 'DDMMYY') || '-' ||
      lpad((select count(*) + 1 from orders x where x.warehouse_id = r.warehouse_id and x.order_no like
            r.code || '-' || to_char(r.placed_at at time zone 'Asia/Kolkata', 'DDMMYY') || '-%')::text, 2, '0')
    where id = r.id;
  end loop;
end $$;
-- orders already marked received: everything counts as supplied
update public.order_lines ol set supplied_qty = ol.qty
  from public.orders o where o.id = ol.order_id and o.received_at is not null and ol.supplied_qty is null;
update public.orders set received_source = 'manual' where received_at is not null and received_source is null;

-- place_orders now numbers each order and returns the numbers
create or replace function public.place_orders(p_warehouse_id integer, p_note text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_d integer; v_id bigint; v_no text; v_out jsonb := '[]'::jsonb;
begin
  if not public.has_role('admin', 'purchase') then raise exception 'Only Admin or Purchase Team can place orders'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l where nullif(l ->> 'distributor_id', '') is null) then
    raise exception 'Choose a distributor for every medicine';
  end if;
  for v_d in select distinct (l ->> 'distributor_id')::integer from jsonb_array_elements(p_lines) l order by 1 loop
    v_no := public.next_order_no(p_warehouse_id);
    insert into orders (warehouse_id, distributor_id, placed_by, note, order_no)
    values (p_warehouse_id, v_d, auth.uid(), nullif(trim(p_note), ''), v_no) returning id into v_id;
    insert into order_lines (order_id, item_id, qty, suggested_qty)
    select v_id, (l ->> 'item_id')::integer, sum((l ->> 'qty')::numeric), max(nullif(l ->> 'suggested', '')::numeric)
    from jsonb_array_elements(p_lines) l
    where (l ->> 'distributor_id')::integer = v_d and (l ->> 'qty')::numeric > 0
    group by 2;
    update orders set lines = (select count(*) from order_lines where order_id = v_id),
                      total_qty = (select coalesce(sum(qty), 0) from order_lines where order_id = v_id)
    where id = v_id;
    v_out := v_out || jsonb_build_object('order_id', v_id, 'distributor_id', v_d, 'order_no', v_no);
  end loop;
  return v_out;
end $$;

-- older single-distributor version: number it too
create or replace function public.place_order(p_warehouse_id integer, p_distributor_id integer, p_note text, p_lines jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_res jsonb;
begin
  if p_distributor_id is null then raise exception 'Choose a distributor'; end if;
  select public.place_orders(p_warehouse_id, p_note,
    (select jsonb_agg(l || jsonb_build_object('distributor_id', p_distributor_id)) from jsonb_array_elements(p_lines) l))
    into v_res;
  return (v_res -> 0 ->> 'order_id')::bigint;
end $$;

-- ---------------------------------------------------------------------
-- Receiving: supplied qty per line; 0 = bounced
-- p_lines: [{"item_id":12,"supplied":30}, ...]  (lines not listed = fully supplied)
-- ---------------------------------------------------------------------
create or replace function public.receive_order(p_order_id bigint, p_lines jsonb, p_source text default 'manual')
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin', 'purchase', 'manager') then raise exception 'Not allowed'; end if;
  update order_lines ol set
    supplied_qty = least(greatest(coalesce(x.supplied, ol.qty), 0), ol.qty),
    bounced      = coalesce(x.supplied, ol.qty) < ol.qty
  from (
    select o3.item_id,
           (select (l ->> 'supplied')::numeric from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
             where (l ->> 'item_id')::integer = o3.item_id limit 1) as supplied
    from order_lines o3 where o3.order_id = p_order_id) x
  where ol.order_id = p_order_id and x.item_id = ol.item_id;
  update orders set received_at = coalesce(received_at, now()), received_by = coalesce(received_by, auth.uid()),
                    received_source = coalesce(p_source, 'manual'), cancelled_at = null
  where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
end $$;

-- the old buttons (Mark received / Cancel / reopen) keep working
create or replace function public.set_order_status(p_order_id bigint, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin', 'purchase', 'manager') then raise exception 'Not allowed'; end if;
  if p_status = 'received' then
    perform public.receive_order(p_order_id, '[]'::jsonb, 'manual');
    return;
  end if;
  update orders set
    received_at  = case when p_status = 'open' then null else received_at end,
    cancelled_at = case when p_status = 'cancelled' then now() when p_status = 'open' then null else cancelled_at end
  where id = p_order_id;
  if p_status = 'open' then update order_lines set supplied_qty = null, bounced = false where order_id = p_order_id; end if;
end $$;

-- ---------------------------------------------------------------------
-- What's on order / received / bounced, per medicine, for the Order Sheet
-- ---------------------------------------------------------------------
drop function if exists public.order_sheet(integer);
drop function if exists public.on_order(integer);

create function public.on_order(p_warehouse_id integer)
returns table (item_id integer, open_qty numeric, today_qty numeric, last_at timestamptz,
               last_qty numeric, last_by text, last_distributor text, last_received boolean, last_order_no text,
               recv_after_stock numeric, bounce_qty numeric, bounce_dist_id integer, bounce_dist text, bounce_at timestamptz)
language sql stable security definer set search_path = public as $$
  with stock_at as (
    select max(created_at) as t from stock_uploads where warehouse_id = p_warehouse_id
  ), l as (
    select ol.item_id, ol.qty, ol.supplied_qty, ol.bounced, o.id as order_id, o.order_no, o.placed_at, o.received_at,
           o.distributor_id, o.placed_by
    from orders o
    join order_lines ol on ol.order_id = o.id
    where o.warehouse_id = p_warehouse_id and o.cancelled_at is null
      and o.placed_at >= now() - make_interval(days => greatest(
            coalesce((select value::int from settings where key = 'order_open_days'), 2),
            coalesce((select value::int from settings where key = 'bounce_days'), 3), 1) + 7)
  ), latest as (
    -- the most recent order line per medicine
    select distinct on (item_id) * from l order by item_id, placed_at desc
  )
  select l.item_id,
         sum(l.qty) filter (where l.received_at is null and l.placed_at >= now() - make_interval(days => greatest(
            coalesce((select value::int from settings where key = 'order_open_days'), 2), 1))),
         sum(l.qty) filter (where (l.placed_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date),
         max(l.placed_at),
         max(lt.qty), max(p.full_name) filter (where l.order_id = lt.order_id), max(d.name) filter (where l.order_id = lt.order_id),
         bool_or(lt.received_at is not null), max(lt.order_no),
         -- supplied quantities received after the latest stock upload
         coalesce(sum(coalesce(l.supplied_qty, l.qty)) filter (where l.received_at > (select t from stock_at)), 0),
         -- the latest line bounced (fully or partly) and not re-ordered since
         max(lt.qty - coalesce(lt.supplied_qty, lt.qty)) filter (where lt.bounced and lt.placed_at >= now() - make_interval(days =>
             coalesce((select value::int from settings where key = 'bounce_days'), 3))),
         max(lt.distributor_id) filter (where lt.bounced),
         max(bd.name) filter (where lt.bounced),
         max(lt.received_at) filter (where lt.bounced)
  from l
  join latest lt on lt.item_id = l.item_id
  left join profiles p on p.user_id = lt.placed_by
  left join distributors d on d.id = lt.distributor_id
  left join distributors bd on bd.id = lt.distributor_id
  where public.is_staff()
  group by l.item_id
$$;

create function public.order_sheet(p_warehouse_id integer)
returns table (
  item_id integer, name text, pack_size text, grp text, growing boolean, speed text, pattern text, why text,
  per_day numeric, normal_sale numeric, weeks_sold smallint, min_stock integer, max_stock integer, can_order boolean,
  lasts_days numeric, warning text, qty_7 numeric, qty_30 numeric, qty_60 numeric, qty_90 numeric, cust_30 integer, total_bills integer,
  days_selling integer, last_sold date, days_since integer, odd_note text,
  loose_qty numeric, loose_per_strip numeric, closing numeric, stock_flag text,
  open_qty numeric, today_qty numeric, last_order_at timestamptz, last_order_qty numeric, last_order_by text,
  last_order_distributor text, usual_distributor_id integer,
  last_received boolean, last_order_no text, recv_after_stock numeric,
  bounce_qty numeric, bounce_dist_id integer, bounce_dist text, bounce_at timestamptz)
language sql stable security definer set search_path = public as $$
  with st as (
    select ls.item_id, ls.loose_qty, ls.strips, ls.flag from latest_stock ls where ls.warehouse_id = p_warehouse_id
  ), oo as (select * from public.on_order(p_warehouse_id))
  select i.id, i.name, i.pack_size,
         coalesce(lv.grp, 'Not sold'), coalesce(lv.growing, false), lv.speed, lv.pattern, lv.why,
         lv.per_day, lv.normal_sale, lv.weeks_sold, coalesce(lv.min_stock, 0), coalesce(lv.max_stock, 0),
         coalesce(lv.can_order, false), lv.lasts_days, lv.warning, lv.qty_7, lv.qty_30, lv.qty_60, lv.qty_90, lv.cust_30, lv.total_bills,
         lv.days_selling, lv.last_sold, lv.days_since, lv.odd_note,
         st.loose_qty, i.loose_per_strip, st.strips, st.flag,
         oo.open_qty, oo.today_qty, oo.last_at, oo.last_qty, oo.last_by, oo.last_distributor,
         ud.distributor_id,
         oo.last_received, oo.last_order_no, coalesce(oo.recv_after_stock, 0),
         oo.bounce_qty, oo.bounce_dist_id, oo.bounce_dist, oo.bounce_at
  from items i
  left join item_levels lv on lv.item_id = i.id and lv.warehouse_id = p_warehouse_id
  join st on st.item_id = i.id
  left join oo on oo.item_id = i.id
  -- the distributor this medicine was last ordered from, as the default
  left join lateral (
    select o.distributor_id from order_lines ol join orders o on o.id = ol.order_id
    where ol.item_id = i.id and o.warehouse_id = p_warehouse_id and o.cancelled_at is null and o.distributor_id is not null
    order by o.placed_at desc limit 1) ud on true
  where public.is_staff()
$$;

-- ---------------------------------------------------------------------
-- Purchases
-- ---------------------------------------------------------------------
create unique index if not exists distributors_norm_key on public.distributors (public.norm_text(name));

create table if not exists public.purchase_uploads (
  id             bigint generated always as identity primary key,
  warehouse_id   integer not null references public.warehouses(id),
  uploaded_by    uuid references auth.users(id) default auth.uid(),
  file_name      text,
  first_date     date,
  last_date      date,
  rows_in_file   integer not null default 0,
  rows_saved     integer not null default 0,
  rows_already   integer not null default 0,
  rows_skipped   integer not null default 0,
  orders_matched integer not null default 0,
  status         text not null default 'running' check (status in ('running', 'done', 'failed')),
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);

-- one line per medicine per bill (same medicine twice on a bill is added up)
create table if not exists public.purchase_lines (
  warehouse_id   integer not null references public.warehouses(id),
  purchase_date  date    not null,
  bill_no        text    not null,
  distributor_id integer not null references public.distributors(id),
  item_id        integer not null references public.items(id),
  qty            numeric(10,2) not null,
  amount         numeric(12,2),
  upload_id      bigint references public.purchase_uploads(id),
  primary key (warehouse_id, distributor_id, bill_no, item_id)
);
create index if not exists purchase_lines_wh_date on public.purchase_lines (warehouse_id, purchase_date);

create or replace function public.purchase_status()
returns table (warehouse_id integer, warehouse text, first_date date, last_date date)
language sql stable security definer set search_path = public as $$
  select w.id, w.name,
         (select min(p.purchase_date) from purchase_lines p where p.warehouse_id = w.id),
         (select max(p.purchase_date) from purchase_lines p where p.warehouse_id = w.id)
  from warehouses w where w.active and public.is_staff() order by w.name
$$;

create or replace function public.start_purchase_upload(p_warehouse_id integer, p_file_name text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not public.has_role('admin', 'manager', 'purchase') then raise exception 'Not allowed'; end if;
  insert into purchase_uploads (warehouse_id, uploaded_by, file_name) values (p_warehouse_id, auth.uid(), p_file_name)
  returning id into v_id;
  return v_id;
end $$;

-- p_rows: [{"d":"2026-11-20","b":"INV-889","s":"M/s Jai Medical Agency","n":"Dolo 650 Tablet","p":"15 Tablet","q":10,"a":300}]
create or replace function public.import_purchase_batch(p_upload_id bigint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_wh integer; v_total integer; v_bad integer; v_lines integer; v_saved integer; v_matched integer := 0; m record;
begin
  if not public.has_role('admin', 'manager', 'purchase') then raise exception 'Not allowed'; end if;
  select warehouse_id into v_wh from purchase_uploads where id = p_upload_id and status = 'running';
  if v_wh is null then raise exception 'Upload % is not open', p_upload_id; end if;

  create temp table _pr on commit drop as
  select nullif(r ->> 'd', '')::date as d, nullif(trim(r ->> 'b'), '') as b,
         nullif(regexp_replace(trim(r ->> 's'), '\s+', ' ', 'g'), '') as s,
         nullif(trim(r ->> 'n'), '') as n, coalesce(trim(r ->> 'p'), '') as p,
         nullif(r ->> 'q', '')::numeric as q, nullif(r ->> 'a', '')::numeric as a
  from jsonb_array_elements(p_rows) r;
  select count(*) into v_total from _pr;
  select count(*) into v_bad from _pr where d is null or b is null or s is null or n is null or q is null or q <= 0;
  delete from _pr where d is null or b is null or s is null or n is null or q is null or q <= 0;

  insert into distributors (name)
  select distinct on (public.norm_text(s)) s from _pr
  on conflict ((public.norm_text(name))) do nothing;
  insert into items (name, pack_size)
  select distinct on (public.norm_text(n) || '|' || public.norm_text(p)) n, p from _pr
  on conflict (norm_key) do nothing;

  create temp table _pg on commit drop as
  select min(r.d) as d, r.b, ds.id as distributor_id, i.id as item_id, sum(r.q) as q, sum(r.a) as a
  from _pr r
  join distributors ds on public.norm_text(ds.name) = public.norm_text(r.s)
  join items i on i.norm_key = public.norm_text(r.n) || '|' || public.norm_text(r.p)
  group by r.b, ds.id, i.id;
  select count(*) into v_lines from _pg;

  with ins as (
    insert into purchase_lines (warehouse_id, purchase_date, bill_no, distributor_id, item_id, qty, amount, upload_id)
    select v_wh, d, b, distributor_id, item_id, q, a, p_upload_id from _pg
    on conflict do nothing returning 1)
  select count(*) into v_saved from ins;

  -- Bill No = an app order's invoice or challan no. (same distributor): mark it
  -- received, supplied = what the bill has, lines missing from the bill = bounced
  for m in
    select distinct o.id as order_id, g.b, g.distributor_id
    from (select distinct b, distributor_id from _pg) g
    join orders o on o.warehouse_id = v_wh and o.distributor_id = g.distributor_id and o.cancelled_at is null
     and (public.norm_text(o.invoice_no) = public.norm_text(g.b) or public.norm_text(o.challan_no) = public.norm_text(g.b))
  loop
    perform public.receive_order(m.order_id,
      (select coalesce(jsonb_agg(jsonb_build_object('item_id', ol.item_id, 'supplied',
                coalesce((select sum(pl.qty) from purchase_lines pl where pl.warehouse_id = v_wh and pl.distributor_id = m.distributor_id
                          and pl.bill_no = m.b and pl.item_id = ol.item_id), 0))), '[]'::jsonb)
       from order_lines ol where ol.order_id = m.order_id),
      'purchase upload');
    v_matched := v_matched + 1;
  end loop;

  update purchase_uploads set
    rows_in_file = rows_in_file + v_total, rows_saved = rows_saved + v_saved,
    rows_already = rows_already + (v_lines - v_saved), rows_skipped = rows_skipped + v_bad,
    orders_matched = orders_matched + v_matched,
    first_date = least(first_date, (select min(d) from _pg)), last_date = greatest(last_date, (select max(d) from _pg))
  where id = p_upload_id;
  return jsonb_build_object('rows', v_total, 'saved', v_saved, 'already', v_lines - v_saved, 'skipped', v_bad, 'matched', v_matched);
end $$;

create or replace function public.finish_purchase_upload(p_upload_id bigint, p_ok boolean default true)
returns purchase_uploads language plpgsql security definer set search_path = public as $$
declare v purchase_uploads;
begin
  if not public.has_role('admin', 'manager', 'purchase') then raise exception 'Not allowed'; end if;
  update purchase_uploads set status = case when p_ok then 'done' else 'failed' end, finished_at = now()
  where id = p_upload_id and status = 'running' returning * into v;
  if v.rows_saved > 0 then analyze public.purchase_lines; end if;
  return v;
end $$;

-- Everything the repeat-purchase report needs for one warehouse and date
-- range: purchase lines (with a few days before, to find repeats at the
-- start of the range), app orders for the same medicines, Max stock,
-- sales in the period, discontinued flags.
create or replace function public.purchase_report_data(p_warehouse_id integer, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_days integer := coalesce((select value::int from settings where key = 'repeat_days'), 3);
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'repeat_days', v_days,
    'purchases', coalesce((
      select jsonb_agg(jsonb_build_array(pl.item_id, pl.purchase_date, pl.bill_no, pl.distributor_id, pl.qty, pl.amount)
                       order by pl.purchase_date)
      from purchase_lines pl
      where pl.warehouse_id = p_warehouse_id and pl.purchase_date between p_from - v_days and p_to), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_array(i.id, i.name, i.pack_size, i.status, lv.max_stock, lv.grp,
               (select coalesce(sum(s.qty), 0) from sales_lines s where s.warehouse_id = p_warehouse_id and s.item_id = i.id
                  and s.sale_date between p_from - v_days and p_to)))
      from items i left join item_levels lv on lv.item_id = i.id and lv.warehouse_id = p_warehouse_id
      where i.id in (select item_id from purchase_lines where warehouse_id = p_warehouse_id
                       and purchase_date between p_from - v_days and p_to)), '[]'::jsonb),
    'distributors', coalesce((select jsonb_object_agg(id, name) from distributors), '{}'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_array(ol.item_id, o.order_no, o.placed_at, o.distributor_id, ol.qty,
               coalesce(o.invoice_no, ''), coalesce(o.challan_no, '')))
      from orders o join order_lines ol on ol.order_id = o.id
      where o.warehouse_id = p_warehouse_id and o.cancelled_at is null
        and o.placed_at >= (p_from - v_days - 3)::timestamp and o.placed_at < (p_to + 1)::timestamp), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- Duplicate Items sheet: mark the "discontinue" medicines
-- p_rows: [{"n":"Almox 500 Capsule","p":"10 Capsules","x":"discontinue"}, ...]
-- ---------------------------------------------------------------------
create or replace function public.mark_discontinued(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_added integer; v_marked integer;
begin
  if not public.has_role('admin') then raise exception 'Only Admin can change the item master'; end if;
  create temp table _dc on commit drop as
  select trim(r ->> 'n') as n, coalesce(trim(r ->> 'p'), '') as p from jsonb_array_elements(p_rows) r
  where coalesce(r ->> 'x', '') ilike '%discontinu%' and nullif(trim(r ->> 'n'), '') is not null;
  with ins as (insert into items (name, pack_size, status) select distinct on (public.norm_text(n) || '|' || public.norm_text(p)) n, p, 'discontinued'
               from _dc on conflict (norm_key) do nothing returning 1)
  select count(*) into v_added from ins;
  with up as (update items i set status = 'discontinued' from _dc
              where i.norm_key = public.norm_text(_dc.n) || '|' || public.norm_text(_dc.p) and i.status <> 'discontinued' returning 1)
  select count(*) into v_marked from up;
  return jsonb_build_object('rows', (select count(*) from _dc), 'marked', v_marked, 'added', v_added);
end $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
alter table public.purchase_uploads enable row level security;
alter table public.purchase_lines   enable row level security;
drop policy if exists purchase_uploads_read on public.purchase_uploads;
create policy purchase_uploads_read on public.purchase_uploads for select to authenticated using (public.is_staff());
drop policy if exists purchase_lines_read on public.purchase_lines;
create policy purchase_lines_read on public.purchase_lines for select to authenticated using (public.is_staff());

revoke all on public.purchase_uploads, public.purchase_lines from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
