-- =====================================================================
-- Update 15 (23 Nov 2026): Admin order sheet in your own format
--  Medicine Name, Pack Size, Closing Stock (Strip), Min, Max, Qty to Order,
--  7 / 15 / 30 Days Sale, Tag. The sheet's stock, Min / Max and sales are kept
--  and shown where the app has none of its own.
-- Needs 13_admin_order_sheet.sql first.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- =====================================================================
set client_min_messages = warning;

alter table public.admin_order_lines add column if not exists sheet_closing numeric(12,2);
alter table public.admin_order_lines add column if not exists sheet_min     numeric(12,2);
alter table public.admin_order_lines add column if not exists sheet_max     numeric(12,2);
alter table public.admin_order_lines add column if not exists sheet_s7      numeric(12,2);
alter table public.admin_order_lines add column if not exists sheet_s15     numeric(12,2);
alter table public.admin_order_lines add column if not exists sheet_s30     numeric(12,2);

create or replace function public.import_admin_order(p_warehouse_id integer, p_file text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_up bigint; v_by text; v_new_items integer; v_replaced integer; v_lines integer;
begin
  if not public.has_role('admin') then raise exception 'Only Admin can upload an order sheet'; end if;
  v_by := (select coalesce(nullif(full_name, ''), email) from profiles where user_id = auth.uid());

  create temp table _ao on commit drop as
  select trim(r ->> 'n') as n, coalesce(trim(r ->> 'p'), '') as p, nullif(r ->> 'q', '')::numeric as q,
         nullif(lower(trim(r ->> 't')), '') as t, nullif(regexp_replace(trim(coalesce(r ->> 'd', '')), '\s+', ' ', 'g'), '') as d,
         nullif(trim(r ->> 'note'), '') as note,
         nullif(r ->> 'c', '')::numeric as c, nullif(r ->> 'mn', '')::numeric as mn, nullif(r ->> 'mx', '')::numeric as mx,
         nullif(r ->> 's7', '')::numeric as s7, nullif(r ->> 's15', '')::numeric as s15, nullif(r ->> 's30', '')::numeric as s30
  from jsonb_array_elements(p_rows) r
  where nullif(trim(r ->> 'n'), '') is not null and nullif(r ->> 'q', '')::numeric > 0;

  with ins as (insert into items (name, pack_size)
               select distinct on (public.norm_text(n) || '|' || public.norm_text(p)) n, p from _ao
               on conflict (norm_key) do nothing returning 1)
  select count(*) into v_new_items from ins;
  insert into distributors (name)
  select distinct on (public.norm_text(d)) d from _ao where d is not null
  on conflict ((public.norm_text(name))) do nothing;

  insert into admin_order_uploads (warehouse_id, file_name, rows, by_name)
  values (p_warehouse_id, p_file, (select count(*) from _ao), v_by) returning id into v_up;

  create temp table _aok on commit drop as
  select distinct on (i.id) i.id as item_id, a.q,
         case when a.t like 'urg%' then 'urgent' when a.t like 'reg%' then 'regular' when a.t like 'rare%' then 'rare'
              when a.t like '%dup%' then 'dup' end as tag,
         ds.id as distributor_id, a.note, a.c, a.mn, a.mx, a.s7, a.s15, a.s30
  from _ao a
  join items i on i.norm_key = public.norm_text(a.n) || '|' || public.norm_text(a.p)
  left join distributors ds on a.d is not null and public.norm_text(ds.name) = public.norm_text(a.d)
  order by i.id, a.q desc;

  -- a newer upload replaces an open line for the same medicine
  with r as (update admin_order_lines l set removed_at = now()
             where l.warehouse_id = p_warehouse_id and l.done_at is null and l.removed_at is null
               and l.item_id in (select item_id from _aok) returning 1)
  select count(*) into v_replaced from r;

  insert into admin_order_lines (upload_id, warehouse_id, item_id, qty, tag, distributor_id, note, by_name,
                                 sheet_closing, sheet_min, sheet_max, sheet_s7, sheet_s15, sheet_s30)
  select v_up, p_warehouse_id, item_id, q, tag, distributor_id, note, v_by, c, mn, mx, s7, s15, s30 from _aok;
  get diagnostics v_lines = row_count;

  return jsonb_build_object('lines', v_lines, 'new_items', v_new_items, 'replaced', v_replaced, 'upload_id', v_up);
end $$;

create or replace function public.admin_order_open(p_warehouse_id integer)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'item_id', l.item_id, 'qty', l.qty, 'tag', l.tag, 'distributor_id', l.distributor_id,
      'note', l.note, 'by', l.by_name, 'at', l.created_at,
      'sheet', jsonb_build_object('closing', l.sheet_closing, 'min', l.sheet_min, 'max', l.sheet_max,
                                  's7', l.sheet_s7, 's15', l.sheet_s15, 's30', l.sheet_s30),
      'name', i.name, 'pack_size', i.pack_size, 'category', i.category, 'ailment', i.ailment, 'brand', i.brand,
      'manufacturer', i.manufacturer, 'chronic', i.chronic,
      'grp', lv.grp, 'min_stock', lv.min_stock, 'max_stock', lv.max_stock, 'per_day', lv.per_day,
      'qty_7', lv.qty_7, 'qty_30', lv.qty_30, 'qty_60', lv.qty_60, 'qty_90', lv.qty_90, 'last_sold', lv.last_sold,
      'strips', (select ls.strips from latest_stock ls where ls.warehouse_id = p_warehouse_id and ls.item_id = l.item_id))
      order by l.created_at), '[]'::jsonb)
  from admin_order_lines l join items i on i.id = l.item_id
  left join item_levels lv on lv.item_id = l.item_id and lv.warehouse_id = p_warehouse_id
  where public.is_staff() and l.warehouse_id = p_warehouse_id and l.done_at is null and l.removed_at is null
$$;

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;

select 'Update 15 installed' as result;
