-- =====================================================================
-- Update 16 (23 Nov 2026): Purchase returns
--  * Upload the purchase-return file (Date, Reference No, Distributor,
--    Medicines Name, Pack Size, Total Quantity in LOOSE units)
--  * Repeat reports / Buying, not selling count what was KEPT:
--    a return within 7 days of buying the medicine cancels that much purchase
--  * Reports: Returned column; Returns by distributor
--  * Buying, not selling: rewritten to run in one pass (fixes the timeout)
-- Needs 14_admin_sheet_format.sql first.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- =====================================================================
set client_min_messages = warning;

insert into public.settings (key, value, description) values
  ('return_quick_days', '7', 'A purchase return within this many days of buying cancels that purchase in the repeat reports')
on conflict (key) do nothing;

create table if not exists public.return_uploads (
  id           bigint generated always as identity primary key,
  warehouse_id integer not null references public.warehouses (id) on delete cascade,
  file_name    text,
  rows_in_file integer default 0,
  rows_saved   integer default 0,
  rows_already integer default 0,
  rows_skipped integer default 0,
  by_name      text,
  created_at   timestamptz not null default now()
);

create table if not exists public.purchase_returns (
  warehouse_id   integer not null references public.warehouses (id) on delete cascade,
  return_date    date not null,
  ref_no         text not null,
  distributor_id integer not null references public.distributors (id),
  item_id        integer not null references public.items (id) on delete cascade,
  loose_qty      numeric(12,2) not null,      -- as in the file (tablets, ml packs …)
  upload_id      bigint references public.return_uploads (id) on delete set null,
  primary key (warehouse_id, return_date, ref_no, distributor_id, item_id)
);
create index if not exists purchase_returns_item on public.purchase_returns (warehouse_id, item_id, return_date);

alter table public.return_uploads   enable row level security;
alter table public.purchase_returns enable row level security;
drop policy if exists return_uploads_read on public.return_uploads;
create policy return_uploads_read on public.return_uploads for select to authenticated using (public.is_staff());
drop policy if exists purchase_returns_read on public.purchase_returns;
create policy purchase_returns_read on public.purchase_returns for select to authenticated using (public.is_staff());

-- loose units -> strips with the Strips sheet (Qty in Loose); null when the conversion is missing
create or replace function public.ret_strips(p_loose numeric, p_per_strip numeric)
returns numeric language sql immutable as $$
  select case when p_per_strip > 0 then round(p_loose / p_per_strip, 2) end
$$;

