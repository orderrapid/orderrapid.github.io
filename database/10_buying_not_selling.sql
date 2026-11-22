-- =====================================================================
-- Update 12 (23 Nov 2026): "Buying, not selling"
--  * Purchases report: medicines bought again and again (from different
--    distributors) while hardly selling, with the likely cause
--  * Order Sheet warning; Admin can block a medicine from being ordered
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- =====================================================================
set client_min_messages = warning;

insert into public.settings (key, value, description) values
  ('bns_days',       '30',   'Buying, not selling: period in days'),
  ('bns_min_buys',   '3',    'Buying, not selling: bought on at least this many bills ...'),
  ('bns_min_dists',  '2',    '... or from at least this many distributors'),
  ('bns_sell_pct',   '25',   '... while sales are below this % of what was bought'),
  ('bns_order_mode', 'warn', 'Order Sheet: warn = label only, untick = label and untick')
on conflict (key) do nothing;

-- medicines the Admin has blocked from ordering, per warehouse
create table if not exists public.item_blocks (
  item_id      integer not null references public.items (id) on delete cascade,
  warehouse_id integer not null references public.warehouses (id) on delete cascade,
  reason       text,
  blocked_by   uuid default auth.uid(),
  by_name      text,
  created_at   timestamptz not null default now(),
  primary key (item_id, warehouse_id)
);
alter table public.item_blocks enable row level security;
drop policy if exists item_blocks_read on public.item_blocks;
create policy item_blocks_read on public.item_blocks for select to authenticated using (public.is_staff());

