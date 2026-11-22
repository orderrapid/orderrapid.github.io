-- =====================================================================
-- Update 13 (23 Nov 2026): Turn Around Time
--  * Expected delivery time when placing an order (default = distributor's usual time)
--  * Arrival time when receiving (typed by the team, or from the purchase file)
--  * TAT report: delivery per distributor, on-time %, waiting orders,
--    bounce follow-up time, bounced medicines not re-ordered yet
-- Needs update 12 (10_buying_not_selling.sql) first.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- =====================================================================
set client_min_messages = warning;

alter table public.orders add column if not exists expected_at    timestamptz;
alter table public.orders add column if not exists arrived_at     timestamptz;
alter table public.orders add column if not exists arrival_source text;   -- manual | purchase upload

-- orders received by hand before today: the click time is the best we have
update public.orders set arrived_at = received_at, arrival_source = 'manual'
where received_at is not null and arrived_at is null and coalesce(received_source, 'manual') = 'manual';

insert into public.settings (key, value, description) values
  ('tat_target_hours', '24', 'Turn Around Time: delivery target in hours'),
  ('tat_bounce_hours', '4',  'Turn Around Time: bounce follow-up target in hours')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Receiving, now with the arrival time
-- ---------------------------------------------------------------------
drop function if exists public.receive_order(bigint, jsonb, text);
create or replace function public.receive_order(p_order_id bigint, p_lines jsonb, p_source text default 'manual',
                                                p_arrived_at timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_placed timestamptz; v_manual boolean := coalesce(p_source, 'manual') = 'manual';
begin
  if not public.has_role('admin', 'purchase', 'manager') then raise exception 'Not allowed'; end if;
  select placed_at into v_placed from orders where id = p_order_id;
  if v_placed is null then raise exception 'Order not found'; end if;
  if v_manual and p_arrived_at is not null then
    if p_arrived_at < v_placed - interval '5 minutes' then raise exception 'Arrival time is before the order was placed'; end if;
    if p_arrived_at > now() + interval '10 minutes' then raise exception 'Arrival time is in the future'; end if;
  end if;
  -- a time from a purchase file is used only if it makes sense
  if not v_manual and (p_arrived_at < v_placed - interval '5 minutes' or p_arrived_at > now() + interval '1 day') then
    p_arrived_at := null;
  end if;

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
                    received_source = coalesce(p_source, 'manual'), cancelled_at = null,
                    -- typed by the team: always wins. From a file: only if nothing typed yet.
                    arrived_at = case when v_manual then coalesce(p_arrived_at, arrived_at, now())
                                      else coalesce(arrived_at, p_arrived_at) end,
                    arrival_source = case when v_manual then 'manual'
                                          when arrived_at is null and p_arrived_at is not null then 'purchase upload'
                                          else arrival_source end
  where id = p_order_id;
end $$;

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
    arrived_at   = case when p_status = 'open' then null else arrived_at end,
    arrival_source = case when p_status = 'open' then null else arrival_source end,
    cancelled_at = case when p_status = 'cancelled' then now() when p_status = 'open' then null else cancelled_at end
  where id = p_order_id;
  if p_status = 'open' then update order_lines set supplied_qty = null, bounced = false where order_id = p_order_id; end if;
end $$;

create or replace function public.set_order_expected(p_order_id bigint, p_expected timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin', 'purchase', 'manager') then raise exception 'Not allowed'; end if;
  update orders set expected_at = p_expected where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Purchase upload: optional arrival time column ("t") per bill
-- ---------------------------------------------------------------------
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
         nullif(r ->> 'q', '')::numeric as q, nullif(r ->> 'a', '')::numeric as a,
         nullif(r ->> 't', '')::timestamptz as t
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
  select min(r.d) as d, r.b, ds.id as distributor_id, i.id as item_id, sum(r.q) as q, sum(r.a) as a, min(r.t) as t
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

  for m in
    select o.id as order_id, g.b, g.distributor_id, min(g.t) as t
    from (select b, distributor_id, min(t) as t from _pg group by b, distributor_id) g
    join orders o on o.warehouse_id = v_wh and o.distributor_id = g.distributor_id and o.cancelled_at is null
     and (public.norm_text(o.invoice_no) = public.norm_text(g.b) or public.norm_text(o.challan_no) = public.norm_text(g.b))
    group by o.id, g.b, g.distributor_id
  loop
    perform public.receive_order(m.order_id,
      (select coalesce(jsonb_agg(jsonb_build_object('item_id', ol.item_id, 'supplied',
                coalesce((select sum(pl.qty) from purchase_lines pl where pl.warehouse_id = v_wh and pl.distributor_id = m.distributor_id
                          and pl.bill_no = m.b and pl.item_id = ol.item_id), 0))), '[]'::jsonb)
       from order_lines ol where ol.order_id = m.order_id),
      'purchase upload', m.t);
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

-- ---------------------------------------------------------------------
-- Placing orders: + expected delivery per distributor {"12":"2026-11-23T16:00:00+05:30"}
-- ---------------------------------------------------------------------
drop function if exists public.place_orders(integer, text, jsonb);
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
  return v_out;
end $$;

create or replace function public.place_order(p_warehouse_id integer, p_distributor_id integer, p_note text, p_lines jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_res jsonb;
begin
  if p_distributor_id is null then raise exception 'Choose a distributor'; end if;
  select public.place_orders(p_warehouse_id, p_note,
    (select jsonb_agg(l || jsonb_build_object('distributor_id', p_distributor_id)) from jsonb_array_elements(p_lines) l), null)
    into v_res;
  return (v_res -> 0 ->> 'order_id')::bigint;
end $$;

-- ---------------------------------------------------------------------
-- Usual delivery time per distributor (hours, last 90 days; null warehouse = all)
-- ---------------------------------------------------------------------
create or replace function public.distributor_tat(p_warehouse_id integer default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(distributor_id, jsonb_build_object('hours', round(h, 1), 'orders', n)), '{}'::jsonb)
  from (select distributor_id, avg(greatest(extract(epoch from arrived_at - placed_at), 0) / 3600) as h, count(*) as n
        from orders
        where public.is_staff() and cancelled_at is null and arrived_at is not null and arrived_at >= placed_at - interval '5 minutes'
          and placed_at >= now() - interval '90 days'
          and (p_warehouse_id is null or warehouse_id = p_warehouse_id)
        group by distributor_id) x
$$;

-- ---------------------------------------------------------------------
-- The report
-- ---------------------------------------------------------------------
create or replace function public.tat_report(p_warehouse_id integer, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  with o as (
    select o.* from orders o
    where o.cancelled_at is null and (p_warehouse_id is null or o.warehouse_id = p_warehouse_id)
      and o.placed_at >= p_from::timestamp at time zone 'Asia/Kolkata'
      and o.placed_at <  (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
  ), pn as (select user_id, coalesce(nullif(full_name, ''), email) as n from profiles)
  select jsonb_build_object(
    'target', coalesce((select value::numeric from settings where key = 'tat_target_hours'), 24),
    'bounce_target', coalesce((select value::numeric from settings where key = 'tat_bounce_hours'), 4),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'no', o.order_no, 'wh', o.warehouse_id, 'dist_id', o.distributor_id, 'dist', d.name,
        'placed', o.placed_at, 'expected', o.expected_at, 'arrived', o.arrived_at, 'received', o.received_at,
        'rsource', o.received_source, 'asource', o.arrival_source, 'lines', o.lines,
        'bounced', (select count(*) from order_lines ol where ol.order_id = o.id and ol.bounced),
        'by', (select n from pn where pn.user_id = o.placed_by)) order by o.placed_at)
      from o left join distributors d on d.id = o.distributor_id), '[]'::jsonb),
    'bounces', coalesce((select jsonb_agg(jsonb_build_object(
        'item', i.name, 'pack', i.pack_size, 'wh', o.warehouse_id, 'no', o.order_no, 'dist', d.name,
        'short', ol.qty - coalesce(ol.supplied_qty, 0),
        'at', coalesce(o.arrived_at, o.received_at),
        're_at', r.placed_at, 're_no', r.order_no, 're_dist', r.dist, 're_by', r.by) order by coalesce(o.arrived_at, o.received_at))
      from o join order_lines ol on ol.order_id = o.id and ol.bounced
      join items i on i.id = ol.item_id left join distributors d on d.id = o.distributor_id
      left join lateral (
        select o2.placed_at, o2.order_no, d2.name as dist, (select n from pn where pn.user_id = o2.placed_by) as by
        from order_lines l2 join orders o2 on o2.id = l2.order_id left join distributors d2 on d2.id = o2.distributor_id
        where l2.item_id = ol.item_id and o2.warehouse_id = o.warehouse_id and o2.id <> o.id
          and o2.cancelled_at is null and o2.placed_at > o.placed_at
        order by o2.placed_at limit 1) r on true), '[]'::jsonb))
  into v;
  return v;
end $$;

create or replace function public.save_tat_settings(p_target numeric, p_bounce numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only Admin can change the targets'; end if;
  if p_target <= 0 or p_bounce <= 0 then raise exception 'Targets must be more than 0 hours'; end if;
  update settings set value = p_target::text where key = 'tat_target_hours';
  update settings set value = p_bounce::text where key = 'tat_bounce_hours';
end $$;

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;

select 'Update 13 installed' as result;
