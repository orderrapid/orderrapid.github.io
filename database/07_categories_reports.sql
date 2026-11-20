-- =====================================================================
-- Update 7 (20 Nov 2026):
--  * medicine details on the item master: Category, Type of Ailment,
--    Brand Name, Manufacturer, Chronic
--  * Order Sheet gets those columns (for filters)
--  * Reports: sales / purchases grouped by category, ailment,
--    manufacturer or brand; rising & falling; hourly sales
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- (Supabase may warn about "destructive operations": only the order_sheet
--  FUNCTION is dropped and recreated. No data is removed.)
-- =====================================================================
set client_min_messages = warning;

alter table public.items add column if not exists category     text;
alter table public.items add column if not exists ailment      text;
alter table public.items add column if not exists brand        text;
alter table public.items add column if not exists manufacturer text;
alter table public.items add column if not exists chronic      boolean not null default false;

-- p_rows: [{"n":"Dolo 650 Tablet","p":"15 Tablet","c":"Fever","a":"Pain / Fever","b":"Dolo","m":"Micro Labs","ch":"Yes"}, ...]
-- A blank value never wipes what is already saved.
create or replace function public.import_item_details(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_total integer; v_added integer; v_updated integer;
begin
  if not public.has_role('admin') then raise exception 'Only Admin can change the item master'; end if;
  create temp table _det on commit drop as
  select nullif(trim(r ->> 'n'), '') as n, coalesce(trim(r ->> 'p'), '') as p,
         nullif(trim(r ->> 'c'), '') as c, nullif(trim(r ->> 'a'), '') as a,
         nullif(trim(r ->> 'b'), '') as b, nullif(trim(r ->> 'm'), '') as m,
         case when lower(trim(coalesce(r ->> 'ch', ''))) in ('yes', 'y', 'chronic', 'true', '1') then true
              when lower(trim(coalesce(r ->> 'ch', ''))) in ('no', 'n', 'false', '0', 'acute', 'non-chronic', 'non-chronic (acute)') then false
         end as ch
  from jsonb_array_elements(p_rows) r;
  select count(*) into v_total from _det;
  delete from _det where n is null or (c is null and a is null and b is null and m is null and ch is null);

  create temp table _detk on commit drop as
  select distinct on (public.norm_text(n) || '|' || public.norm_text(p))
         public.norm_text(n) || '|' || public.norm_text(p) as k, n, p, c, a, b, m, ch
  from _det;

  with ins as (
    insert into items (name, pack_size, category, ailment, brand, manufacturer, chronic)
    select n, p, c, a, b, m, coalesce(ch, false) from _detk
    on conflict (norm_key) do nothing returning 1)
  select count(*) into v_added from ins;

  with up as (
    update items i set
      category = coalesce(d.c, i.category), ailment = coalesce(d.a, i.ailment),
      brand = coalesce(d.b, i.brand), manufacturer = coalesce(d.m, i.manufacturer),
      chronic = coalesce(d.ch, i.chronic)
    from _detk d
    where i.norm_key = d.k
      and (i.category is distinct from coalesce(d.c, i.category) or i.ailment is distinct from coalesce(d.a, i.ailment)
        or i.brand is distinct from coalesce(d.b, i.brand) or i.manufacturer is distinct from coalesce(d.m, i.manufacturer)
        or i.chronic is distinct from coalesce(d.ch, i.chronic))
    returning 1)
  select count(*) into v_updated from up;

  return jsonb_build_object('rows', v_total, 'added', v_added, 'updated', v_updated,
    'chronic', (select count(*) from items where chronic));
end $$;

-- ids of medicines marked chronic (used by the Min / Max calculation), as one list
drop function if exists public.chronic_items();
create function public.chronic_items()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(id), '[]'::jsonb) from items where chronic and public.is_staff()
$$;

drop function if exists public.order_sheet(integer);
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
  bounce_qty numeric, bounce_dist_id integer, bounce_dist text, bounce_at timestamptz,
  category text, ailment text, brand text, manufacturer text, chronic boolean)
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
         oo.bounce_qty, oo.bounce_dist_id, oo.bounce_dist, oo.bounce_at,
         i.category, i.ailment, i.brand, i.manufacturer, i.chronic
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
-- Reports
-- p_by: 'category' | 'ailment' | 'manufacturer' | 'brand'
-- ---------------------------------------------------------------------
create or replace function public.report_key(p_by text, i items)
returns text language sql immutable as $$
  select coalesce(nullif(trim(case p_by when 'category' then i.category when 'ailment' then i.ailment
                                          when 'manufacturer' then i.manufacturer when 'brand' then i.brand end), ''), '(not set)')
$$;

-- one row per group: sales now / before, purchases now
create or replace function public.report_groups(p_warehouse_id integer, p_from date, p_to date, p_by text)
returns table (grp text, items integer, sales_qty numeric, sales_amt numeric, bills bigint, customers bigint,
               prev_qty numeric, prev_amt numeric, purchase_qty numeric, purchase_amt numeric)
