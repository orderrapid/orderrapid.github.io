-- =====================================================================
-- Update 2 (19 Nov 2026): keep the time of each sale, for hourly analysis.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once. Not needed if you set up from a 01_schema.sql
-- dated after 19 Nov 2026 (it already includes this).
-- =====================================================================
set client_min_messages = warning;

alter table public.sales_lines add column if not exists sale_time time;

-- p_rows: [{"d":"2026-11-08","t":"14:35:22","b":"2143","m":"9876543210","n":"Dolo 650 Tablet",
--           "p":"15 Tablet","q":2,"a":64.5}, ...]   (send ~2,000 rows per call)
create or replace function public.import_sales_batch(p_upload_id bigint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_wh integer; v_cut date;
  v_total integer; v_old integer; v_bad integer; v_lines integer; v_saved integer;
begin
  if not public.has_role('admin', 'manager') then
    raise exception 'Only Admin or Manager can upload sales';
  end if;
  select warehouse_id into v_wh from sales_uploads where id = p_upload_id and status = 'running';
  if v_wh is null then raise exception 'Upload % is not open', p_upload_id; end if;

  v_cut := current_date - coalesce((select value::int from settings where key = 'sales_keep_days'), 400);

  create temp table _rows on commit drop as
  select nullif(r ->> 'd', '')::date                                     as d,
         nullif(r ->> 't', '')::time                                     as t,
         nullif(trim(r ->> 'b'), '')                                     as b,
         nullif(regexp_replace(coalesce(r ->> 'm', ''), '\D', '', 'g'), '') as m,
         nullif(trim(r ->> 'n'), '')                                     as n,
         coalesce(trim(r ->> 'p'), '')                                   as p,
         nullif(r ->> 'q', '')::numeric                                  as q,
         nullif(r ->> 'a', '')::numeric                                  as a
  from jsonb_array_elements(p_rows) r;

  select count(*) into v_total from _rows;
  select count(*) into v_old from _rows where d is not null and d < v_cut;
  delete from _rows where d is not null and d < v_cut;
  select count(*) into v_bad from _rows where d is null or b is null or n is null or q is null or q <= 0;
  delete from _rows where d is null or b is null or n is null or q is null or q <= 0;

  -- new medicines go into the item master (without a conversion yet)
  insert into items (name, pack_size)
  select distinct on (public.norm_text(n) || '|' || public.norm_text(p)) n, p
  from _rows
  on conflict (norm_key) do nothing;

  insert into customers (mobile)
  select distinct m from _rows where m is not null
  on conflict (mobile) do nothing;

  -- the same medicine twice on one bill (e.g. two spellings) is added up
  with grouped as (
    select r.d, r.b, i.id as item_id, min(r.t) as t, max(c.id) as customer_id, sum(r.q) as q, sum(r.a) as a
    from _rows r
    join items i on i.norm_key = public.norm_text(r.n) || '|' || public.norm_text(r.p)
    left join customers c on c.mobile = r.m
    group by r.d, r.b, i.id
  ), ins as (
    insert into sales_lines (warehouse_id, sale_date, bill_no, item_id, sale_time, customer_id, qty, amount)
    select v_wh, d, b, item_id, t, customer_id, q, a from grouped
    on conflict do nothing
    returning 1
  )
  select (select count(*) from grouped), (select count(*) from ins) into v_lines, v_saved;

  update sales_uploads set
    rows_in_file = rows_in_file + v_total,
    rows_saved   = rows_saved + v_saved,
    rows_already = rows_already + (v_lines - v_saved),
    rows_too_old = rows_too_old + v_old,
    rows_skipped = rows_skipped + v_bad,
    first_date   = least(first_date, (select min(d) from _rows)),
    last_date    = greatest(last_date, (select max(d) from _rows))
  where id = p_upload_id;

  return jsonb_build_object('rows', v_total, 'saved', v_saved, 'already', v_lines - v_saved,
                            'too_old', v_old, 'skipped', v_bad);
end $$;

grant execute on function public.import_sales_batch(bigint, jsonb) to authenticated;
revoke execute on function public.import_sales_batch(bigint, jsonb) from anon, public;
