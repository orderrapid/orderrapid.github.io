-- =====================================================================
-- Update 14 (23 Nov 2026): Short in market
--  * The team marks a medicine "short in market" only after checking BOTH
--    Pharmarack and Retailer Shakti
--  * Admin / Manager can mark it "Found – order it"
--  * Closed automatically when the medicine is ordered again
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- =====================================================================
set client_min_messages = warning;

create table if not exists public.short_marks (
  id                 bigint generated always as identity primary key,
  warehouse_id       integer not null references public.warehouses (id) on delete cascade,
  item_id            integer not null references public.items (id) on delete cascade,
  kind               text not null default 'short',   -- short | found
  checked_pharmarack boolean not null default false,
  checked_rs         boolean not null default false,  -- Retailer Shakti
  note               text,
  by_user            uuid default auth.uid(),
  by_name            text,
  created_at         timestamptz not null default now()
);
create index if not exists short_marks_wh_item on public.short_marks (warehouse_id, item_id, created_at desc);
alter table public.short_marks enable row level security;
drop policy if exists short_marks_read on public.short_marks;
create policy short_marks_read on public.short_marks for select to authenticated using (public.is_staff());

create or replace function public.mark_short(p_warehouse_id integer, p_item_id integer,
                                             p_pharmarack boolean, p_rs boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin', 'purchase', 'manager') then raise exception 'Not allowed'; end if;
  if not coalesce(p_pharmarack, false) or not coalesce(p_rs, false) then
    raise exception 'Check both Pharmarack and Retailer Shakti before marking short in market';
  end if;
  insert into short_marks (warehouse_id, item_id, kind, checked_pharmarack, checked_rs, note, by_name)
  values (p_warehouse_id, p_item_id, 'short', true, true, nullif(trim(p_note), ''),
          (select coalesce(nullif(full_name, ''), email) from profiles where user_id = auth.uid()));
end $$;

create or replace function public.mark_found(p_warehouse_id integer, p_item_id integer, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin', 'manager') then raise exception 'Only Admin or Manager can mark it found'; end if;
  insert into short_marks (warehouse_id, item_id, kind, note, by_name)
  values (p_warehouse_id, p_item_id, 'found', nullif(trim(p_note), ''),
          (select coalesce(nullif(full_name, ''), email) from profiles where user_id = auth.uid()));
end $$;

-- One row per medicine marked short in the last p_days days, with where it stands now:
--   short   = still marked short (not found, not ordered since)
--   found   = Admin / Manager found it, not ordered yet
--   ordered = ordered after it was marked short / found
create or replace function public.short_list(p_warehouse_id integer, p_days integer default 14)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  with last_short as (
    select distinct on (item_id) * from short_marks
    where warehouse_id = p_warehouse_id and kind = 'short' and created_at >= now() - make_interval(days => p_days)
    order by item_id, created_at desc
  ), c as (
    select s.item_id, s.created_at as last_mark, s.by_name, s.note,
      (select f.created_at from short_marks f where f.warehouse_id = p_warehouse_id and f.item_id = s.item_id
         and f.kind = 'found' and f.created_at > s.created_at order by f.created_at desc limit 1) as found_at,
      (select f.by_name || coalesce(': ' || f.note, '') from short_marks f where f.warehouse_id = p_warehouse_id and f.item_id = s.item_id
         and f.kind = 'found' and f.created_at > s.created_at order by f.created_at desc limit 1) as found_by,
      (select min(o.placed_at) from orders o join order_lines ol on ol.order_id = o.id
        where o.warehouse_id = p_warehouse_id and ol.item_id = s.item_id and o.cancelled_at is null and o.placed_at > s.created_at) as ordered_at,
      -- days marked short in a row (IST), counting back from the last mark
      (select count(distinct (m.created_at at time zone 'Asia/Kolkata')::date) from short_marks m
        where m.warehouse_id = p_warehouse_id and m.item_id = s.item_id and m.kind = 'short'
          and m.created_at > coalesce((select max(x.created_at) from short_marks x where x.warehouse_id = p_warehouse_id
                                         and x.item_id = s.item_id and x.kind = 'found' and x.created_at < s.created_at), '-infinity')
          and m.created_at > coalesce((select max(o.placed_at) from orders o join order_lines ol on ol.order_id = o.id
                                         where o.warehouse_id = p_warehouse_id and ol.item_id = s.item_id and o.cancelled_at is null
                                           and o.placed_at < s.created_at), '-infinity')) as days,
      (select string_agg(distinct m.by_name, ', ') from short_marks m where m.warehouse_id = p_warehouse_id and m.item_id = s.item_id
         and m.kind = 'short' and m.created_at >= now() - make_interval(days => p_days)) as marked_by
    from last_short s
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'item_id', c.item_id, 'name', i.name, 'pack', i.pack_size, 'last_mark', c.last_mark, 'by', c.by_name, 'marked_by', c.marked_by,
      'note', c.note, 'days', c.days, 'found_at', c.found_at, 'found_by', c.found_by, 'ordered_at', c.ordered_at,
      'status', case when c.ordered_at is not null then 'ordered' when c.found_at is not null then 'found' else 'short' end,
      'grp', lv.grp, 'qty_30', lv.qty_30)
      order by case when c.ordered_at is not null then 2 when c.found_at is not null then 0 else 1 end, c.days desc, c.last_mark desc), '[]'::jsonb)
  into v
  from c join items i on i.id = c.item_id
  left join item_levels lv on lv.item_id = c.item_id and lv.warehouse_id = p_warehouse_id;
  return v;
end $$;

revoke all on public.short_marks from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;

select 'Update 14 installed' as result;
