// "Buying, not selling": medicines bought again and again (often from
// different distributors) while hardly selling — wrong item mapping,
// automatic orders, duplicate codes.
import { sb, check, isRole, warehouseName } from './db.js';
import { esc, $, $$, fmtDate, fmtNum, toast, addDays, todayISO, downloadExcel } from './ui.js';

export const BNS_DEFAULTS = { bns_days: 30, bns_min_buys: 3, bns_min_dists: 2, bns_sell_pct: 25, bns_order_mode: 'warn' };
const limitsOf = (cfg) => ({
  days: Number(cfg.bns_days ?? BNS_DEFAULTS.bns_days), buys: Number(cfg.bns_min_buys ?? BNS_DEFAULTS.bns_min_buys),
  dists: Number(cfg.bns_min_dists ?? BNS_DEFAULTS.bns_min_dists), pct: Number(cfg.bns_sell_pct ?? BNS_DEFAULTS.bns_sell_pct),
  mode: cfg.bns_order_mode === 'untick' ? 'untick' : 'warn',
});

export async function fetchBns(warehouseId, from, to, L) {
  return sb.rpc('buying_not_selling', { p_warehouse_id: Number(warehouseId), p_from: from, p_to: to,
    p_min_buys: L.buys, p_min_dists: L.dists, p_sell_pct: L.pct }).then(check);
}

// For the Order Sheet: flagged medicines (last N days up to today) and blocked medicines
export async function orderSheetFlags(warehouseId, cfg) {
  const L = limitsOf(cfg);
  const [flags, blocks] = await Promise.all([
    fetchBns(warehouseId, addDays(todayISO(), -(L.days - 1)), todayISO(), L).catch(() => []),
    sb.from('item_blocks').select('item_id, reason, by_name, created_at').eq('warehouse_id', Number(warehouseId)).then(check).catch(() => []),
  ]);
  return {
    mode: L.mode, days: L.days,
    flags: new Map(flags.map((f) => [f.item_id, f])),
    blocks: new Map(blocks.map((b) => [b.item_id, b])),
  };
}

export const bnsLabel = (f, days) =>
  `Bought ${f.buys}× from ${f.dists} distributor${f.dists > 1 ? 's' : ''} in ${days} days, sold ${fmtNum(f.sold, 2)} of ${fmtNum(f.qty, 2)} strips`;

export function causes(f) {
  const out = [];
  for (const s of f.similar || []) out.push(`Sales may be billed under another code: "${s.name}" (${s.pack}) sold ${fmtNum(s.sold, 2)} strips`);
  if (f.disc) out.push('On the Duplicate Items list (discontinued) but still bought');
  if (f.not_app > 0) out.push(`${f.not_app} of ${f.lines} purchase(s) not ordered in the app — automatic order or wrong item mapping?`);
  if (!out.length) out.push('Slow seller bought again and again');
  return out;
}