language sql stable security definer set search_path = public as $$
  with p as (select p_from - (p_to - p_from + 1) as pf, p_from - 1 as pt),
  s as (
    select public.report_key(p_by, i) as g, s.item_id, s.sale_date, s.bill_no, s.customer_id, s.qty, s.amount,
           s.sale_date >= p_from as cur
    from sales_lines s join items i on i.id = s.item_id, p
    where s.warehouse_id = p_warehouse_id and s.sale_date between p.pf and p_to
  ), sg as (
    select g, count(distinct item_id) filter (where cur) as items,
           coalesce(sum(qty) filter (where cur), 0) as sq, coalesce(sum(amount) filter (where cur), 0) as sa,
           count(distinct (sale_date, bill_no)) filter (where cur) as bills,
           count(distinct customer_id) filter (where cur) as cust,
           coalesce(sum(qty) filter (where not cur), 0) as pq, coalesce(sum(amount) filter (where not cur), 0) as pa
    from s group by g
  ), pg as (
    select public.report_key(p_by, i) as g, sum(pl.qty) as q, sum(pl.amount) as a
    from purchase_lines pl join items i on i.id = pl.item_id
    where pl.warehouse_id = p_warehouse_id and pl.purchase_date between p_from and p_to
    group by 1
  )
  select coalesce(sg.g, pg.g), coalesce(sg.items, 0)::integer, coalesce(sg.sq, 0), coalesce(sg.sa, 0), coalesce(sg.bills, 0),
         coalesce(sg.cust, 0), coalesce(sg.pq, 0), coalesce(sg.pa, 0), coalesce(pg.q, 0), coalesce(pg.a, 0)
  from sg full join pg on pg.g = sg.g
  where public.is_staff()
  order by 4 desc
$$;

-- medicines inside one group (p_grp null = all medicines)
create or replace function public.report_items(p_warehouse_id integer, p_from date, p_to date, p_by text, p_grp text)
returns table (item_id integer, name text, pack_size text, grp text, sales_qty numeric, sales_amt numeric, bills bigint,
               customers bigint, prev_qty numeric, purchase_qty numeric, purchase_amt numeric)
language sql stable security definer set search_path = public as $$
  with p as (select p_from - (p_to - p_from + 1) as pf),
  s as (
    select s.item_id, s.sale_date, s.bill_no, s.customer_id, s.qty, s.amount, s.sale_date >= p_from as cur
    from sales_lines s join items i on i.id = s.item_id, p
    where s.warehouse_id = p_warehouse_id and s.sale_date between p.pf and p_to
      and (p_grp is null or public.report_key(p_by, i) = p_grp)
  ), sg as (
    select item_id, coalesce(sum(qty) filter (where cur), 0) sq, coalesce(sum(amount) filter (where cur), 0) sa,
           count(*) filter (where cur) bills, count(distinct customer_id) filter (where cur) cust,
           coalesce(sum(qty) filter (where not cur), 0) pq
    from s group by item_id
  ), pg as (
    select pl.item_id, sum(pl.qty) q, sum(pl.amount) a
    from purchase_lines pl join items i on i.id = pl.item_id
    where pl.warehouse_id = p_warehouse_id and pl.purchase_date between p_from and p_to
      and (p_grp is null or public.report_key(p_by, i) = p_grp)
    group by 1
  )
  select i.id, i.name, i.pack_size, public.report_key(coalesce(p_by, 'category'), i),
         coalesce(sg.sq, 0), coalesce(sg.sa, 0), coalesce(sg.bills, 0), coalesce(sg.cust, 0), coalesce(sg.pq, 0),
         coalesce(pg.q, 0), coalesce(pg.a, 0)
  from sg full join pg on pg.item_id = sg.item_id
  join items i on i.id = coalesce(sg.item_id, pg.item_id)
  where public.is_staff()
  order by 6 desc
$$;

-- biggest risers and fallers (medicines), current period vs the one before
create or replace function public.report_movers(p_warehouse_id integer, p_from date, p_to date, p_limit integer default 20)
returns table (direction text, item_id integer, name text, pack_size text, category text, manufacturer text,
               now_qty numeric, prev_qty numeric, change numeric)
language sql stable security definer set search_path = public as $$
  with p as (select p_from - (p_to - p_from + 1) as pf),
  t as (
    select s.item_id, coalesce(sum(s.qty) filter (where s.sale_date >= p_from), 0) as nq,
           coalesce(sum(s.qty) filter (where s.sale_date < p_from), 0) as pq
    from sales_lines s, p
    where s.warehouse_id = p_warehouse_id and s.sale_date between p.pf and p_to
    group by 1
  ), r as (
    (select 'up' as dir, * from t where nq > pq order by nq - pq desc limit p_limit)
    union all
    (select 'down', * from t where pq > nq order by pq - nq desc limit p_limit)
  )
  select r.dir, i.id, i.name, i.pack_size, i.category, i.manufacturer, r.nq, r.pq, r.nq - r.pq
  from r join items i on i.id = r.item_id
  where public.is_staff()
  order by r.dir desc, abs(r.nq - r.pq) desc
$$;

-- sales by hour of day (p_grp null = all medicines)
create or replace function public.report_hourly(p_warehouse_id integer, p_from date, p_to date, p_by text, p_grp text)
returns table (hour integer, sales_qty numeric, sales_amt numeric, bills bigint)
language sql stable security definer set search_path = public as $$
  select extract(hour from s.sale_time)::integer, sum(s.qty), sum(s.amount), count(distinct (s.sale_date, s.bill_no))
  from sales_lines s join items i on i.id = s.item_id
  where s.warehouse_id = p_warehouse_id and s.sale_date between p_from and p_to and s.sale_time is not null
    and (p_grp is null or public.report_key(p_by, i) = p_grp) and public.is_staff()
  group by 1 order by 1
$$;

-- list of values for the filters (categories, manufacturers, …)
create or replace function public.report_keys(p_by text)
returns setof text language sql stable security definer set search_path = public as $$
  select distinct public.report_key(p_by, i) from items i where public.is_staff() order by 1
$$;

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