create or replace function public.block_item(p_item_id integer, p_warehouse_id integer, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only Admin can block a medicine'; end if;
  insert into item_blocks (item_id, warehouse_id, reason, by_name)
  values (p_item_id, p_warehouse_id, nullif(trim(p_reason), ''),
          (select coalesce(nullif(full_name, ''), email) from profiles where user_id = auth.uid()))
  on conflict (item_id, warehouse_id) do update set reason = excluded.reason, by_name = excluded.by_name, created_at = now();
end $$;

create or replace function public.unblock_item(p_item_id integer, p_warehouse_id integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only Admin can unblock a medicine'; end if;
  delete from item_blocks where item_id = p_item_id and warehouse_id = p_warehouse_id;
end $$;

-- "Telma 40 Tablet" and "TELMA 40MG TAB" -> "telma|40": the words of the name
-- (without tab/tablet, cap/capsule, mg, ml … ) plus its numbers.
-- Two codes with the same key are probably the same medicine.
create or replace function public.name_base(t text)
returns text language sql immutable parallel safe as $$
  select coalesce((select string_agg(distinct w[1], ' ' order by w[1]) from regexp_matches(lower(coalesce(t, '')), '[a-z]+', 'g') w
                   where w[1] not in ('tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules', 'syp', 'syr', 'syrup',
                                      'inj', 'injection', 'susp', 'suspension', 'oint', 'ointment', 'sol', 'soln', 'solution',
                                      'mg', 'ml', 'mcg', 'gm', 'g', 'kg', 'l', 'ltr', 'iu', 'w', 'v', 'x', 'pcs', 'pc', 'piece', 'n', 'no')), '')
      || '|' ||
      coalesce((select string_agg(distinct m[1], ',' order by m[1]) from regexp_matches(coalesce(t, ''), '([0-9]+(?:\.[0-9]+)?)', 'g') m), '')
$$;

-- The report. One row per medicine bought often while not selling.
create or replace function public.buying_not_selling(p_warehouse_id integer, p_from date, p_to date,
                                                     p_min_buys integer, p_min_dists integer, p_sell_pct numeric)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_last date;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  -- if sales are uploaded only up to an earlier day, end the period there (same length),
  -- otherwise recent purchases would look unsold
  select max(sale_date) into v_last from sales_lines where warehouse_id = p_warehouse_id;
  if v_last is not null and v_last < p_to then
    p_from := p_from - (p_to - v_last);
    p_to := v_last;
  end if;
  with pl as (
    select pl.*,
           -- was this medicine ordered in the app (any distributor) in the 7 days before the bill?
           exists (select 1 from order_lines ol join orders o on o.id = ol.order_id
                   where o.warehouse_id = pl.warehouse_id and ol.item_id = pl.item_id and o.cancelled_at is null
                     and o.placed_at::date between pl.purchase_date - 7 and pl.purchase_date) as in_app
    from purchase_lines pl
    where pl.warehouse_id = p_warehouse_id and pl.purchase_date between p_from and p_to
  ), pur as (
    select item_id, count(distinct (distributor_id, bill_no)) as buys, count(distinct distributor_id) as dists,
           sum(qty) as qty, sum(amount) as amount, max(purchase_date) as last_buy,
           count(*) filter (where not in_app) as not_app, count(*) as lines
    from pl group by item_id
  ), sold_all as (
    select item_id, sum(qty) as q from sales_lines
    where warehouse_id = p_warehouse_id and sale_date between p_from and p_to group by item_id
  ), flag as (
    select p.*, coalesce(s.q, 0) as sold
    from pur p left join sold_all s on s.item_id = p.item_id
    where (p.buys >= p_min_buys or p.dists >= p_min_dists)
      and coalesce(s.q, 0) < p.qty * p_sell_pct / 100
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'item_id', f.item_id, 'name', i.name, 'pack', i.pack_size,
      'buys', f.buys, 'dists', f.dists, 'qty', f.qty, 'amount', f.amount, 'sold', f.sold,
      'last_buy', f.last_buy, 'not_app', f.not_app, 'lines', f.lines,
      'stock', (select ls.strips from latest_stock ls where ls.warehouse_id = p_warehouse_id and ls.item_id = f.item_id),
      'max', lv.max_stock, 'grp', lv.grp,
      'disc', public.is_disc(i.id, i.status, p_warehouse_id),
      'blocked', (select jsonb_build_object('reason', b.reason, 'by', b.by_name, 'at', b.created_at)
                  from item_blocks b where b.item_id = f.item_id and b.warehouse_id = p_warehouse_id),
      'distributors', (select jsonb_agg(distinct d.name) from pl join distributors d on d.id = pl.distributor_id where pl.item_id = f.item_id),
      'bills', (select jsonb_agg(jsonb_build_object('date', pl.purchase_date, 'bill', pl.bill_no, 'dist', d.name,
                                 'qty', pl.qty, 'amount', pl.amount, 'app', pl.in_app) order by pl.purchase_date, d.name)
                from pl join distributors d on d.id = pl.distributor_id where pl.item_id = f.item_id),
      -- other codes that look like the same medicine and DO sell here
      'similar', (select jsonb_agg(jsonb_build_object('name', x.name, 'pack', x.pack_size, 'sold', x.q) order by x.q desc)
                  from (select i2.name, i2.pack_size, s2.q from sold_all s2 join items i2 on i2.id = s2.item_id
                        where i2.id <> f.item_id and s2.q > 0 and public.name_base(i2.name) = public.name_base(i.name)
                        order by s2.q desc limit 3) x)
    ) order by f.qty - f.sold desc), '[]'::jsonb)
  into v
  from flag f join items i on i.id = f.item_id
  left join item_levels lv on lv.item_id = f.item_id and lv.warehouse_id = p_warehouse_id;
  return v;
end $$;

-- blocked medicines can't be ordered, whoever tries
create or replace function public.place_orders(p_warehouse_id integer, p_note text, p_lines jsonb)
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

-- Admin saves the report's limits and the Order Sheet mode
create or replace function public.save_bns_settings(p_days integer, p_min_buys integer, p_min_dists integer, p_sell_pct numeric, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only Admin can change these settings'; end if;
  if p_days < 1 or p_min_buys < 1 or p_min_dists < 1 or p_sell_pct < 0 or p_mode not in ('warn', 'untick') then
    raise exception 'Check the numbers';
  end if;
  update settings set value = p_days::text      where key = 'bns_days';
  update settings set value = p_min_buys::text  where key = 'bns_min_buys';
  update settings set value = p_min_dists::text where key = 'bns_min_dists';
  update settings set value = p_sell_pct::text  where key = 'bns_sell_pct';
  update settings set value = p_mode           where key = 'bns_order_mode';
end $$;

revoke all on public.item_blocks from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;

select 'Update 12 installed' as result;