-- p_upload_id null = start a new upload; returns its id in the result
-- p_rows: [{"d":"2026-11-21","b":"697","s":"Neelkanth Pharma","n":"HEPADVANT MAX Tablet","p":"10 Tablet","q":170}]
create or replace function public.import_purchase_returns(p_warehouse_id integer, p_upload_id bigint, p_file text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_up bigint := p_upload_id; v_total integer; v_bad integer; v_lines integer; v_saved integer; v_noconv integer;
begin
  if not public.has_role('admin', 'manager', 'purchase') then raise exception 'Not allowed'; end if;
  if v_up is null then
    insert into return_uploads (warehouse_id, file_name, by_name)
    values (p_warehouse_id, p_file, (select coalesce(nullif(full_name, ''), email) from profiles where user_id = auth.uid()))
    returning id into v_up;
  end if;

  create temp table _rr on commit drop as
  select nullif(r ->> 'd', '')::date as d, nullif(trim(r ->> 'b'), '') as b,
         nullif(regexp_replace(trim(r ->> 's'), '\s+', ' ', 'g'), '') as s,
         nullif(trim(r ->> 'n'), '') as n, coalesce(trim(r ->> 'p'), '') as p, nullif(r ->> 'q', '')::numeric as q
  from jsonb_array_elements(p_rows) r;
  select count(*) into v_total from _rr;
  select count(*) into v_bad from _rr where d is null or b is null or s is null or n is null or q is null or q <= 0;
  delete from _rr where d is null or b is null or s is null or n is null or q is null or q <= 0;

  insert into distributors (name) select distinct on (public.norm_text(s)) s from _rr
  on conflict ((public.norm_text(name))) do nothing;
  insert into items (name, pack_size) select distinct on (public.norm_text(n) || '|' || public.norm_text(p)) n, p from _rr
  on conflict (norm_key) do nothing;

  create temp table _rg on commit drop as
  select r.d, r.b, ds.id as distributor_id, i.id as item_id, sum(r.q) as q
  from _rr r
  join distributors ds on public.norm_text(ds.name) = public.norm_text(r.s)
  join items i on i.norm_key = public.norm_text(r.n) || '|' || public.norm_text(r.p)
  group by r.d, r.b, ds.id, i.id;
  select count(*) into v_lines from _rg;

  with ins as (
    insert into purchase_returns (warehouse_id, return_date, ref_no, distributor_id, item_id, loose_qty, upload_id)
    select p_warehouse_id, d, b, distributor_id, item_id, q, v_up from _rg
    on conflict do nothing returning item_id)
  select count(*), count(*) filter (where (select loose_per_strip from items where id = ins.item_id) is null)
  into v_saved, v_noconv from ins;

  update return_uploads set rows_in_file = rows_in_file + v_total, rows_saved = rows_saved + v_saved,
         rows_already = rows_already + (v_lines - v_saved), rows_skipped = rows_skipped + v_bad
  where id = v_up;
  return jsonb_build_object('upload_id', v_up, 'rows', v_total, 'saved', v_saved, 'already', v_lines - v_saved,
                            'skipped', v_bad, 'no_conversion', v_noconv);
end $$;

create or replace function public.returns_status()
returns table (warehouse_id integer, first_date date, last_date date, lines bigint)
language sql stable security definer set search_path = public as $$
  select w.id, min(r.return_date), max(r.return_date), count(r.*)
  from warehouses w left join purchase_returns r on r.warehouse_id = w.id
  where w.active and public.is_staff()
  group by w.id
$$;

-- ---------------------------------------------------------------------
-- Repeat reports: + returns (the app decides "quick" returns itself)
-- ---------------------------------------------------------------------
create or replace function public.purchase_report_data(p_warehouse_id integer, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_days integer := coalesce((select value::int from settings where key = 'repeat_days'), 3);
        v_q integer := coalesce((select value::int from settings where key = 'return_quick_days'), 7);
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'repeat_days', v_days, 'return_days', v_q,
    'purchases', coalesce((
      select jsonb_agg(jsonb_build_array(pl.item_id, pl.purchase_date, pl.bill_no, pl.distributor_id, pl.qty, pl.amount)
                       order by pl.purchase_date)
      from purchase_lines pl
      where pl.warehouse_id = p_warehouse_id and pl.purchase_date between p_from - v_days and p_to), '[]'::jsonb),
    'returns', coalesce((
      select jsonb_agg(jsonb_build_array(r.item_id, r.return_date, r.ref_no, r.distributor_id,
                                         public.ret_strips(r.loose_qty, i.loose_per_strip), r.loose_qty) order by r.return_date)
      from purchase_returns r join items i on i.id = r.item_id
      where r.warehouse_id = p_warehouse_id and r.return_date between p_from - v_days and p_to + v_q), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_array(i.id, i.name, i.pack_size,
               case when public.is_disc(i.id, i.status, p_warehouse_id) then 'discontinued' else 'active' end,
               lv.max_stock, lv.grp,
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
-- Buying, not selling — one pass (was timing out with 20,000+ purchase lines)
-- "Kept" = bought − returns made within return_quick_days of buying
-- ---------------------------------------------------------------------
create or replace function public.buying_not_selling(p_warehouse_id integer, p_from date, p_to date,
                                                     p_min_buys integer, p_min_dists integer, p_sell_pct numeric)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_last date; v_q integer := coalesce((select value::int from settings where key = 'return_quick_days'), 7);
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select max(sale_date) into v_last from sales_lines where warehouse_id = p_warehouse_id;
  if v_last is not null and v_last < p_to then
    p_from := p_from - (p_to - v_last);
    p_to := v_last;
  end if;

  create temp table _pl on commit drop as
  select pl.item_id, pl.purchase_date, pl.bill_no, pl.distributor_id, pl.qty, pl.amount
  from purchase_lines pl where pl.warehouse_id = p_warehouse_id and pl.purchase_date between p_from and p_to;

  create temp table _pur on commit drop as
  select item_id, count(distinct (distributor_id, bill_no)) as buys, count(distinct distributor_id) as dists,
         sum(qty) as qty, sum(amount) as amount, max(purchase_date) as last_buy, min(purchase_date) as first_buy, count(*) as lines
  from _pl group by item_id;
  -- only medicines that could be flagged need the rest of the work
  delete from _pur where not (buys >= p_min_buys or dists >= p_min_dists);

  create temp table _sold on commit drop as
  select item_id, sum(qty) as q from sales_lines
  where warehouse_id = p_warehouse_id and sale_date between p_from and p_to group by item_id;

  -- returns of a medicine within v_q days after one of its purchases in the period
  create temp table _ret on commit drop as
  select r.item_id, sum(coalesce(public.ret_strips(r.loose_qty, i.loose_per_strip), 0)) as strips,
         jsonb_agg(jsonb_build_object('date', r.return_date, 'ref', r.ref_no, 'dist', d.name,
                   'strips', public.ret_strips(r.loose_qty, i.loose_per_strip), 'loose', r.loose_qty) order by r.return_date) as list
  from purchase_returns r join _pur p on p.item_id = r.item_id
  join items i on i.id = r.item_id join distributors d on d.id = r.distributor_id
  where r.warehouse_id = p_warehouse_id and r.return_date between p.first_buy and p.last_buy + v_q
  group by r.item_id;

  create temp table _flag on commit drop as
  select p.*, coalesce(s.q, 0) as sold, coalesce(rt.strips, 0) as returned, rt.list as returns,
         p.qty - coalesce(rt.strips, 0) as kept
  from _pur p left join _sold s on s.item_id = p.item_id left join _ret rt on rt.item_id = p.item_id
  where coalesce(s.q, 0) < (p.qty - coalesce(rt.strips, 0)) * p_sell_pct / 100;

  -- ordered in the app (any distributor) in the 7 days before the bill?
  create temp table _bills on commit drop as
  select pl.item_id,
         jsonb_agg(jsonb_build_object('date', pl.purchase_date, 'bill', pl.bill_no, 'dist', d.name, 'qty', pl.qty,
                   'amount', pl.amount, 'app', a.item_id is not null) order by pl.purchase_date, d.name) as bills,
         count(*) filter (where a.item_id is null) as not_app,
         jsonb_agg(distinct d.name) as dists
  from _pl pl join _flag f on f.item_id = pl.item_id
  join distributors d on d.id = pl.distributor_id
  left join lateral (select ol.item_id from order_lines ol join orders o on o.id = ol.order_id
                     where ol.item_id = pl.item_id and o.warehouse_id = p_warehouse_id and o.cancelled_at is null
                       and o.placed_at::date between pl.purchase_date - 7 and pl.purchase_date limit 1) a on true
  group by pl.item_id;

  -- other codes of the same medicine that DO sell here (name worked out once per medicine)
  create temp table _sim on commit drop as
  with sb as (select s.item_id, s.q, i.name, i.pack_size, public.name_base(i.name) as k
              from _sold s join items i on i.id = s.item_id where s.q > 0),
       fb as (select f.item_id, public.name_base(i.name) as k from _flag f join items i on i.id = f.item_id)
  select fb.item_id, jsonb_agg(jsonb_build_object('name', x.name, 'pack', x.pack_size, 'sold', x.q) order by x.q desc) as similar
  from fb join lateral (select * from sb where sb.k = fb.k and sb.item_id <> fb.item_id order by sb.q desc limit 3) x on true
  group by fb.item_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'item_id', f.item_id, 'name', i.name, 'pack', i.pack_size,
      'buys', f.buys, 'dists', f.dists, 'qty', f.qty, 'amount', f.amount, 'sold', f.sold,
      'returned', f.returned, 'returns', f.returns, 'kept', f.kept,
      'last_buy', f.last_buy, 'not_app', b.not_app, 'lines', f.lines,
      'stock', (select ls.strips from latest_stock ls where ls.warehouse_id = p_warehouse_id and ls.item_id = f.item_id),
      'max', lv.max_stock, 'grp', lv.grp,
      'disc', public.is_disc(i.id, i.status, p_warehouse_id),
      'blocked', (select jsonb_build_object('reason', bl.reason, 'by', bl.by_name, 'at', bl.created_at)
                  from item_blocks bl where bl.item_id = f.item_id and bl.warehouse_id = p_warehouse_id),
      'distributors', b.dists, 'bills', b.bills, 'similar', sm.similar
    ) order by f.kept - f.sold desc), '[]'::jsonb)
  into v
  from _flag f join items i on i.id = f.item_id
  left join _bills b on b.item_id = f.item_id
  left join _sim sm on sm.item_id = f.item_id
  left join item_levels lv on lv.item_id = f.item_id and lv.warehouse_id = p_warehouse_id;
  return v;
end $$;
-- it creates temp tables, so it can't be "stable"
alter function public.buying_not_selling(integer, date, date, integer, integer, numeric) volatile;

-- ---------------------------------------------------------------------
-- Reports: + returned strips (all returns in the period)
-- ---------------------------------------------------------------------
drop function if exists public.report_groups(integer, date, date, text);
create function public.report_groups(p_warehouse_id integer, p_from date, p_to date, p_by text)
returns table (grp text, items integer, sales_qty numeric, sales_amt numeric, bills bigint, customers bigint,
               prev_qty numeric, prev_amt numeric, purchase_qty numeric, purchase_amt numeric, returned_qty numeric)
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
  ), rg as (
    select public.report_key(p_by, i) as g, sum(coalesce(public.ret_strips(r.loose_qty, i.loose_per_strip), 0)) as q
    from purchase_returns r join items i on i.id = r.item_id
    where r.warehouse_id = p_warehouse_id and r.return_date between p_from and p_to
    group by 1
  ), pr as (select coalesce(pg.g, rg.g) as g, coalesce(pg.q, 0) as q, coalesce(pg.a, 0) as a, coalesce(rg.q, 0) as rq
            from pg full join rg on rg.g = pg.g)
  select coalesce(sg.g, pr.g), coalesce(sg.items, 0)::integer, coalesce(sg.sq, 0), coalesce(sg.sa, 0), coalesce(sg.bills, 0),
         coalesce(sg.cust, 0), coalesce(sg.pq, 0), coalesce(sg.pa, 0), coalesce(pr.q, 0), coalesce(pr.a, 0), coalesce(pr.rq, 0)
  from sg full join pr on pr.g = sg.g
  where public.is_staff()
  order by 4 desc
