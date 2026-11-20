-- =====================================================================
-- Update 10 (20 Nov 2026):
--  * Item master open to everyone (view); Admin + Manager upload / edit
--  * Discontinued per warehouse (or all warehouses)
--  * All medicines list with counts, upload history, edit one medicine
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- (Supabase may warn about "destructive operations": only FUNCTIONS are
--  dropped and recreated. No data is removed.)
-- =====================================================================
set client_min_messages = warning;

-- Admin or Manager may change the item master
create or replace function public.can_edit_items()
returns boolean language sql stable as $$
  select public.has_role('admin', 'manager')
$$;

-- discontinued in one warehouse only (items.status = 'discontinued' means all warehouses)
create table if not exists public.item_discontinued (
  item_id      integer not null references public.items (id) on delete cascade,
  warehouse_id integer not null references public.warehouses (id) on delete cascade,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  primary key (item_id, warehouse_id)
);

-- what was uploaded to the item master, by whom
create table if not exists public.item_uploads (
  id           integer generated always as identity primary key,
  kind         text not null,            -- strips | details | discontinue
  file_name    text,
  sheet        text,
  warehouse_id integer references public.warehouses (id),   -- discontinue only; null = all
  rows         integer,
  added        integer,
  updated      integer,
  uploaded_by  uuid default auth.uid(),
  by_name      text,
  created_at   timestamptz not null default now()
);

alter table public.item_discontinued enable row level security;
alter table public.item_uploads      enable row level security;
drop policy if exists item_discontinued_read on public.item_discontinued;
create policy item_discontinued_read on public.item_discontinued for select to authenticated using (public.is_staff());
drop policy if exists item_uploads_read on public.item_uploads;
create policy item_uploads_read on public.item_uploads for select to authenticated using (public.is_staff());

-- is this medicine discontinued for this warehouse?
create or replace function public.is_disc(p_item_id integer, p_status text, p_warehouse_id integer)
returns boolean language sql stable security definer set search_path = public as $$
  select p_status = 'discontinued'
      or exists (select 1 from item_discontinued d where d.item_id = p_item_id and d.warehouse_id = p_warehouse_id)
$$;

