// Min / Max calculation — a line-by-line port of MEDICINE ORDERING SHEET v4.
// The database hands over the sales figures (analysis_data); this file
// applies the same rules as the Python script. Comments say which step.
// Pure functions: no database calls, so it can be tested on its own.

export const DEFAULTS = {
  delivery_days: 2,
  min_days_fast: 7, max_days_fast: 11,
  min_days_average: 8, max_days_average: 12,
  busy_day_buffer_fast: 2.05, busy_day_buffer_average: 1.65,
  sales_per_week_fast: 5.0, sales_per_week_average: 1.5, sales_per_week_slow: 0.5,
  big_seller_per_day: 1.0,
  weeks_checked: 13, regular_weeks_needed: 8,
  new_medicine_days: 21, growing_factor: 1.5, growing_min_sales: 2,
  bills_before_stocking_new: 2, bunched_bill_days: 5,
  stopped_days: 21, dead_days: 90, expiry_warning_days: 60,
  min_order_qty: 2, enough_sales_for_outlier_check: 8,
  min_sales_to_judge_speed: 3, few_customers: 2,
};

export const PERIODS = [7, 15, 30, 45, 60, 90, 120, 180, 270, 360];
const P = Object.fromEntries(PERIODS.map((d, i) => [d, i]));
export const GROUP_ORDER = { Fast: 0, Average: 1, New: 2, 'Slow (Regular)': 3, 'Slow (Irregular)': 4, Rare: 5 };
const GROUPS = ['Rare', 'Slow (Irregular)', 'Slow (Regular)', 'Average', 'Fast'];

const dayNum = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);

// pandas Series.quantile (linear) — same as Postgres percentile_cont
export function quantile(values, q) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const median = (v) => quantile(v, 0.5);
const sum = (v) => v.reduce((a, b) => a + b, 0);
function stdSample(v) {            // pandas .std() (ddof = 1)
  const n = v.length;
  if (n < 2) return 0;
  const m = sum(v) / n;
  return Math.sqrt(sum(v.map((x) => (x - m) ** 2)) / (n - 1));
}
// Python's round() rounds halves to even; this matches it for the
// values the sheet shows.
function pyRound(x, dp = 0) {
  if (!isFinite(x)) return x;
  const f = 10 ** dp, y = x * f, r = Math.round(y);
  const isHalf = Math.abs(y % 1) === 0.5;
  return (isHalf && r % 2 !== 0 ? r - 1 : r) / f;
}

/**
 * data: result of analysis_data()  { as_of, store_first, items: [...], recent: [...] }
 * cfg : settings (DEFAULTS overridden by the settings table)
 * chronic: Set of item ids marked chronic (optional)
 * Returns one result object per medicine.
 */
