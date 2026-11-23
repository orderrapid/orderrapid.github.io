-- =====================================================================
-- Update 14, part 2 (23 Nov 2026): Admin order sheet + tags
--  * Admin uploads an order sheet (Medicine Name, Pack Size, Qty, Tag,
--    Distributor, Note). Its qty replaces the app's; lines stay until ordered.
--  * Possible duplicate codes for the "Check Duplicate" tag
-- Needs 12_short_in_market.sql first.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- =====================================================================
set client_min_messages = warning;

insert into public.settings (key, value, description) values
  ('urgent_days', '2', 'Order Sheet: Fast / Average medicine with stock for less than this many days = Urgent')
on conflict (key) do nothing;

create table if not exists public.admin_order_uploads (
  id           bigint generated always as identity primary key,
  warehouse_id integer not null references public.warehouses (id) on delete cascade,
  file_name    text,
  rows         integer,
  by_name      text,
  created_at   timestamptz not null default now()
);

create table if not exists public.admin_order_lines (
  id             bigint generated always as identity primary key,
  upload_id      bigint references public.admin_order_uploads (id) on delete cascade,
  warehouse_id   integer not null references public.warehouses (id) on delete cascade,
  item_id        integer not null references public.items (id) on delete cascade,
  qty            numeric(10,2) not null check (qty > 0),
  tag            text check (tag in ('urgent', 'regular', 'rare', 'dup')),
  distributor_id integer references public.distributors (id),
  note           text,
  by_name        text,
  created_at     timestamptz not null default now(),
  done_at        timestamptz,     -- ordered
  removed_at     timestamptz      -- removed by Admin, or replaced by a newer upload
);
create index if not exists admin_order_lines_open on public.admin_order_lines (warehouse_id, item_id) where done_at is null and removed_at is null;

alter table public.admin_order_uploads enable row level security;
alter table public.admin_order_lines   enable row level security;
drop policy if exists admin_order_uploads_read on public.admin_order_uploads;
create policy admin_order_uploads_read on public.admin_order_uploads for select to authenticated using (public.is_staff());
drop policy if exists admin_order_lines_read on public.admin_order_lines;
create policy admin_order_lines_read on public.admin_order_lines for select to authenticated using (public.is_staff());

