-- =====================================================================
-- Update 4 (20 Nov 2026): the Orders screen checks ONLY the medicines in
-- the latest stock upload (full stock or just what sold). Medicines not
-- in the file are left out instead of counting as 0 stock.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- =====================================================================
set client_min_messages = warning;

-- Everything the order screen needs in one call, for the medicines in
-- the LATEST stock upload only (a full count or just what sold — either
-- way, only uploaded medicines are checked): levels + stock + on order.
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
  join st on st.item_id = i.id
  left join oo on oo.item_id = i.id
  where public.is_staff()
$$;

revoke execute on function public.order_sheet(integer) from anon, public;
grant execute on function public.order_sheet(integer) to authenticated;