$$;

drop function if exists public.report_items(integer, date, date, text, text);
create function public.report_items(p_warehouse_id integer, p_from date, p_to date, p_by text, p_grp text)
returns table (item_id integer, name text, pack_size text, grp text, sales_qty numeric, sales_amt numeric, bills bigint,
               customers bigint, prev_qty numeric, purchase_qty numeric, purchase_amt numeric, returned_qty numeric)
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
  ), rg as (
    select r.item_id, sum(coalesce(public.ret_strips(r.loose_qty, i.loose_per_strip), 0)) q
    from purchase_returns r join items i on i.id = r.item_id
    where r.warehouse_id = p_warehouse_id and r.return_date between p_from and p_to
      and (p_grp is null or public.report_key(p_by, i) = p_grp)
    group by 1
  ), pr as (select coalesce(pg.item_id, rg.item_id) as item_id, coalesce(pg.q, 0) q, coalesce(pg.a, 0) a, coalesce(rg.q, 0) rq
            from pg full join rg on rg.item_id = pg.item_id)
  select i.id, i.name, i.pack_size, public.report_key(coalesce(p_by, 'category'), i),
         coalesce(sg.sq, 0), coalesce(sg.sa, 0), coalesce(sg.bills, 0), coalesce(sg.cust, 0), coalesce(sg.pq, 0),
         coalesce(pr.q, 0), coalesce(pr.a, 0), coalesce(pr.rq, 0)
  from sg full join pr on pr.item_id = sg.item_id
  join items i on i.id = coalesce(sg.item_id, pr.item_id)
  where public.is_staff()
  order by 6 desc
