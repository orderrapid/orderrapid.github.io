-- =====================================================================
-- Update 5 (20 Nov 2026):
--  * Sold 7 days and Sold 60 days on the Order Sheet
--  * a distributor per medicine; one order per distributor
--  * challan no. and invoice no. on each order
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- (Supabase may warn about "destructive operations": the only drop is of
--  the order_sheet FUNCTION, recreated straight after. No data is removed.)
-- =====================================================================
set client_min_messages = warning;

alter table public.item_levels add column if not exists qty_7  numeric(10,2);
alter table public.item_levels add column if not exists qty_60 numeric(10,2);

alter table public.orders add column if not exists challan_no      text;
alter table public.orders add column if not exists invoice_no      text;
alter table public.orders add column if not exists invoice_date    date;
alter table public.orders add column if not exists refs_updated_at timestamptz;
alter table public.orders add column if not exists refs_updated_by uuid references auth.users(id);

create index if not exists order_lines_item on public.order_lines (item_id);

create or replace function public.save_levels(p_warehouse_id integer, p_as_of date, p_sales_up_to date, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  delete from item_levels where warehouse_id = p_warehouse_id;
  insert into item_levels (warehouse_id, item_id, grp, growing, speed, pattern, why, per_day, normal_sale, big_sale,
    weeks_sold, min_stock, max_stock, can_order, lasts_days, warning, qty_7, qty_30, qty_60, qty_90, bills_30, cust_30, cust_90,
    total_bills, days_selling, last_sold, days_since, odd_note)
  select p_warehouse_id, x.* from jsonb_to_recordset(p_rows) as x(
    item_id integer, grp text, growing boolean, speed text, pattern text, why text, per_day numeric, normal_sale numeric,
    big_sale numeric, weeks_sold smallint, min_stock integer, max_stock integer, can_order boolean, lasts_days numeric,
    warning text, qty_7 numeric, qty_30 numeric, qty_60 numeric, qty_90 numeric, bills_30 integer, cust_30 integer, cust_90 integer,
    total_bills integer, days_selling integer, last_sold date, days_since integer, odd_note text);
  get diagnostics v_n = row_count;
  insert into level_runs (warehouse_id, as_of, sales_up_to, computed_at, computed_by, items)
  values (p_warehouse_id, p_as_of, p_sales_up_to, now(), auth.uid(), v_n)
  on conflict (warehouse_id) do update set as_of = excluded.as_of, sales_up_to = excluded.sales_up_to,
    computed_at = excluded.computed_at, computed_by = excluded.computed_by, items = excluded.items;
  return v_n;
end $$;

-- the list of columns changes, so the function is replaced in full
drop function if exists public.order_sheet(integer);
create function public.order_sheet(p_warehouse_id integer)
returns table (
  item_id integer, name text, pack_size text, grp text, growing boolean, speed text, pattern text, why text,
  per_day numeric, normal_sale numeric, weeks_sold smallint, min_stock integer, max_stock integer, can_order boolean,
  lasts_days numeric, warning text, qty_7 numeric, qty_30 numeric, qty_60 numeric, qty_90 numeric, cust_30 integer, total_bills integer,
  days_selling integer, last_sold date, days_since integer, odd_note text,
  loose_qty numeric, loose_per_strip numeric, closing numeric, stock_flag text,
  open_qty numeric, today_qty numeric, last_order_at timestamptz, last_order_qty numeric, last_order_by text,
  last_order_distributor text, usual_distributor_id integer)
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
         ud.distributor_id
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


-- Place one order per distributor in a single step.
-- p_lines: [{"item_id":12,"qty":10,"suggested":8,"distributor_id":3}, ...]
create or replace function public.place_orders(p_warehouse_id integer, p_note text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_d integer; v_id bigint; v_out jsonb := '[]'::jsonb;
begin
  if not public.has_role('admin', 'purchase') then raise exception 'Only Admin or Purchase Team can place orders'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l where nullif(l ->> 'distributor_id', '') is null) then
    raise exception 'Choose a distributor for every medicine';
  end if;
  for v_d in select distinct (l ->> 'distributor_id')::integer from jsonb_array_elements(p_lines) l loop
    insert into orders (warehouse_id, distributor_id, placed_by, note)
    values (p_warehouse_id, v_d, auth.uid(), nullif(trim(p_note), '')) returning id into v_id;
    insert into order_lines (order_id, item_id, qty, suggested_qty)
    select v_id, (l ->> 'item_id')::integer, sum((l ->> 'qty')::numeric), max(nullif(l ->> 'suggested', '')::numeric)
    from jsonb_array_elements(p_lines) l
    where (l ->> 'distributor_id')::integer = v_d and (l ->> 'qty')::numeric > 0
    group by 2;
    update orders set lines = (select count(*) from order_lines where order_id = v_id),
                      total_qty = (select coalesce(sum(qty), 0) from order_lines where order_id = v_id)
    where id = v_id;
    v_out := v_out || jsonb_build_object('order_id', v_id, 'distributor_id', v_d);
  end loop;
  return v_out;
end $$;

-- Challan no. (often straight away from the distributor's app) and
-- invoice no. (a few hours later). One invoice per order.
create or replace function public.set_order_refs(p_order_id bigint, p_challan text, p_invoice text, p_invoice_date date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin', 'purchase') then raise exception 'Only Admin or Purchase Team can edit invoice / challan'; end if;
  update orders set
    challan_no = nullif(trim(p_challan), ''),
    invoice_no = nullif(trim(p_invoice), ''),
    invoice_date = case when nullif(trim(p_invoice), '') is null then null else coalesce(p_invoice_date, current_date) end,
    refs_updated_at = now(), refs_updated_by = auth.uid()
  where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
end $$;

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;
