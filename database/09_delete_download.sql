-- =====================================================================
-- Update 11 (23 Nov 2026): download and delete sales / purchases
--  * Download (Admin, Manager): sales with mobile numbers, purchases
--  * Delete (Admin only): by warehouse and dates, with a preview first
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- =====================================================================
set client_min_messages = warning;

-- every delete is written down
create table if not exists public.data_deletions (
  id           integer generated always as identity primary key,
  kind         text not null,              -- sales | purchases
  warehouse_id integer references public.warehouses (id),
  from_date    date,
  to_date      date,
  lines        integer,
  amount       numeric(14,2),
  deleted_by   uuid default auth.uid(),
  by_name      text,
  created_at   timestamptz not null default now()
);
alter table public.data_deletions enable row level security;
drop policy if exists data_deletions_read on public.data_deletions;
create policy data_deletions_read on public.data_deletions for select to authenticated using (public.is_staff());

-- what a delete would remove
create or replace function public.data_preview(p_kind text, p_warehouse_id integer, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.has_role('admin', 'manager') then raise exception 'Not allowed'; end if;
  if p_kind = 'sales' then
    select jsonb_build_object('lines', count(*), 'bills', count(distinct (sale_date, bill_no)),
             'qty', coalesce(sum(qty), 0), 'amount', coalesce(sum(amount), 0),
             'first', min(sale_date), 'last', max(sale_date))
    into v from sales_lines where warehouse_id = p_warehouse_id and sale_date between p_from and p_to;
  elsif p_kind = 'purchases' then
    select jsonb_build_object('lines', count(*), 'bills', count(distinct (distributor_id, bill_no)),
             'qty', coalesce(sum(qty), 0), 'amount', coalesce(sum(amount), 0),
             'first', min(purchase_date), 'last', max(purchase_date))
    into v from purchase_lines where warehouse_id = p_warehouse_id and purchase_date between p_from and p_to;
  else raise exception 'Unknown kind %', p_kind;
  end if;
  return v;
end $$;

-- delete one chunk of dates (the app sends a month at a time).
-- p_confirm must be the warehouse name, as typed by the Admin.
create or replace function public.delete_data(p_kind text, p_warehouse_id integer, p_from date, p_to date, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_name text; v_lines integer; v_amount numeric;
begin
  if not public.has_role('admin') then raise exception 'Only Admin can delete data'; end if;
  select name into v_name from warehouses where id = p_warehouse_id;
  if v_name is null then raise exception 'Warehouse not found'; end if;
  if lower(trim(coalesce(p_confirm, ''))) <> lower(trim(v_name)) then
    raise exception 'Type the warehouse name exactly to confirm';
  end if;
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Check the dates'; end if;

  if p_kind = 'sales' then
    with d as (delete from sales_lines where warehouse_id = p_warehouse_id and sale_date between p_from and p_to
               returning amount)
    select count(*), coalesce(sum(amount), 0) into v_lines, v_amount from d;
    -- Min / Max must be worked out again from what is left
    delete from level_runs where warehouse_id = p_warehouse_id;
    if not exists (select 1 from sales_lines where warehouse_id = p_warehouse_id) then
      delete from item_levels where warehouse_id = p_warehouse_id;
    end if;
  elsif p_kind = 'purchases' then
    with d as (delete from purchase_lines where warehouse_id = p_warehouse_id and purchase_date between p_from and p_to
               returning amount)
    select count(*), coalesce(sum(amount), 0) into v_lines, v_amount from d;
  else raise exception 'Unknown kind %', p_kind;
  end if;

  if v_lines > 0 then
    insert into data_deletions (kind, warehouse_id, from_date, to_date, lines, amount, by_name)
    values (p_kind, p_warehouse_id, p_from, p_to, v_lines, v_amount,
            (select coalesce(nullif(full_name, ''), email) from profiles where user_id = auth.uid()));
  end if;
  return jsonb_build_object('lines', v_lines, 'amount', v_amount);
end $$;

-- download one chunk of dates, in the same columns as the upload files
create or replace function public.export_data(p_kind text, p_warehouse_id integer, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('admin', 'manager') then raise exception 'Only Admin or Manager can download data'; end if;
  if p_kind = 'sales' then
    return coalesce((
      select jsonb_agg(jsonb_build_array(s.sale_date, to_char(s.sale_time, 'HH24:MI:SS'), s.bill_no, c.mobile,
                         i.name, i.pack_size, s.qty, s.amount)
                       order by s.sale_date, s.sale_time nulls last, s.bill_no, i.name)
      from sales_lines s join items i on i.id = s.item_id left join customers c on c.id = s.customer_id
      where s.warehouse_id = p_warehouse_id and s.sale_date between p_from and p_to), '[]'::jsonb);
  elsif p_kind = 'purchases' then
    return coalesce((
      select jsonb_agg(jsonb_build_array(pl.purchase_date, pl.bill_no, d.name, i.name, i.pack_size, pl.amount, pl.qty)
                       order by pl.purchase_date, d.name, pl.bill_no, i.name)
      from purchase_lines pl join items i on i.id = pl.item_id join distributors d on d.id = pl.distributor_id
      where pl.warehouse_id = p_warehouse_id and pl.purchase_date between p_from and p_to), '[]'::jsonb);
  end if;
  raise exception 'Unknown kind %', p_kind;
end $$;

revoke all on public.data_deletions from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated;

select 'Update 11 installed' as result;
