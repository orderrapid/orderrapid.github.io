// Same-day and N-day repeat purchases, from purchase_report_data().
// Pure function (no database calls) so it can be tested on its own.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const dayNum = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000);

// Builds both repeat lists from purchase_report_data()
export function buildReport(data, from, to) {
  const days = Number(data.repeat_days || 3);
  const retDays = Number(data.return_days || 7);   // a return this soon after buying cancels that purchase
  const items = new Map(data.items.map(([id, name, pack, st, max, grp, sold]) => [id, { id, name, pack, st, max, grp, sold: Number(sold) }]));
  const dist = data.distributors || {};
  const nb = (x) => norm(x);
  const buys = new Map();     // item -> [{date, bill, dist, qty}]
  for (const [item, date, bill, d, qty] of data.purchases) {
    if (!buys.has(item)) buys.set(item, []);
    buys.get(item).push({ date, bill, distId: d, dist: dist[d] || '', qty: Number(qty) });
  }
  const rets = new Map();     // item -> [{date, ref, dist, strips, loose}]
  for (const [item, date, ref, d, strips, loose] of data.returns || []) {
    if (!rets.has(item)) rets.set(item, []);
    rets.get(item).push({ date, ref, distId: d, dist: dist[d] || '', strips: strips === null ? null : Number(strips), loose: Number(loose) });
  }
  const ordersBy = new Map();
  for (const [item, no, at, d, qty, inv, ch] of data.orders) {
    if (!ordersBy.has(item)) ordersBy.set(item, []);
    ordersBy.get(item).push({ no, day: String(at).slice(0, 10), distId: d, qty: Number(qty), refs: [nb(inv), nb(ch)].filter(Boolean) });
  }
  // same medicine name in another pack size, bought around the same time
  const byName = new Map();
  for (const it of items.values()) { const k = nb(it.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(it); }

  const make = (it, group) => {
    const total = group.reduce((a, b) => a + b.qty, 0);
    const first = group[0].date, last = group[group.length - 1].date;
    // returns of this medicine on or after the first purchase and within retDays of the last one
    const returns = (rets.get(it.id) || []).filter((r) => r.date >= first && dayNum(r.date) <= dayNum(last) + retDays);
    const returned = returns.reduce((a, r) => a + (r.strips || 0), 0);
    const kept = total - returned;
    const causes = [];
    for (const r of returns) {
      causes.push(r.strips === null
        ? `Returned ${r.loose} loose to ${r.dist} on ${r.date} (no strip conversion — fix in Item master)`
        : `Returned ${r.strips} strip(s) to ${r.dist} on ${r.date} (ref ${r.ref})`);
    }
    if (it.st === 'discontinued') causes.push('Discontinued item bought (Duplicate Items list)');
    const ords = (ordersBy.get(it.id) || []).filter((o) => dayNum(o.day) >= dayNum(first) - 3 && dayNum(o.day) <= dayNum(last));
    const matched = group.filter((b) => ords.some((o) => o.distId === b.distId && o.refs.includes(nb(b.bill))));
    if (ords.length >= 2) causes.push(`Ordered ${ords.length} times in the app: ${ords.map((o) => o.no).join(', ')}`);
    if (!ords.length) causes.push('Not ordered through the app');
    else if (matched.length < group.length) causes.push(`${group.length - matched.length} purchase(s) not matched to an app order`);
    const others = (byName.get(nb(it.name)) || []).filter((o) => o.id !== it.id && (buys.get(o.id) || [])
      .some((b) => dayNum(b.date) >= dayNum(first) - days && dayNum(b.date) <= dayNum(last) + days));
    if (others.length) causes.push(`Also bought in other pack size: ${others.map((o) => o.pack).join(', ')}`);
    if (causes.length === returns.length) causes.push('Check: ordered once but bought more than once');
    return { name: it.name, pack: it.pack, grp: it.grp, buys: group, total, returned, kept, returns,
             max: it.max, extra: it.max == null ? 0 : Math.max(kept - it.max, 0), sold: it.sold, causes,
             // what was kept is no more than one of the purchases: the extra bill(s) went back
             settled: returned > 0 && kept <= Math.max(...group.map((b) => b.qty)) };
  };

  const same = [], multi = [];
  for (const [itemId, list] of buys) {
    const it = items.get(itemId) || { id: itemId, name: '?', pack: '' };
    list.sort((a, b) => a.date.localeCompare(b.date));
    // same day: more than one bill on one date
    const byDay = new Map();
    list.forEach((b) => { if (!byDay.has(b.date)) byDay.set(b.date, []); byDay.get(b.date).push(b); });
    for (const [d, g] of byDay) if (g.length > 1 && d >= from && d <= to) same.push(make(it, g));
    // runs where each purchase is within `days` of the previous one
    let run = [list[0]];
    const flush = () => {
      const dates = new Set(run.map((b) => b.date));
      if (dates.size >= 2 && run[run.length - 1].date >= from && run[0].date <= to) multi.push(make(it, run));
    };
    for (let i = 1; i < list.length; i++) {
      if (dayNum(list[i].date) - dayNum(run[run.length - 1].date) <= days) run.push(list[i]);
      else { flush(); run = [list[i]]; }
    }
    flush();
  }
  const order = (a, b) => b.extra - a.extra || b.kept - a.kept;
  // repeats fully settled by a return are listed apart, not as problems
  const open = (l) => l.filter((r) => !r.settled).sort(order), settled = (l) => l.filter((r) => r.settled);
  return { same: open(same), multi: open(multi), settled: [...settled(same), ...settled(multi)] };
}