$$;

-- ---------------------------------------------------------------------
-- Returns by distributor
-- ---------------------------------------------------------------------
create or replace function public.returns_report(p_warehouse_id integer, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q integer := coalesce((select value::int from settings where key = 'return_quick_days'), 7);
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  return jsonb_build_object('quick_days', v_q, 'rows', coalesce((
    with r as (
      select r.*, public.ret_strips(r.loose_qty, i.loose_per_strip) as strips, i.name, i.pack_size,
             -- bought from anyone in the quick_days before this return?
             exists (select 1 from purchase_lines pl where pl.warehouse_id = r.warehouse_id and pl.item_id = r.item_id
                       and pl.purchase_date between r.return_date - v_q and r.return_date) as quick
      from purchase_returns r join items i on i.id = r.item_id
      where r.warehouse_id = p_warehouse_id and r.return_date between p_from and p_to
    ), bought as (
      select distributor_id, sum(qty) as q from purchase_lines
      where warehouse_id = p_warehouse_id and purchase_date between p_from and p_to group by 1
    ), d as (
      select r.distributor_id, count(distinct (r.return_date, r.ref_no)) as challans, count(*) as lines,
             sum(coalesce(r.strips, 0)) as strips, count(*) filter (where r.strips is null) as no_conv,
             sum(coalesce(r.strips, 0)) filter (where r.quick) as quick_strips
      from r group by 1
    )
    select jsonb_agg(jsonb_build_object(
        'dist', ds.name, 'challans', d.challans, 'lines', d.lines, 'strips', d.strips, 'quick_strips', coalesce(d.quick_strips, 0),
        'no_conv', d.no_conv, 'bought', coalesce(b.q, 0),
        'top', (select jsonb_agg(t) from (select r.name, r.pack_size as pack, sum(coalesce(r.strips, 0)) as strips, count(*) as times
                                          from r where r.distributor_id = d.distributor_id
                                          group by r.name, r.pack_size order by 3 desc limit 5) t),
        'lines_list', (select jsonb_agg(jsonb_build_object('date', r.return_date, 'ref', r.ref_no, 'name', r.name, 'pack', r.pack_size,
                                         'loose', r.loose_qty, 'strips', r.strips, 'quick', r.quick) order by r.return_date desc, r.ref_no)
                       from r where r.distributor_id = d.distributor_id))
      order by d.strips desc)
    from d join distributors ds on ds.id = d.distributor_id left join bought b on b.distributor_id = d.distributor_id), '[]'::jsonb));
end $$;

revoke all on public.return_uploads, public.purchase_returns from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;

select 'Update 16 installed' as result;
