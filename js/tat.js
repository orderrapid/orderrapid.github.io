// Turn Around Time report (Reports → Turn Around Time)
//  A. Delivery: order placed → goods arrived, per distributor; on time vs expected
//  D. Bounce follow-up: bounce recorded → same medicine ordered again
import { sb, check, state, isRole, warehouseName } from './db.js';
import { esc, $, $$, fmtDate, fmtDateTime, fmtNum, toast, addDays, todayISO, downloadExcel } from './ui.js';

const H = 3600000;
export function fmtH(h) {
  if (h === null || h === undefined || !isFinite(h)) return '—';
  if (h < 1) return `${Math.max(0, Math.round(h * 60))} m`;
  if (h < 48) { const w = Math.floor(h), m = Math.round((h - w) * 60); return m ? `${w} h ${m} m` : `${w} h`; }
  const d = Math.floor(h / 24), r = Math.round(h - d * 24);
  return r ? `${d} d ${r} h` : `${d} d`;
}
const hoursBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / H;
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const timeOf = (iso) => fmtDateTime(iso);

const F = { from: addDays(todayISO(), -29), to: todayISO(), all: false };

export async function drawTat(view, warehouseId) {
  const admin = isRole('admin');
  view.innerHTML = `
    <div class="filters">
      <label class="small">Orders placed from <input type="date" id="tf" value="${F.from}"></label>
      <label class="small">to <input type="date" id="tt" value="${F.to}"></label>
      <label class="small"><input type="checkbox" id="tall" ${F.all ? 'checked' : ''}> All warehouses</label>
      <button class="btn ghost small" id="tdl">Download Excel</button>
    </div>
    <div id="tout"><div class="loading">Loading…</div></div>`;
  $('#tf', view).onchange = (e) => { F.from = e.target.value || F.from; drawTat(view, warehouseId); };
  $('#tt', view).onchange = (e) => { F.to = e.target.value || F.to; drawTat(view, warehouseId); };
  $('#tall', view).onchange = (e) => { F.all = e.target.checked; drawTat(view, warehouseId); };

  let d;
  try { d = await sb.rpc('tat_report', { p_warehouse_id: F.all ? null : Number(warehouseId), p_from: F.from, p_to: F.to }).then(check); }
  catch (e) { $('#tout', view).innerHTML = `<div class="note error">${esc(e.message)}</div>`; return; }
  const T = Number(d.target), B = Number(d.bounce_target), now = new Date().toISOString();
  const whLabel = F.all ? 'All warehouses' : warehouseName(warehouseId);

  // ----- A. delivery -----
  const orders = d.orders.map((o) => ({
    ...o,
    tat: o.arrived ? Math.max(0, hoursBetween(o.placed, o.arrived)) : null,
    onTime: o.arrived && o.expected ? Date.parse(o.arrived) <= Date.parse(o.expected) : null,
    waiting: !o.received ? hoursBetween(o.placed, now) : null,
    late: !o.received && o.expected && Date.parse(o.expected) < Date.now() ? hoursBetween(o.expected, now) : null,
  }));
  const byDist = new Map();
  for (const o of orders) {
    const k = o.dist || '—';
    if (!byDist.has(k)) byDist.set(k, { dist: k, orders: 0, tats: [], over: 0, ot: 0, otN: 0, lines: 0, bounced: 0, noTime: 0, waiting: 0 });
    const s = byDist.get(k);
    s.orders++; s.lines += o.lines; s.bounced += o.bounced;
    if (o.tat !== null) { s.tats.push(o.tat); if (o.tat > T) s.over++; }
    else if (o.received) s.noTime++;
    else s.waiting++;
    if (o.onTime !== null) { s.otN++; if (o.onTime) s.ot++; }
  }
  const dists = [...byDist.values()].map((s) => ({ ...s, avg: avg(s.tats), min: s.tats.length ? Math.min(...s.tats) : null, max: s.tats.length ? Math.max(...s.tats) : null }))
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
  const allT = orders.filter((o) => o.tat !== null).map((o) => o.tat);
  const ot = orders.filter((o) => o.onTime !== null);
  const noTime = orders.filter((o) => o.received && o.tat === null).length;
  const waiting = orders.filter((o) => !o.received).sort((a, b) => b.waiting - a.waiting);

  // ----- D. bounce follow-up -----
  const bounces = d.bounces.map((b) => ({
    ...b,
    follow: b.re_at ? Math.max(0, hoursBetween(b.at, b.re_at)) : null,
    pending: b.re_at ? null : hoursBetween(b.at, now),
  }));
  const done = bounces.filter((b) => b.follow !== null), pend = bounces.filter((b) => b.follow === null).sort((a, b) => b.pending - a.pending);
  const byPerson = new Map();
  for (const b of done) {
    const k = b.re_by || '—';
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(b.follow);
  }

  $('#tout', view).innerHTML = `
    <p class="muted small">${esc(whLabel)} · orders placed ${fmtDate(F.from)} to ${fmtDate(F.to)} · delivery target <b>${fmtH(T)}</b>, bounce follow-up target <b>${fmtH(B)}</b>.
      TAT runs from <i>order placed</i> to <i>goods arrived</i> (the arrival time typed when receiving, or from the purchase file).</p>
    ${admin ? `<div class="filters small">Targets: delivery <input type="number" id="tT" min="0.5" step="0.5" value="${T}" style="width:60px"> h,
      bounce follow-up <input type="number" id="tB" min="0.5" step="0.5" value="${B}" style="width:60px"> h <button class="btn ghost small" id="tsave">Save</button></div>` : ''}

    <h3>A. Delivery by distributor</h3>
    <div class="kv">
      <div><span>Orders</span><b>${fmtNum(orders.length)}</b></div>
      <div><span>Average TAT</span><b>${fmtH(avg(allT))}</b></div>
      <div><span>Over ${fmtH(T)}</span><b>${fmtNum(allT.filter((t) => t > T).length)}</b></div>
      <div><span>On time (vs expected)</span><b>${ot.length ? `${Math.round((100 * ot.filter((o) => o.onTime).length) / ot.length)}%` : '—'}</b></div>
      <div><span>Still waiting</span><b>${fmtNum(waiting.length)}</b></div>
    </div>
    ${noTime ? `<p class="note">${fmtNum(noTime)} received order(s) have no arrival time (received by purchase upload without a time column) and are left out of TAT.</p>` : ''}
    ${dists.length ? `<div class="scroll"><table class="tbl">
      <tr><th>Distributor</th><th class="num">Orders</th><th class="num">Avg TAT</th><th class="num">Fastest</th><th class="num">Slowest</th>
        <th class="num">Over target</th><th class="num">On time</th><th class="num">Bounce %</th><th class="num">Waiting</th></tr>
      ${dists.map((s) => `<tr class="click" data-d="${esc(s.dist)}"><td><b>${esc(s.dist)}</b></td><td class="num">${fmtNum(s.orders)}</td>
        <td class="num"><b>${fmtH(s.avg)}</b></td><td class="num">${fmtH(s.min)}</td><td class="num">${fmtH(s.max)}</td>
        <td class="num">${s.tats.length ? `${s.over} (${Math.round((100 * s.over) / s.tats.length)}%)` : '—'}</td>
        <td class="num">${s.otN ? `${Math.round((100 * s.ot) / s.otN)}%` : '—'}</td>
        <td class="num">${s.lines ? `${((100 * s.bounced) / s.lines).toFixed(0)}%` : '—'}</td><td class="num">${s.waiting || ''}</td></tr>`).join('')}
    </table></div><p class="muted small">Click a distributor to see its orders.</p><div id="tdist"></div>` : '<p class="muted">No orders in these dates.</p>'}

    <h3>Orders still waiting</h3>
    ${waiting.length ? `<div class="scroll"><table class="tbl compact">
      <tr><th>Order no.</th>${F.all ? '<th>Warehouse</th>' : ''}<th>Distributor</th><th>Placed</th><th>Expected by</th><th class="num">Waiting</th><th></th></tr>
      ${waiting.map((o) => `<tr class="${o.late !== null ? 'bounced-row' : ''}"><td><b>${esc(o.no || '')}</b></td>${F.all ? `<td>${esc(warehouseName(o.wh))}</td>` : ''}
        <td>${esc(o.dist || '')}</td><td class="nowrap">${timeOf(o.placed)}</td><td class="nowrap">${o.expected ? timeOf(o.expected) : '—'}</td>
        <td class="num"><b>${fmtH(o.waiting)}</b></td><td>${o.late !== null ? `<span class="pill failed">${fmtH(o.late)} late</span>` : o.waiting > T ? '<span class="pill warn">over target</span>' : ''}</td></tr>`).join('')}
    </table></div>` : '<p class="muted">Nothing waiting. 👍</p>'}

    <h3>D. Bounce follow-up</h3>
    <div class="kv">
      <div><span>Bounced lines</span><b>${fmtNum(bounces.length)}</b></div>
      <div><span>Re-ordered</span><b>${fmtNum(done.length)}</b></div>
      <div><span>Average follow-up</span><b>${fmtH(avg(done.map((b) => b.follow)))}</b></div>
      <div><span>Within ${fmtH(B)}</span><b>${done.length ? `${Math.round((100 * done.filter((b) => b.follow <= B).length) / done.length)}%` : '—'}</b></div>
      <div><span>Not re-ordered yet</span><b class="${pend.length ? 'bounce-text' : ''}">${fmtNum(pend.length)}</b></div>
    </div>
    <h4>Not re-ordered yet</h4>
    ${pend.length ? `<div class="scroll"><table class="tbl compact">
      <tr><th>Medicine</th>${F.all ? '<th>Warehouse</th>' : ''}<th>Bounced by</th><th>Order</th><th class="num">Short (strips)</th><th>Bounce recorded</th><th class="num">Waiting</th></tr>
      ${pend.map((b) => `<tr class="${b.pending > B ? 'bounced-row' : ''}"><td><b>${esc(b.item)}</b> <span class="muted">${esc(b.pack)}</span></td>${F.all ? `<td>${esc(warehouseName(b.wh))}</td>` : ''}
        <td>${esc(b.dist || '')}</td><td>${esc(b.no || '')}</td><td class="num">${fmtNum(b.short, 2)}</td><td class="nowrap">${b.at ? timeOf(b.at) : '—'}</td>
        <td class="num"><b>${fmtH(b.pending)}</b></td></tr>`).join('')}
    </table></div>` : '<p class="muted">Every bounced medicine has been ordered again. 👍</p>'}
    ${byPerson.size ? `<h4>Re-ordered by</h4><table class="tbl compact"><tr><th>Team member</th><th class="num">Re-orders</th><th class="num">Average follow-up</th><th class="num">Within ${fmtH(B)}</th></tr>
      ${[...byPerson].sort((a, b) => avg(a[1]) - avg(b[1])).map(([p, xs]) => `<tr><td>${esc(p)}</td><td class="num">${xs.length}</td><td class="num">${fmtH(avg(xs))}</td>
        <td class="num">${Math.round((100 * xs.filter((x) => x <= B).length) / xs.length)}%</td></tr>`).join('')}</table>` : ''}`;

  $$('#tout tr.click', view).forEach((tr) => (tr.onclick = () => {
    const name = tr.dataset.d, os = orders.filter((o) => (o.dist || '—') === name).reverse();
    $('#tdist', view).innerHTML = `<h4>${esc(name)} — ${os.length} order(s)</h4><div class="scroll"><table class="tbl compact">
      <tr><th>Order no.</th>${F.all ? '<th>Warehouse</th>' : ''}<th>Placed</th><th>Expected</th><th>Arrived</th><th class="num">TAT</th><th>On time</th><th class="num">Bounced lines</th><th>By</th></tr>
      ${os.map((o) => `<tr><td><b>${esc(o.no || '')}</b></td>${F.all ? `<td>${esc(warehouseName(o.wh))}</td>` : ''}<td class="nowrap">${timeOf(o.placed)}</td>
        <td class="nowrap">${o.expected ? timeOf(o.expected) : '—'}</td>
        <td class="nowrap">${o.arrived ? `${timeOf(o.arrived)}${o.asource === 'purchase upload' ? ' <span class="muted small">(file)</span>' : ''}` : o.received ? '<span class="muted">no time</span>' : '<span class="pill running">waiting</span>'}</td>
        <td class="num">${o.tat === null ? '—' : `<b class="${o.tat > T ? 'bounce-text' : ''}">${fmtH(o.tat)}</b>`}</td>
        <td>${o.onTime === null ? '' : o.onTime ? '✓' : `<span class="bounce-text">late ${fmtH(hoursBetween(o.expected, o.arrived))}</span>`}</td>
        <td class="num">${o.bounced || ''}</td><td>${esc(o.by || '')}</td></tr>`).join('')}</table></div>`;
    $('#tdist', view).scrollIntoView({ behavior: 'smooth' });
  }));

  const save = $('#tsave', view);
  if (save) save.onclick = async () => {
    try { await sb.rpc('save_tat_settings', { p_target: Number($('#tT', view).value), p_bounce: Number($('#tB', view).value) }).then(check); toast('Targets saved'); drawTat(view, warehouseId); }
    catch (e) { toast(e.message, 'error'); }
  };

  $('#tdl', view).onclick = () => downloadExcel(`Turn Around Time ${whLabel} ${F.from} to ${F.to}.xlsx`, {
    Distributors: dists.map((s) => ({ Distributor: s.dist, Orders: s.orders, 'Avg TAT (h)': s.avg === null ? '' : +s.avg.toFixed(2),
      'Fastest (h)': s.min === null ? '' : +s.min.toFixed(2), 'Slowest (h)': s.max === null ? '' : +s.max.toFixed(2),
      [`Over ${T} h`]: s.over, 'On time %': s.otN ? Math.round((100 * s.ot) / s.otN) : '', 'Bounce %': s.lines ? +((100 * s.bounced) / s.lines).toFixed(1) : '',
      Waiting: s.waiting, 'No arrival time': s.noTime })),
    Orders: orders.map((o) => ({ 'Order no.': o.no, Warehouse: warehouseName(o.wh), Distributor: o.dist, 'Placed by': o.by || '', Placed: timeOf(o.placed),
      'Expected by': o.expected ? timeOf(o.expected) : '', Arrived: o.arrived ? timeOf(o.arrived) : '', 'Arrival from': o.asource || '',
      'TAT (h)': o.tat === null ? '' : +o.tat.toFixed(2), 'On time': o.onTime === null ? '' : o.onTime ? 'Yes' : 'No',
      'Waiting (h)': o.waiting === null ? '' : +o.waiting.toFixed(1), 'Bounced lines': o.bounced })),
    Bounces: bounces.map((b) => ({ Medicine: b.item, 'Pack Size': b.pack, Warehouse: warehouseName(b.wh), 'Bounced by': b.dist, Order: b.no,
      'Short (strips)': Number(b.short), 'Bounce recorded': b.at ? timeOf(b.at) : '', 'Re-ordered': b.re_at ? timeOf(b.re_at) : 'Not yet',
      'Re-order no.': b.re_no || '', 'Re-ordered from': b.re_dist || '', 'Re-ordered by': b.re_by || '',
      'Follow-up (h)': b.follow === null ? '' : +b.follow.toFixed(2), 'Waiting (h)': b.pending === null ? '' : +b.pending.toFixed(1) })),
  });
}