-- ---------------------------------------------------------------------
-- Uploads: Admin + Manager
-- ---------------------------------------------------------------------
create or replace function public.import_item_master(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_total integer; v_added integer; v_updated integer;
begin
  if not public.can_edit_items() then raise exception 'Only Admin or Manager can change the item master'; end if;

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

create or replace function public.import_item_details(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_total integer; v_added integer; v_updated integer;
begin
  if not public.can_edit_items() then raise exception 'Only Admin or Manager can change the item master'; end if;
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

-- Duplicate Items sheet; p_warehouse_id null = all warehouses
drop function if exists public.mark_discontinued(jsonb);
create or replace function public.mark_discontinued(p_rows jsonb, p_warehouse_id integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_added integer; v_marked integer;
begin
  if not public.can_edit_items() then raise exception 'Only Admin or Manager can change the item master'; end if;
  create temp table _dc on commit drop as
  select distinct on (public.norm_text(n) || '|' || public.norm_text(p)) n, p, public.norm_text(n) || '|' || public.norm_text(p) as k
  from (select trim(r ->> 'n') as n, coalesce(trim(r ->> 'p'), '') as p from jsonb_array_elements(p_rows) r
        where coalesce(r ->> 'x', '') ilike '%discontinu%' and nullif(trim(r ->> 'n'), '') is not null) s;
  with ins as (insert into items (name, pack_size, status)
               select n, p, case when p_warehouse_id is null then 'discontinued' else 'active' end from _dc
               on conflict (norm_key) do nothing returning 1)
  select count(*) into v_added from ins;
  if p_warehouse_id is null then
    with up as (update items i set status = 'discontinued' from _dc
                where i.norm_key = _dc.k and i.status <> 'discontinued' returning 1)
    select count(*) + v_added into v_marked from up;
  else
    with up as (insert into item_discontinued (item_id, warehouse_id)
                select i.id, p_warehouse_id from items i join _dc on _dc.k = i.norm_key
                on conflict do nothing returning 1)
    select count(*) into v_marked from up;
  end if;
  return jsonb_build_object('rows', (select count(*) from _dc), 'marked', v_marked, 'added', v_added);
end $$;

create or replace function public.log_item_upload(p_kind text, p_file text, p_sheet text, p_warehouse_id integer,
                                                  p_rows integer, p_added integer, p_updated integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit_items() then raise exception 'Only Admin or Manager can change the item master'; end if;
  insert into item_uploads (kind, file_name, sheet, warehouse_id, rows, added, updated, by_name)
  values (p_kind, p_file, p_sheet, p_warehouse_id, p_rows, p_added, p_updated,
          (select coalesce(nullif(full_name, ''), email) from profiles where user_id = auth.uid()));
end $$;

-- ---------------------------------------------------------------------
-- Viewing: everyone
-- ---------------------------------------------------------------------
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
  where public.is_staff()
  order by 6 desc, 7 desc, 2
$$;

create or replace function public.items_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'total',           (select count(*) from items),
    'no_conv',         (select count(*) from items_to_check),
    'no_category',     (select count(*) from items where category is null),
    'no_manufacturer', (select count(*) from items where manufacturer is null),
    'chronic',         (select count(*) from items where chronic),
    'discontinued',    (select count(*) from items i where i.status = 'discontinued'
                          or exists (select 1 from item_discontinued d where d.item_id = i.id)));
end $$;

-- p_filter: all | no_conv | no_category | no_manufacturer | chronic | discontinued
create or replace function public.items_list(p_q text, p_filter text, p_offset integer, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  with f as (
    select i.*, coalesce((select array_agg(d.warehouse_id order by d.warehouse_id) from item_discontinued d where d.item_id = i.id), '{}') as dw
    from items i
    where (coalesce(trim(p_q), '') = '' or i.name ilike '%' || trim(p_q) || '%')
      and case coalesce(p_filter, 'all')
            when 'no_conv' then public.conversion_problem(i.pack_size, i.loose_per_strip) is not null and i.status = 'active'
            when 'no_category' then i.category is null
            when 'no_manufacturer' then i.manufacturer is null
            when 'chronic' then i.chronic
            when 'discontinued' then i.status = 'discontinued' or exists (select 1 from item_discontinued d where d.item_id = i.id)
            else true end
  ), pg as (
    select * from f order by name, pack_size offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 5000)
  )
  select jsonb_build_object('total', (select count(*) from f),
    'rows', coalesce((select jsonb_agg(jsonb_build_array(id, name, pack_size, loose_per_strip, category, ailment, brand,
                       manufacturer, chronic, status, dw, updated_at) order by name, pack_size) from pg), '[]'::jsonb))
  into v;
  return v;
end $$;

-- edit one medicine (blank = clear)
create or replace function public.update_item(p_id integer, p_loose numeric, p_category text, p_ailment text, p_brand text,
                                              p_manufacturer text, p_chronic boolean, p_disc_all boolean, p_disc_wh integer[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit_items() then raise exception 'Only Admin or Manager can change the item master'; end if;
  if p_loose is not null and p_loose <= 0 then raise exception 'Qty in Loose must be more than 0'; end if;
  update items set loose_per_strip = p_loose,
    category = nullif(trim(p_category), ''), ailment = nullif(trim(p_ailment), ''),
    brand = nullif(trim(p_brand), ''), manufacturer = nullif(trim(p_manufacturer), ''),
    chronic = coalesce(p_chronic, false),
    status = case when p_disc_all then 'discontinued' else 'active' end
  where id = p_id;
  if not found then raise exception 'Medicine not found'; end if;
  delete from item_discontinued where item_id = p_id and not (warehouse_id = any(coalesce(p_disc_wh, '{}')));
  insert into item_discontinued (item_id, warehouse_id)
  select p_id, w from unnest(coalesce(p_disc_wh, '{}')) w on conflict do nothing;
end $$;

-- fix just the loose-to-strip conversion (Needs checking list)
create or replace function public.set_item_conversion(p_id integer, p_loose numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit_items() then raise exception 'Only Admin or Manager can change the item master'; end if;
  if p_loose is not null and p_loose <= 0 then raise exception 'Qty in Loose must be more than 0'; end if;
  update items set loose_per_strip = p_loose where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- Order Sheet: + disc (discontinued for this warehouse)
-- ---------------------------------------------------------------------
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
  category text, ailment text, brand text, manufacturer text, chronic boolean, disc boolean)
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
         i.category, i.ailment, i.brand, i.manufacturer, i.chronic,
         (i.status = 'discontinued' or dc.item_id is not null)
  from items i
  left join item_levels lv on lv.item_id = i.id and lv.warehouse_id = p_warehouse_id
  join st on st.item_id = i.id
  left join oo on oo.item_id = i.id
  left join item_discontinued dc on dc.item_id = i.id and dc.warehouse_id = p_warehouse_id
  left join lateral (
    select o.distributor_id from order_lines ol join orders o on o.id = ol.order_id
    where ol.item_id = i.id and o.warehouse_id = p_warehouse_id and o.cancelled_at is null and o.distributor_id is not null
    order by o.placed_at desc limit 1) ud on true
  where public.is_staff()
$$;

-- ---------------------------------------------------------------------
-- Purchase report: "discontinued" now per warehouse
-- ---------------------------------------------------------------------
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

revoke all on public.item_discontinued, public.item_uploads from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;

select 'Update 10 installed' as result;
