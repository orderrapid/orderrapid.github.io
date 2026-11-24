-- =====================================================================
-- Update 17 (24 Nov 2026): show what is uploaded — first → last date,
-- number of lines, and days with nothing uploaded in between.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- =====================================================================
set client_min_messages = warning;

-- p_kind: sales | purchases | returns
create or replace function public.upload_range(p_kind text, p_warehouse_id integer)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_first date; v_last date; v_lines bigint; v_missing date[];
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  create temp table if not exists _days (d date) on commit drop;
  truncate _days;
  if p_kind = 'sales' then
    insert into _days select distinct sale_date from sales_lines where warehouse_id = p_warehouse_id;
    select count(*) into v_lines from sales_lines where warehouse_id = p_warehouse_id;
  elsif p_kind = 'purchases' then
    insert into _days select distinct purchase_date from purchase_lines where warehouse_id = p_warehouse_id;
    select count(*) into v_lines from purchase_lines where warehouse_id = p_warehouse_id;
  elsif p_kind = 'returns' then
    insert into _days select distinct return_date from purchase_returns where warehouse_id = p_warehouse_id;
    select count(*) into v_lines from purchase_returns where warehouse_id = p_warehouse_id;
  else raise exception 'Unknown kind %', p_kind;
  end if;
  select min(d), max(d) into v_first, v_last from _days;
  if v_first is null then return jsonb_build_object('lines', 0); end if;
  -- days between first and last with nothing uploaded (newest first)
  select array_agg(g::date order by g desc) into v_missing
  from generate_series(v_first, v_last, interval '1 day') g
  where not exists (select 1 from _days where d = g::date);
  return jsonb_build_object('first', v_first, 'last', v_last, 'lines', v_lines,
                            'days', (select count(*) from _days), 'missing', coalesce(to_jsonb(v_missing), '[]'::jsonb));
end $$;
alter function public.upload_range(text, integer) volatile;

revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;

select 'Update 17 installed' as result;
