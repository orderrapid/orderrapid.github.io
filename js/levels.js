// Recalculates Min / Max for one warehouse and saves it.
// Runs after every sales upload, and when the order screen sees that
// sales have moved on since the last calculation.
import { sb, check } from './db.js';
import { calculateLevels, DEFAULTS } from './analysis.js';
import { addDays } from './ui.js';

export async function loadSettings() {
  const rows = await sb.from('settings').select('key, value').then(check);
  const cfg = { ...DEFAULTS };
  for (const { key, value } of rows) {
    const n = Number(value);
    if (key in DEFAULTS && isFinite(n)) cfg[key] = n;
    else if (!(key in cfg)) cfg[key] = isFinite(n) ? n : value;
  }
  return cfg;
}

// Is the saved calculation older than the uploaded sales?
export async function levelsStatus(warehouseId) {
  const [status, run] = await Promise.all([
    sb.rpc('sales_status').then(check),
    sb.from('level_runs').select('*').eq('warehouse_id', Number(warehouseId)).maybeSingle().then(check),
  ]);
  const salesUpTo = status.find((s) => String(s.warehouse_id) === String(warehouseId))?.last_date || null;
  return { salesUpTo, run, stale: !!salesUpTo && (!run || run.sales_up_to !== salesUpTo) };
}

export async function recalculate(warehouseId, onStatus) {
  const { salesUpTo } = await levelsStatus(warehouseId);
  if (!salesUpTo) return { count: 0, salesUpTo: null };
  // as of the morning after the last sales day — how the Python script sees it
  const asOf = addDays(salesUpTo, 1);
  onStatus?.('Reading sales…');
  const [data, cfg] = await Promise.all([
    sb.rpc('analysis_data', { p_warehouse_id: Number(warehouseId), p_as_of: asOf }).then(check),
    loadSettings(),
  ]);
  onStatus?.('Calculating Min / Max…');
  const { rows } = calculateLevels(data, cfg);
  onStatus?.('Saving…');
  const slim = rows.map((r) => ({
    item_id: r.item_id, grp: r.grp, growing: r.growing, speed: r.speed, pattern: r.pattern, why: r.why,
    per_day: r.per_day, normal_sale: r.normal_sale, big_sale: r.big_sale, weeks_sold: r.weeks_sold,
    min_stock: r.min_stock, max_stock: r.max_stock, can_order: r.can_order, lasts_days: r.lasts_days,
    warning: r.warning, qty_7: r.qty_7, qty_30: r.qty_30, qty_60: r.qty_60, qty_90: r.qty_90, bills_30: r.bills_30, cust_30: r.cust_30,
    cust_90: r.cust_90, total_bills: r.total_bills, days_selling: r.days_selling, last_sold: r.last_sold,
    days_since: r.days_since, odd_note: r.odd_note,
  }));
  const count = await sb.rpc('save_levels', {
    p_warehouse_id: Number(warehouseId), p_as_of: asOf, p_sales_up_to: salesUpTo, p_rows: slim,
  }).then(check);
  return { count, salesUpTo, asOf };
}