export function calculateLevels(data, cfg = DEFAULTS, chronic = new Set()) {
  const C = { ...DEFAULTS, ...cfg };
  const T = dayNum(data.as_of);
  const storeAge = data.store_first ? T - dayNum(data.store_first) + 1 : 0;
  // young stores must not block their own medicines
  const STOP_AFTER = storeAge >= 90 ? C.stopped_days : Math.max(14, Math.trunc(storeAge * 0.40));
  const DEAD_AFTER = storeAge >= 90 ? C.dead_days : Math.max(30, Math.trunc(storeAge * 0.75));

  // last 30 days, grouped by medicine: [dayOffset (-30..-1), bill, qty, customer]
  const recent = new Map();
  for (const [itemId, off, bill, q, c] of data.recent) {
    if (!recent.has(itemId)) recent.set(itemId, []);
    recent.get(itemId).push({ off, bill, q: Number(q), c });
  }

  const salesPerWeek = (sales, windowDays, daysSelling) => {
    const realDays = Math.max(Math.min(windowDays, daysSelling), 7);
    return sales / (realDays / 7.0);
  };

  const out = [];
  for (const it of data.items) {
    const [itemId, name, pack, qtyA, billsA, custA, firstD, lastD, weeksSold, n90, b90, x90, n120, b120, x120] = it;
    const Qty = (d) => Number(qtyA[P[d]]), Sales = (d) => Number(billsA[P[d]]), Cust = (d) => Number(custA[P[d]]);
    const daysSelling = T - dayNum(firstD) + 1;
    const daysSince = T - dayNum(lastD);
    const qty30 = Qty(30), qty15 = Qty(15);
    const rows = recent.get(itemId) || [];
    const soldRecently = rows.length > 0;

    // ── STEP 6: speeding up or slowing down?
    const sales30row = Sales(30);
    let speed;
    if (qty30 === 0) speed = 'No Sale';
    else if (qty15 === 0) speed = 'Stopped';
    else if (sales30row < C.min_sales_to_judge_speed) speed = 'Too few sales to judge';
    else if (qty15 * 2 > qty30 * 1.2) speed = 'Speeding Up';
    else if (qty15 * 2 < qty30 * 0.8) speed = 'Slowing Down';
    else speed = 'Steady';

    // ── details from the last 30 days
    let perSale = [], oddBills = new Set(), normalQty = 0, daysSold = 0, sales30 = 0;
    let swing = 0, biggestDay = 0, avgVisits = null, busyDays = 0, avgGap = 0, visits = new Map();
    if (soldRecently) {
      perSale = rows.map((r) => r.q);
      const lowQ = quantile(perSale, 0.25), highQ = quantile(perSale, 0.75);
      const spread = highQ - lowQ;
      const tooHigh = highQ + 1.5 * spread, tooLow = Math.max(0, lowQ - 1.5 * spread);
      if (perSale.length >= C.enough_sales_for_outlier_check && spread > 0)
        rows.forEach((r) => { if (r.q < tooLow || r.q > tooHigh) oddBills.add(r.off + '|' + r.bill); });
      const normal = rows.filter((r) => !oddBills.has(r.off + '|' + r.bill));
      normalQty = Math.trunc(sum(normal.map((r) => r.q)));
      daysSold = new Set(rows.map((r) => r.off)).size;
      sales30 = rows.length;
      const byDay = new Map();
      normal.forEach((r) => byDay.set(r.off, (byDay.get(r.off) || 0) + r.q));
      const span = Math.min(30, daysSelling);
      const full = [];
      for (let o = -(span - 1); o <= 0; o++) full.push(byDay.get(o) || 0);
      swing = full.length > 1 ? stdSample(full) : 0;
      biggestDay = byDay.size ? Math.max(...byDay.values()) : 0;
      rows.forEach((r) => { if (r.c != null) { if (!visits.has(r.c)) visits.set(r.c, new Set()); visits.get(r.c).add(r.off + '|' + r.bill); } });
      avgVisits = visits.size ? pyRound(sum([...visits.values()].map((s) => s.size)) / visits.size, 2) : null;
      const custPerDay = new Map();
      rows.forEach((r) => { if (r.c != null) { if (!custPerDay.has(r.off)) custPerDay.set(r.off, new Set()); custPerDay.get(r.off).add(r.c); } });
      busyDays = [...custPerDay.values()].filter((s) => s.size > 1).length;
      const days = [...new Set(rows.map((r) => r.off))].sort((a, b) => a - b);
      const gaps = days.slice(1).map((d, i) => d - days[i]);
      avgGap = gaps.length ? pyRound(sum(gaps) / gaps.length, 1) : 0;
    }

    // ── STEP 3: group
    const roughRate = normalQty / Math.max(Math.min(30, daysSelling), 1);
    let group, growing = false;
    if (daysSelling < C.new_medicine_days) {
      group = 'New';
    } else {
      const spw30 = salesPerWeek(Sales(30), 30, daysSelling);
      const spw90 = salesPerWeek(Sales(90), 90, daysSelling);
      const spw15 = salesPerWeek(Sales(15), 15, daysSelling);
      // last 15 days against the 30 days BEFORE that
      const beforeSales = Math.max(Sales(45) - Sales(15), 0);
      const beforeDays = Math.max(Math.min(45, daysSelling) - Math.min(15, daysSelling), 0);
      const spwBefore = beforeDays >= 7 ? beforeSales / (beforeDays / 7.0) : 0.0;
      if (spw30 >= C.sales_per_week_fast) group = 'Fast';
      else if (spw30 >= C.sales_per_week_average) group = 'Average';
      else if (spw90 >= C.sales_per_week_slow) {
        const weeksAvailable = Math.min(C.weeks_checked, Math.max(Math.floor(daysSelling / 7), 1));
        const needed = Math.min(C.regular_weeks_needed, Math.max(Math.trunc(weeksAvailable * 0.6), 2));
        group = weeksSold >= needed ? 'Slow (Regular)' : 'Slow (Irregular)';
      } else group = 'Rare';
      if (roughRate >= C.big_seller_per_day && (group.startsWith('Slow') || group.startsWith('Rare'))) group = 'Average';
      growing = spwBefore > 0 && spw15 >= C.growing_factor * spwBefore && Sales(15) >= C.growing_min_sales;
      if (growing) group = GROUPS[Math.min(GROUPS.indexOf(group) + 1, GROUPS.length - 1)];
    }

    // Average medicines look at 120 days for sale sizes
    const avgGroup = group === 'Average';
    const nS = Number(avgGroup ? n120 : n90), bS = Number(avgGroup ? b120 : b90), xS = Number(avgGroup ? x120 : x90);
    let normalSale = nS > 0 ? nS : (perSale.length ? median(perSale) : 0);
    let bigSale = bS > 0 ? bS : (perSale.length ? quantile(perSale, 0.9) : 0);
    const biggestSale = xS;

    // ── STEP 4: strips per day
    const rate = (d) => { const real = Math.min(d, daysSelling); return real > 0 ? Qty(d) / real : 0; };
    const r30 = daysSelling > 0 ? normalQty / Math.min(30, daysSelling) : 0;
    const r15 = rate(15), r90 = rate(90), r180 = rate(180);
    let perDay;
    if (group === 'New') perDay = Math.max(r15, r30);
    else if (group === 'Fast' || group === 'Average') perDay = r90 > 0 ? 0.70 * r30 + 0.30 * r90 : r30;
    else {
      const longRun = r180 <= 0 ? r90 : 0.6 * r90 + 0.4 * r180;
      perDay = longRun > 0 ? 0.40 * r30 + 0.60 * longRun : r30;
    }
    if (growing) perDay = Math.max(perDay, r15, r30);
    else if (speed === 'Speeding Up' && sales30 >= 3) perDay = Math.max(perDay, r30, Qty(7) / 7);
    else if (speed === 'Slowing Down') perDay = Math.min(perDay, Math.max(r15, r30 * 0.80));
    perDay = Math.max(perDay, 0);

    const isChronic = chronic.has(itemId);
    const totalBills = Sales(360);
    const billSpread = Math.max(Math.trunc(daysSelling - 1 - daysSince), 0);
    const cust90 = Cust(90);

    // ── STEP 5: stock to keep
    let minL = 0, maxL = 0, why, lasts = 0;
    if (daysSince >= DEAD_AFTER) why = 'Dead - do not order';
    else if (speed === 'Stopped' || daysSince >= STOP_AFTER) why = 'Stopped selling - order blocked';
    else {
      normalSale = Math.max(normalSale, 1.0);
      bigSale = Math.max(bigSale, normalSale);
      if (group === 'New') {
        if (totalBills < C.bills_before_stocking_new && !isChronic) {
          why = 'New - only 1 sale so far, decide by hand';
        } else {
          if (cust90 <= 1) {
            if (billSpread <= C.bunched_bill_days) {
              minL = bigSale; maxL = bigSale + 1;
              why = `New, 1 customer, ${totalBills} sales within ${billSpread}d: hold one sale, rebuy when sold`;
            } else {
              minL = bigSale; maxL = bigSale + normalSale;
              why = `New, 1 customer buying regularly (${billSpread}d apart): one sale + 1 spare`;
            }
          } else {
            minL = bigSale + normalSale; maxL = minL + normalSale;
            why = `New (${isChronic ? 'marked chronic' : `${cust90} customers`}): big sale + one more customer`;
          }
          minL = Math.max(Math.ceil(minL), 1);
          maxL = Math.max(Math.ceil(maxL), minL + 1);
          lasts = perDay > 0 ? pyRound(maxL / perDay, 1) : 999;
        }
      } else {
        if (group === 'Fast' || group === 'Average') {
          const buffer = group === 'Fast' ? C.busy_day_buffer_fast : C.busy_day_buffer_average;
          const minDays = group === 'Fast' ? C.min_days_fast : C.min_days_average;
          const maxDays = group === 'Fast' ? C.max_days_fast : C.max_days_average;
          const spare = swing > 0 ? buffer * swing * Math.sqrt(C.delivery_days + 1) : 0.0;
          const floor = bigSale + normalSale;   // big-buyer floor
          minL = Math.max(perDay * minDays, perDay * C.delivery_days + spare, floor);
          maxL = Math.max(perDay * maxDays, minL + normalSale);
          why = `${group}: ${minDays}-${maxDays} days, floor set by ${floor >= perDay * minDays ? 'big buyer' : 'days of stock'}`;
        } else if (group === 'Slow (Regular)') {
          if (cust90 <= C.few_customers) {
            minL = bigSale; maxL = bigSale + normalSale;
            why = `Only ${cust90} customer(s) - cover one big sale`;
          } else {
            minL = Math.max(bigSale + normalSale, normalSale + perDay * C.delivery_days + 1);
            maxL = minL + normalSale;
            why = 'Slow but steady: big sale + one more customer';
          }
        } else if (group === 'Slow (Irregular)') {
          minL = bigSale; maxL = bigSale + normalSale;
          why = 'Slow and uneven: cover one big sale only';
        } else {
          minL = normalSale; maxL = normalSale;
          why = 'Rare: one normal sale only';
        }
        minL = Math.max(Math.ceil(minL), 1);
        maxL = Math.max(Math.ceil(maxL), group === 'Rare' ? minL : minL + 1);
        lasts = perDay > 0 ? pyRound(maxL / perDay, 1) : 999;
      }
    }

    let pattern;
    if (avgGap === 0 && daysSold <= 1) pattern = daysSold ? 'Sold on one day only' : 'No recent sale';
    else if (avgGap <= 1) pattern = 'Sells every day';
    else if (avgGap <= 3) pattern = 'Sells every 2-3 days';
    else if (avgGap <= 7) pattern = 'Sells about weekly';
    else pattern = 'Sells now and then';

    let oddNote;
    if (!oddBills.size) oddNote = sales30 >= C.enough_sales_for_outlier_check ? 'Normal' : 'Too few sales to check';
    else {
      const regulars = new Set([...visits.entries()].filter(([, s]) => s.size > 1).map(([c]) => c));
      const who = [...new Set(rows.filter((r) => oddBills.has(r.off + '|' + r.bill)).map((r) => r.c))];
      if (who.every((c) => !regulars.has(c))) oddNote = 'New customer only - check if entry error';
      else if (who.every((c) => regulars.has(c))) oddNote = 'Regular customer - probably genuine';
      else oddNote = 'Mixed - worth checking';
    }

    out.push({
      item_id: itemId, name, pack,
      grp: group, growing, speed, pattern, why,
      per_day: pyRound(perDay, 3), normal_sale: pyRound(normalSale, 1), big_sale: pyRound(bigSale, 1),
      biggest_sale: pyRound(biggestSale, 1), swing: pyRound(swing, 2),
      weeks_sold: weeksSold, min_stock: minL, max_stock: maxL, can_order: maxL > 0,
      lasts_days: lasts,
      warning: maxL > 0 && lasts > C.expiry_warning_days ? 'TOO MUCH STOCK' : '',
      qty_30: qty30, qty_90: Qty(90), bills_30: Sales(30), cust_30: Cust(30), cust_90: cust90,
      total_bills: totalBills, days_selling: daysSelling, last_sold: lastD, days_since: daysSince,
      odd_note: oddNote, odd_sales: oddBills.size, avg_visits: avgVisits, busy_days: busyDays,
      days_sold_30: daysSold, normal_qty_30: normalQty, biggest_day: pyRound(biggestDay, 1), avg_gap: avgGap,
    });
  }
  out.sort((a, b) => (GROUP_ORDER[a.grp] ?? 9) - (GROUP_ORDER[b.grp] ?? 9) || b.qty_30 - a.qty_30);
  return { rows: out, storeAge, STOP_AFTER, DEAD_AFTER };
}

// STEP 7 — the order, from closing stock (strips) and what's already on order
export function orderQty(level, closing, onOrder = 0, cfg = DEFAULTS) {
  const C = { ...DEFAULTS, ...cfg };
  if (!level.can_order) return 0;
  const have = (closing || 0) + (onOrder || 0);
  if (!(have < level.min_stock)) return 0;   // only order once stock drops below the minimum
  let q = Math.ceil(Math.max(level.max_stock - have, 0));
  if ((level.grp === 'Fast' || level.grp === 'Average') && q > 0 && q < C.min_order_qty) q = C.min_order_qty;
  return q;
}

export function daysOnShelf(closing, perDay) {
  return perDay > 0 ? Math.round((closing || 0) / perDay) : 999;
}