-- p_rows: [{"n":"Naxdom 500","p":"10 Tablet","q":50,"t":"urgent","d":"ABC Pharma","note":"Scheme 10+2"}]
create or replace function public.import_admin_order(p_warehouse_id integer, p_file text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_up bigint; v_by text; v_new_items integer; v_replaced integer; v_lines integer;
begin
  if not public.has_role('admin') then raise exception 'Only Admin can upload an order sheet'; end if;
  v_by := (select coalesce(nullif(full_name, ''), email) from profiles where user_id = auth.uid());

  create temp table _ao on commit drop as
  select trim(r ->> 'n') as n, coalesce(trim(r ->> 'p'), '') as p, nullif(r ->> 'q', '')::numeric as q,
         nullif(lower(trim(r ->> 't')), '') as t, nullif(regexp_replace(trim(coalesce(r ->> 'd', '')), '\s+', ' ', 'g'), '') as d,
         nullif(trim(r ->> 'note'), '') as note
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
         ds.id as distributor_id, a.note
  from _ao a
  join items i on i.norm_key = public.norm_text(a.n) || '|' || public.norm_text(a.p)
  left join distributors ds on a.d is not null and public.norm_text(ds.name) = public.norm_text(a.d)
  order by i.id, a.q desc;

  -- a newer upload replaces an open line for the same medicine
  with r as (update admin_order_lines l set removed_at = now()
             where l.warehouse_id = p_warehouse_id and l.done_at is null and l.removed_at is null
               and l.item_id in (select item_id from _aok) returning 1)
  select count(*) into v_replaced from r;

  insert into admin_order_lines (upload_id, warehouse_id, item_id, qty, tag, distributor_id, note, by_name)
  select v_up, p_warehouse_id, item_id, q, tag, distributor_id, note, v_by from _aok;
  get diagnostics v_lines = row_count;

  return jsonb_build_object('lines', v_lines, 'new_items', v_new_items, 'replaced', v_replaced, 'upload_id', v_up);
end $$;

-- open Admin lines for the Order Sheet, with what the app knows about each medicine
create or replace function public.admin_order_open(p_warehouse_id integer)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'item_id', l.item_id, 'qty', l.qty, 'tag', l.tag, 'distributor_id', l.distributor_id,
      'note', l.note, 'by', l.by_name, 'at', l.created_at,
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

create or replace function public.remove_admin_lines(p_warehouse_id integer, p_ids bigint[])
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.has_role('admin') then raise exception 'Only Admin can remove Admin order lines'; end if;
  update admin_order_lines set removed_at = now()
  where warehouse_id = p_warehouse_id and done_at is null and removed_at is null
    and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

-- Better "same medicine" key (also used by Buying, not selling):
-- Tab/Tablet, Cap/Capsule, Syp/Syrup … count as the same word; units (mg, ml …) are dropped;
-- single letters like L, G, N, V are kept ("Cetcip L" is not "Cetcip").
create or replace function public.name_base(t text)
returns text language sql immutable parallel safe as $$
  select coalesce((select string_agg(distinct w, ' ' order by w) from (
           select case when x in ('tab', 'tabs', 'tablet', 'tablets') then 'tablet'
                       when x in ('cap', 'caps', 'capsule', 'capsules') then 'capsule'
                       when x in ('syp', 'syr', 'syrup', 'syrups') then 'syrup'
                       when x in ('inj', 'injection', 'injections') then 'injection'
                       when x in ('susp', 'suspension') then 'suspension'
                       when x in ('oint', 'ointment') then 'ointment'
                       when x in ('sol', 'soln', 'solution') then 'solution'
                       when x in ('drop', 'drops') then 'drops'
                       else x end as w
           from (select m[1] as x from regexp_matches(lower(coalesce(t, '')), '[a-z]+', 'g') m) a
           where x not in ('mg', 'ml', 'mcg', 'gm', 'kg', 'ltr', 'iu', 'x', 'pcs', 'pc', 'piece', 'pieces')) b), '')
      || '|' ||
      coalesce((select string_agg(distinct m[1], ',' order by m[1]) from regexp_matches(coalesce(t, ''), '([0-9]+(?:\.[0-9]+)?)', 'g') m), '')
$$;

-- "Check Duplicate": another code that looks like the same medicine
-- (same name words + numbers, same pack) and is alive at this warehouse
-- (stock in the latest upload, or sold in the last 60 days)
create or replace function public.dup_candidates(p_warehouse_id integer)
returns jsonb language sql stable security definer set search_path = public as $$
  with alive as (
    select distinct item_id from latest_stock where warehouse_id = p_warehouse_id
    union
    select distinct item_id from sales_lines where warehouse_id = p_warehouse_id and sale_date >= current_date - 60
  ), b as (
    -- same name words + numbers AND same pack numbers: "Telma 40 Tablet / 15 Tablet" = "TELMA 40MG TAB / 15 Tab"
    -- (different pack sizes of one brand are real, separate products)
    select i.id, i.name, i.pack_size,
           public.name_base(i.name) || '#' || coalesce((select string_agg(m[1], ',' order by m[1])
             from regexp_matches(coalesce(i.pack_size, ''), '([0-9]+(?:\.[0-9]+)?)', 'g') m), '') as k
    from items i join alive a on a.item_id = i.id
    where i.status = 'active'
  ), k as (select k from b where k not like '|%' group by k having count(*) > 1)
  select coalesce(jsonb_object_agg(b1.id, (select jsonb_agg(b2.name || ' (' || b2.pack_size || ')') from b b2 where b2.k = b1.k and b2.id <> b1.id)), '{}'::jsonb)
  from b b1 join k on k.k = b1.k
  where public.is_staff()
$$;

-- placing an order closes the Admin lines for those medicines
create or replace function public.place_orders(p_warehouse_id integer, p_note text, p_lines jsonb, p_expected jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_d integer; v_id bigint; v_no text; v_out jsonb := '[]'::jsonb; v_blocked text;
begin
  if not public.has_role('admin', 'purchase') then raise exception 'Only Admin or Purchase Team can place orders'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l where nullif(l ->> 'distributor_id', '') is null) then
    raise exception 'Choose a distributor for every medicine';
  end if;
  select string_agg(i.name, ', ') into v_blocked
  from jsonb_array_elements(p_lines) l
  join item_blocks b on b.item_id = (l ->> 'item_id')::integer and b.warehouse_id = p_warehouse_id
  join items i on i.id = b.item_id
  where (l ->> 'qty')::numeric > 0;
  if v_blocked is not null then raise exception 'Blocked by Admin, untick to continue: %', v_blocked; end if;
  for v_d in select distinct (l ->> 'distributor_id')::integer from jsonb_array_elements(p_lines) l order by 1 loop
    v_no := public.next_order_no(p_warehouse_id);
    insert into orders (warehouse_id, distributor_id, placed_by, note, order_no, expected_at)
    values (p_warehouse_id, v_d, auth.uid(), nullif(trim(p_note), ''), v_no,
            nullif(coalesce(p_expected, '{}'::jsonb) ->> v_d::text, '')::timestamptz)
    returning id into v_id;
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
  update admin_order_lines set done_at = now()
  where warehouse_id = p_warehouse_id and done_at is null and removed_at is null
    and item_id in (select (l ->> 'item_id')::integer from jsonb_array_elements(p_lines) l where (l ->> 'qty')::numeric > 0);
  return v_out;
end $$;

revoke all on public.admin_order_uploads, public.admin_order_lines from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;

select 'Update 14 part 2 installed' as result;