// The card on the Purchases screen
export function bnsCard(box, getWarehouse, cfg) {
  const L = limitsOf(cfg);
  const admin = isRole('admin');
  let list = [], lastBlocks = [], periodNote = '';
  box.innerHTML = `
    <h3>Buying, not selling</h3>
    <p class="muted small">Medicines bought on many bills or from several distributors while hardly selling — usually a wrong item mapping,
      an automatic order, or a duplicate code. Biggest unsold quantity first.</p>
    <div class="filters">
      <label class="small">Last <input type="number" class="b-days" min="1" value="${L.days}" style="width:60px"> days</label>
      <label class="small">Bought on ≥ <input type="number" class="b-buys" min="1" value="${L.buys}" style="width:50px"> bills</label>
      <label class="small">or from ≥ <input type="number" class="b-dists" min="1" value="${L.dists}" style="width:50px"> distributors</label>
      <label class="small">and sold below <input type="number" class="b-pct" min="0" value="${L.pct}" style="width:55px">% of what was bought</label>
      <button class="btn small b-go">Show</button>
      <input type="search" class="b-q" placeholder="Search medicine…">
      <button class="btn ghost small b-dl">Download Excel</button>
    </div>
    ${admin ? `<div class="filters small">
      <label>Order Sheet: <select class="b-mode"><option value="warn" ${L.mode === 'warn' ? 'selected' : ''}>Warn only (label)</option>
        <option value="untick" ${L.mode === 'untick' ? 'selected' : ''}>Warn and untick</option></select></label>
      <button class="btn ghost small b-save">Save these limits for everyone</button>
      <span class="muted">Admin: use Block on a row to stop a medicine being ordered at this warehouse.</span></div>` : ''}
    <div class="b-out"><div class="loading">Loading…</div></div>`;

  const val = (c) => Number($(c, box).value);
  const cur = () => ({ days: Math.max(1, val('.b-days')), buys: Math.max(1, val('.b-buys')), dists: Math.max(1, val('.b-dists')), pct: Math.max(0, val('.b-pct')) });

  async function load() {
    const out = $('.b-out', box);
    out.innerHTML = '<div class="loading">Loading…</div>';
    const c = cur(), to = todayISO(), from = addDays(to, -(c.days - 1));
    try {
      const [rows, blocks, status] = await Promise.all([
        fetchBns(getWarehouse(), from, to, c),
        sb.from('item_blocks').select('item_id, reason, by_name, created_at').eq('warehouse_id', Number(getWarehouse())).then(check).catch(() => []),
        sb.rpc('sales_status').then(check).catch(() => []),
      ]);
      const last = status.find((x) => String(x.warehouse_id) === String(getWarehouse()))?.last_date;
      periodNote = last && last < to
        ? `Sales are uploaded up to ${fmtDate(last)}, so the ${c.days} days end there: ${fmtDate(addDays(last, -(c.days - 1)))} to ${fmtDate(last)}.`
        : `${fmtDate(from)} to ${fmtDate(to)}.`;
      if (blocks.length) {
        const names = await sb.from('items').select('id, name, pack_size').in('id', blocks.map((b) => b.item_id)).then(check).catch(() => []);
        blocks.forEach((b) => { b.items = names.find((n) => n.id === b.item_id); });
      }
      list = rows; lastBlocks = blocks;
      paint();
    } catch (e) { out.innerHTML = `<div class="note error">${esc(e.message)}</div>`; }
  }

  function paint() {
    const blocks = lastBlocks;
    const q = $('.b-q', box).value.trim().toLowerCase();
    const shown = list.filter((r) => !q || r.name.toLowerCase().includes(q));
    const out = $('.b-out', box);
    out.innerHTML = `<p class="small muted">Period: ${esc(periodNote)}</p>
      ${shown.length ? `<div class="scroll"><table class="tbl">
        <tr><th>Medicine</th><th>Bought</th><th class="num">Strips bought</th><th class="num">₹ bought</th><th class="num">Strips sold</th>
          <th class="num">Stock now</th><th class="num">Max</th><th>Likely cause</th>${admin ? '<th></th>' : ''}</tr>
        ${shown.map((r) => `<tr data-id="${r.item_id}">
          <td class="med"><b>${esc(r.name)}</b> <span class="muted">${esc(r.pack)}</span>
            ${r.blocked ? `<div><span class="pill failed">Blocked${r.blocked.reason ? `: ${esc(r.blocked.reason)}` : ''}</span></div>` : ''}
            <details class="small"><summary>${r.lines} purchase line(s)</summary>${r.bills.map((b) =>
              `${fmtDate(b.date)} · ${esc(b.dist)} · bill ${esc(b.bill)} · <b>${fmtNum(b.qty, 2)}</b>${b.app ? ' · <span class="muted">app order</span>' : ' · <b class="bounce-text">not ordered in app</b>'}`).join('<br>')}</details></td>
          <td class="small">${r.buys} bill(s) from ${r.dists}:<br>${esc((r.distributors || []).join(', '))}</td>
          <td class="num"><b>${fmtNum(r.qty, 2)}</b></td><td class="num">${fmtNum(r.amount)}</td>
          <td class="num">${fmtNum(r.sold, 2)}</td><td class="num">${r.stock == null ? '—' : fmtNum(r.stock, 2)}</td>
          <td class="num">${r.max == null ? '—' : fmtNum(r.max)}</td>
          <td>${causes(r).map((c) => `<div class="cause">${esc(c)}</div>`).join('')}</td>
          ${admin ? `<td>${r.blocked ? '<button class="btn ghost small b-unblock">Unblock</button>' : '<button class="btn danger small b-block">Block</button>'}</td>` : ''}</tr>`).join('')}
      </table></div>` : '<p class="muted">Nothing found with these limits. 👍</p>'}
      ${blocks.length ? `<details class="b-blocked"><summary><b>${blocks.length}</b> medicine(s) blocked from ordering at ${esc(warehouseName(getWarehouse()))}</summary>
        <table class="tbl compact">${blocks.map((b) => `<tr data-id="${b.item_id}"><td>${esc(b.items?.name || '')} <span class="muted">${esc(b.items?.pack_size || '')}</span></td>
          <td class="small">${esc(b.reason || '')}</td><td class="small muted">${esc(b.by_name || '')}, ${fmtDate(String(b.created_at).slice(0, 10))}</td>
          ${admin ? '<td><button class="btn ghost small b-unblock">Unblock</button></td>' : ''}</tr>`).join('')}</table></details>` : ''}`;

    $$('.b-block', out).forEach((btn) => (btn.onclick = async () => {
      const id = Number(btn.closest('tr').dataset.id), r = list.find((x) => x.item_id === id);
      const reason = prompt(`Block ordering of ${r.name} at ${warehouseName(getWarehouse())}?\nReason (shown to the team):`, causes(r)[0]);
      if (reason === null) return;
      try { await sb.rpc('block_item', { p_item_id: id, p_warehouse_id: Number(getWarehouse()), p_reason: reason }).then(check); toast('Blocked'); load(); }
      catch (e) { toast(e.message, 'error'); }
    }));
    $$('.b-unblock', out).forEach((btn) => (btn.onclick = async () => {
      try { await sb.rpc('unblock_item', { p_item_id: Number(btn.closest('tr').dataset.id), p_warehouse_id: Number(getWarehouse()) }).then(check); toast('Unblocked'); load(); }
      catch (e) { toast(e.message, 'error'); }
    }));
  }

  $('.b-go', box).onclick = load;
  $('.b-q', box).oninput = paint;
  $('.b-dl', box).onclick = () => {
    const c = cur();
    downloadExcel(`Buying not selling ${warehouseName(getWarehouse())} last ${c.days} days.xlsx`, {
      Medicines: list.map((r) => ({ 'Medicine Name': r.name, 'Pack Size': r.pack, Bills: r.buys, Distributors: (r.distributors || []).join(', '),
        'Strips bought': Number(r.qty), '₹ bought': Number(r.amount || 0), 'Strips sold': Number(r.sold), 'Stock now': r.stock == null ? '' : Number(r.stock),
        Max: r.max ?? '', 'Likely cause': causes(r).join('; '), Blocked: r.blocked ? (r.blocked.reason || 'Yes') : '' })),
      'Purchase lines': list.flatMap((r) => r.bills.map((b) => ({ 'Medicine Name': r.name, 'Pack Size': r.pack, Date: b.date, Distributor: b.dist,
        'Bill No': b.bill, Qty: Number(b.qty), Amount: Number(b.amount || 0), 'Ordered in app': b.app ? 'Yes' : 'No' }))),
    });
  };
  const save = $('.b-save', box);
  if (save) save.onclick = async () => {
    const c = cur();
    try {
      await sb.rpc('save_bns_settings', { p_days: c.days, p_min_buys: c.buys, p_min_dists: c.dists, p_sell_pct: c.pct, p_mode: $('.b-mode', box).value }).then(check);
      toast('Saved for everyone, including the Order Sheet');
    } catch (e) { toast(e.message, 'error'); }
  };
  return load;
}
