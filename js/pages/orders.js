import { sb, check, state, rememberWarehouse, warehouseName, isRole } from '../db.js';
import { esc, $, $$, fmtDate, fmtDateTime, fmtNum, toast, confirmBox, promptBox, warehouseOptions, downloadExcel, todayISO } from '../ui.js';
import { orderQty, daysOnShelf, GROUP_ORDER } from '../analysis.js';
import { levelsStatus, recalculate, loadSettings } from '../levels.js';

const SHOW = 500;   // rows drawn per tab; the download has everything

const TABS = [
  ['order', 'Order Sheet'],
  ['checked', 'No order needed'],
  ['decide', 'New – Decide'],
  ['over', 'Too Much Stock'],
  ['notorder', 'Not Ordering'],
  ['slow', 'Slow Medicines'],
  ['history', 'Orders placed'],
];

export default {
  title: 'Orders',
  roles: ['admin', 'purchase', 'manager'],
  async render(el) {
    const canPlace = isRole('admin', 'purchase');
    el.classList.add('wide-page');
    el.innerHTML = `
      <h1>Orders</h1>
      <div class="card">
        <div class="form-row">
          <label class="field"><span>Warehouse</span>
            <select id="wh">${warehouseOptions(state.warehouses, state.warehouseId)}</select></label>
          <div class="field status-box" id="fresh"></div>
          <button class="btn ghost small" id="recalc" title="Work out Min / Max again from the latest sales">Recalculate</button>
        </div>
        <div id="alerts"></div>
      </div>
      <div class="card">
        <div class="tabs-inline" id="tabs">${TABS.map(([k, l]) => `<button class="tab" data-t="${k}">${l} <span class="count" data-c="${k}"></span></button>`).join('')}</div>
        <div id="view"><div class="loading">Loading…</div></div>
      </div>`;

    const whSel = $('#wh', el);
    let rows = [], cfg = {}, tab = 'order', stockAt = null, extra = new Map();
    // extra: medicines added by hand to the order (item_id -> qty)
    const qtyEdits = new Map(), unticked = new Set(), userTicked = new Set();
    const grpFilter = new Set();   // Order Sheet group filter (empty = all)
    const attr = { category: '', ailment: '', manufacturer: '', brand: '' };   // Order Sheet detail filters
    const ATTR_LABEL = { category: 'Category', ailment: 'Ailment', manufacturer: 'Manufacturer', brand: 'Brand' };
    const attrOk = (r) => Object.entries(attr).every(([k, v]) => !v || (r[k] || '(not set)') === v);
    let more = false, dists = [];
    const distChoice = new Map();   // item_id -> distributor chosen on this screen
    try { more = localStorage.getItem('orderMoreCols') === '1'; } catch { /* ignore */ }

    whSel.onchange = () => { rememberWarehouse(whSel.value); extra.clear(); qtyEdits.clear(); unticked.clear(); userTicked.clear(); distChoice.clear(); load(); };
    $('#recalc', el).onclick = () => load(true);
    $$('#tabs .tab', el).forEach((b) => (b.onclick = () => { tab = b.dataset.t; draw(); }));

    async function load(force = false) {
      const view = $('#view', el);
      view.innerHTML = '<div class="loading">Loading…</div>';
      $('#alerts', el).innerHTML = '';
      const wh = whSel.value;
      cfg = await loadSettings();
      let st = await levelsStatus(wh);
      if (st.salesUpTo && (st.stale || force)) {
        try {
          await recalculate(wh, (m) => { view.innerHTML = `<div class="loading">${esc(m)} (${esc(warehouseName(wh))})</div>`; });
          st = await levelsStatus(wh);
        } catch (e) {
          $('#alerts', el).innerHTML = `<div class="note error">Could not recalculate: ${esc(e.message)}</div>`;
        }
      }
      const [sheet, up] = await Promise.all([
        sb.rpc('order_sheet', { p_warehouse_id: Number(wh) }).then(check),
        sb.from('stock_uploads').select('created_at, file_name').eq('warehouse_id', Number(wh))
          .order('created_at', { ascending: false }).limit(1).then(check),
      ]);
      // levels saved before Sold 7d / 60d existed: work them out once more
      const withLevels = sheet.filter((r) => r.grp !== 'Not sold');
      if (!force && withLevels.length && withLevels.every((r) => r.qty_7 == null)) return load(true);
      stockAt = up[0]?.created_at || null;
      const stockFile = up[0]?.file_name || '';
      rows = sheet.map((r) => {
        const counted = r.closing === null ? (r.stock_flag === 'No conversion' ? null : 0) : Number(r.closing);
        // supplied quantities received after the stock upload count as stock
        const recv = Number(r.recv_after_stock || 0);
        const closing = counted === null ? null : counted + recv;
        const open = Number(r.open_qty || 0);
        const bounced = Number(r.bounce_qty || 0) > 0;
        const level = { can_order: r.can_order, min_stock: r.min_stock, max_stock: r.max_stock, grp: r.grp };
        return {
          ...r, counted, recv, closing, open, bounced,
          // discontinued for this warehouse (Duplicate Items list): never suggested
          suggested: closing === null || r.disc ? 0 : orderQty(level, closing, open, cfg),
          shelfDays: closing === null ? null : daysOnShelf(closing, Number(r.per_day || 0)),
          orderedToday: Number(r.today_qty || 0) > 0 && !bounced,
        };
      });
      // already ordered today: unticked unless someone ticked it on purpose
      rows.forEach((r) => { if (r.orderedToday && !userTicked.has(r.item_id)) unticked.add(r.item_id); });

      // freshness box
      $('#fresh', el).innerHTML = st.run
        ? `<span class="label">Min / Max from sales up to</span><span class="value">${fmtDate(st.run.sales_up_to)}</span>
           <span class="hint">Sales Min / Max calculated ${fmtDateTime(st.run.computed_at)}</span>`
        : `<span class="label">No sales uploaded yet for ${esc(warehouseName(wh))}</span>`;
      const alerts = [];
      if (!stockAt) alerts.push(`No stock uploaded for ${esc(warehouseName(wh))} yet. <a href="#/stock">Upload stock</a> — the full stock, or just the medicines that sold — and this screen tells you which of them to order.`);
      else {
        const old = new Date(stockAt).toDateString() !== new Date().toDateString();
        alerts.push(`<span class="info">Checking <b>${fmtNum(rows.length)}</b> medicines from the stock upload of <b>${fmtDateTime(stockAt)}</b>${stockFile ? ` (${esc(stockFile)})` : ''}:
          <b>${fmtNum(rows.filter((r) => r.suggested > 0).length)}</b> to order, <b>${fmtNum(rows.filter((r) => !(r.suggested > 0)).length)}</b> no order needed.
          Medicines not in that file are not checked.</span>${old ? '<br><b>This upload is not from today.</b> Upload a fresh stock file to check the latest.' : ''}`);
      }
      const noConv = rows.filter((r) => r.closing === null && r.can_order).length;
      if (noConv) alerts.push(`<b>${noConv}</b> medicine(s) have stock but no loose-to-strip conversion, so they are left out of the order. ${isRole('admin', 'manager') ? '<a href="#/items">Fix in Item master</a>' : 'Ask the Admin or Manager to fix them in Item master.'}`);
      $('#alerts', el).innerHTML = alerts.map((a) => `<div class="note ${a.startsWith('<span class="info">') && !a.includes('not from today') ? '' : 'warn'}">${a}</div>`).join('');
      draw();
    }

    // ------------------------------------------------------------------
    const pick = {
      order: () => rows.filter((r) => r.suggested > 0 || extra.has(r.item_id))
        .sort((a, b) => (GROUP_ORDER[a.grp] ?? 9) - (GROUP_ORDER[b.grp] ?? 9) || (b.qty_30 || 0) - (a.qty_30 || 0)),
      decide: () => rows.filter((r) => !r.disc && r.grp === 'New' && !r.can_order && /decide by hand/.test(r.why || ''))
        .sort((a, b) => (a.days_since ?? 999) - (b.days_since ?? 999)),
      over: () => rows.filter((r) => r.closing > 0 && r.shelfDays > (cfg.expiry_warning_days || 60))
        .sort((a, b) => b.shelfDays - a.shelfDays),
      notorder: () => rows.filter((r) => r.disc || (!r.can_order && !/decide by hand/.test(r.why || '')))
        .sort((a, b) => (a.days_since ?? 9999) - (b.days_since ?? 9999)),
      slow: () => rows.filter((r) => (r.grp || '').startsWith('Slow')).sort((a, b) => (b.qty_90 || 0) - (a.qty_90 || 0)),
      checked: () => rows.filter((r) => !(r.suggested > 0) && !extra.has(r.item_id))
        .sort((a, b) => reasonOrder(a) - reasonOrder(b) || a.name.localeCompare(b.name)),
    };

    const grpCell = (r) => `${esc(r.grp)}${r.growing ? '<div><span class="pill done">Growing</span></div>' : ''}${r.chronic
      ? `<div><span class="pill chronic" title="Marked Chronic in the item master">${r.grp === 'New' && Number(r.total_bills || 0) < 2 ? 'Chronic – stocked after 1st sale' : 'Chronic'}</span></div>` : ''}`;
    const todayNote = (r) => r.bounced
      ? `<div class="bounce-note">Bounced by ${esc(r.bounce_dist || 'distributor')}${r.bounce_at ? ` (${fmtDateTime(r.bounce_at)})` : ''} – ${fmtNum(r.bounce_qty, 2)} strips not supplied. Order from another distributor.</div>`
      : r.orderedToday
      ? `<div class="today-note">Ordered today ${fmtDateTime(r.last_order_at).split(', ')[1] || ''} – ${fmtNum(r.today_qty, 2)} strips${r.last_order_by ? ` (${esc(r.last_order_by)})` : ''}${r.last_order_distributor ? `, ${esc(r.last_order_distributor)}` : ''}${r.last_order_no ? ` · ${esc(r.last_order_no)}` : ''} · ${r.last_received ? 'received' : 'on order'}</div>` : '';
    const stockCell = (r) => r.closing === null ? '<span class="pill warn">No conversion</span>'
      : r.recv > 0 ? `${fmtNum(r.closing, 2)}<div class="small muted" title="counted + received after the stock upload">${fmtNum(r.counted, 2)} + ${fmtNum(r.recv, 2)} recd</div>` : fmtNum(r.closing, 2);
    const GROUP_KEYS = ['Fast', 'Average', 'New', 'Slow (Regular)', 'Slow (Irregular)', 'Rare'];
    const grpKey = (g) => (GROUP_KEYS.includes(g) ? g : 'Other');

    function draw() {
      $$('#tabs .tab', el).forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
      for (const k of Object.keys(pick)) { const n = pick[k]().length; const c = $(`[data-c="${k}"]`, el); if (c) c.textContent = n ? `(${fmtNum(n)})` : ''; }
      const view = $('#view', el);
      if (tab === 'history') return drawHistory(view);
      if (tab === 'order') return drawOrder(view);
      const list = pick[tab]();
      const cols = {
        checked: [['Medicine', (r) => esc(r.name) + todayNote(r)], ['Pack', (r) => esc(r.pack_size)], ['Reason', (r) => esc(reason(r))],
          ['Group', grpCell], ['Stock', stockCell], ['On order', (r) => r.open ? fmtNum(r.open, 2) : ''],
          ['Min', (r) => r.can_order ? fmtNum(r.min_stock) : ''], ['Max', (r) => r.can_order ? fmtNum(r.max_stock) : ''],
          ['Sold 30d', (r) => fmtNum(r.qty_30, 2)], ['Last sold', (r) => fmtDate(r.last_sold)]],
        decide: [['Medicine', (r) => esc(r.name)], ['Pack', (r) => esc(r.pack_size)], ['Days selling', (r) => fmtNum(r.days_selling)],
          ['Bills (360d)', (r) => fmtNum(r.total_bills)], ['Customers 30d', (r) => fmtNum(r.cust_30)], ['Normal sale', (r) => fmtNum(r.normal_sale, 1)],
          ['Sold 30d', (r) => fmtNum(r.qty_30, 2)], ['Stock', stockCell], ['Last sold', (r) => fmtDate(r.last_sold)], ['Days since', (r) => fmtNum(r.days_since)]],
        over: [['Medicine', (r) => esc(r.name)], ['Pack', (r) => esc(r.pack_size)], ['Group', grpCell], ['Stock', stockCell],
          ['Strips/day', (r) => fmtNum(r.per_day, 3)], ['Days on shelf', (r) => r.shelfDays === 999 ? 'Not selling' : fmtNum(r.shelfDays)],
          ['Max', (r) => fmtNum(r.max_stock)], ['Sold 90d', (r) => fmtNum(r.qty_90, 2)], ['Last sold', (r) => fmtDate(r.last_sold)]],
        notorder: [['Medicine', (r) => esc(r.name)], ['Pack', (r) => esc(r.pack_size)], ['Why', (r) => r.disc ? '<span class="pill failed">Discontinued</span> Duplicate Items list' : esc(r.why || 'Not sold in the last year')],
          ['Stock', stockCell], ['Last sold', (r) => fmtDate(r.last_sold)], ['Days since', (r) => fmtNum(r.days_since)]],
        slow: [['Medicine', (r) => esc(r.name)], ['Pack', (r) => esc(r.pack_size)], ['Group', grpCell], ['Weeks sold (of 13)', (r) => fmtNum(r.weeks_sold)],
          ['Normal sale', (r) => fmtNum(r.normal_sale, 1)], ['Min', (r) => fmtNum(r.min_stock)], ['Max', (r) => fmtNum(r.max_stock)],
          ['Stock', stockCell], ['Sold 90d', (r) => fmtNum(r.qty_90, 2)], ['Why', (r) => esc(r.why)]],
      }[tab];
      const addBtn = tab === 'decide' && canPlace;
      view.innerHTML = `
        <div class="row"><input type="search" id="q" placeholder="Search medicine…">
          <button class="btn ghost small" id="dl">Download Excel</button></div>
        ${tab === 'decide' ? '<p class="muted small">New medicines with only one sale so far. The numbers can\'t tell a chronic patient from a one-off; you can. Add the ones you want to stock to today\'s order.</p>' : ''}
        ${tab === 'checked' ? '<p class="muted small">Every medicine from the stock upload that does not need ordering now, and why.</p>' : ''}
        ${tab === 'over' ? `<p class="muted small">Stock on the shelf that will last more than ${cfg.expiry_warning_days || 60} days at the current selling rate.</p>` : ''}
        <div class="scroll"><table class="tbl" id="t">
          <tr>${cols.map(([h]) => `<th>${h}</th>`).join('')}${addBtn ? '<th></th>' : ''}</tr>
        </table></div><p class="muted small" id="more"></p>`;
      const paint = () => {
        const q = $('#q', view).value.trim().toLowerCase();
        const shown = list.filter((r) => !q || r.name.toLowerCase().includes(q));
        $('#t', view).innerHTML = `<tr>${cols.map(([h]) => `<th>${h}</th>`).join('')}${addBtn ? '<th></th>' : ''}</tr>` +
          shown.slice(0, SHOW).map((r) => `<tr data-id="${r.item_id}">${cols.map(([, f]) => `<td>${f(r)}</td>`).join('')}
            ${addBtn ? `<td>${extra.has(r.item_id) ? '<span class="pill done">Added</span>' : '<button class="btn ghost small add">+ Add to order</button>'}</td>` : ''}</tr>`).join('');
        $('#more', view).textContent = shown.length > SHOW ? `Showing ${SHOW} of ${fmtNum(shown.length)}. Search, or download for the full list.` : '';
        $$('button.add', view).forEach((b) => (b.onclick = () => {
          const r = rows.find((x) => x.item_id === Number(b.closest('tr').dataset.id));
          extra.set(r.item_id, Math.max(Math.ceil(Number(r.normal_sale || 1)), 1));
          toast(`${r.name} added to the Order Sheet`); paint();
        }));
      };
      $('#q', view).oninput = paint;
      $('#dl', view).onclick = () => downloadExcel(`${TABS.find((t) => t[0] === tab)[1]} - ${warehouseName(whSel.value)}.xlsx`,
        { Sheet: list.map((r) => Object.fromEntries(cols.map(([h, f]) => [h, plain(f(r))]))) });
      paint();
    }

    // ---------------- Order Sheet ----------------
    function finalQty(r) {
      if (qtyEdits.has(r.item_id)) return qtyEdits.get(r.item_id);
      if (extra.has(r.item_id) && !r.suggested) return extra.get(r.item_id);
      return r.suggested;
    }

    async function drawOrder(view) {
      const all0 = pick.order();
      const all = all0.filter(attrOk);
      const list = all.filter((r) => !grpFilter.size || grpFilter.has(grpKey(r.grp)));
      const optsFor = (k) => [...new Set(all0.map((r) => r[k] || '(not set)'))].sort((a, b) => a.localeCompare(b));
      const grpCounts = {};
      all.forEach((r) => { const k = grpKey(r.grp); grpCounts[k] = (grpCounts[k] || 0) + 1; });
      const leftOut = rows.filter((r) => r.orderedToday && r.suggested === 0 && !extra.has(r.item_id));
      dists = await sb.from('distributors').select('id, name').eq('active', true).order('name').then(check);
      const distOpts = (sel) => `<option value="">Choose…</option>${dists.map((d) => `<option value="${d.id}" ${String(d.id) === String(sel ?? '') ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}${canPlace ? '<option value="new">+ Add distributor…</option>' : ''}`;
      // default distributor = the one last used, but never the one that just bounced it
      const distOf = (r) => distChoice.has(r.item_id) ? distChoice.get(r.item_id)
        : (r.bounced && r.usual_distributor_id === r.bounce_dist_id ? '' : (r.usual_distributor_id ?? ''));
      view.innerHTML = `
        <div class="chips" id="grps">
          <button class="chip ${grpFilter.size ? '' : 'on'}" data-g="">All <span>${fmtNum(all.length)}</span></button>
          ${[...GROUP_KEYS, 'Other'].filter((g) => grpCounts[g]).map((g) => `<button class="chip ${grpFilter.has(g) ? 'on' : ''}" data-g="${esc(g)}">${esc(g)} <span>${fmtNum(grpCounts[g])}</span></button>`).join('')}
        </div>
        <div class="filters" id="attrs">
          ${Object.keys(attr).map((k) => `<select data-k="${k}" class="${attr[k] ? 'set' : ''}"><option value="">All ${ATTR_LABEL[k].toLowerCase()}s</option>
            ${optsFor(k).map((v) => `<option ${attr[k] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`).join('')}
          ${Object.values(attr).some(Boolean) ? '<button class="btn ghost small" id="clrA">Clear filters</button>' : ''}
        </div>
        <div class="row">
          <input type="search" id="q" placeholder="Search in this list…">
          <div class="add-box"><input type="search" id="addq" placeholder="+ Add another medicine…" autocomplete="off"><div id="addres" class="add-res"></div></div>
          <label class="switch"><input type="checkbox" id="moreCols" ${more ? 'checked' : ''}> Show more columns</label>
          ${canPlace ? `<span class="setall">Distributor for all ticked: <select id="distAll">${distOpts('')}</select></span>` : ''}
        </div>
        ${leftOut.length ? `<details class="note"><summary><b>${leftOut.length}</b> medicine(s) were ordered earlier today and are already covered — not suggested again</summary>
          <table class="tbl compact">${leftOut.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.pack_size)}</td><td>${todayNote(r)}</td></tr>`).join('')}</table></details>` : ''}
        <div class="scroll"><table class="tbl order" id="t"></table></div>
        <p class="muted small" id="more"></p>
        <div class="order-bar">
          <div id="sum"></div>
          ${canPlace ? `<input id="note" placeholder="Note (optional)">
          <button class="btn primary" id="place">Place order</button>` : '<span class="muted small">Only Admin or Purchase Team can place orders.</span>'}
          <button class="btn ghost" id="dl">Download Excel</button>
        </div>`;

      const paint = () => {
        const q = $('#q', view).value.trim().toLowerCase();
        const shown = list.filter((r) => !q || r.name.toLowerCase().includes(q));
        const M = more;   // extra columns switched on?
        $('#t', view).innerHTML = `<tr><th><input type="checkbox" id="all" ${list.some((r) => !unticked.has(r.item_id)) ? 'checked' : ''} title="Tick / untick all"></th>
          <th>Medicine</th><th>Group</th>
          ${M ? '<th>Category</th><th>Manufacturer</th><th>Trend</th><th class="num">Per day</th><th class="num">Normal sale</th><th class="num">Weeks /13</th>' : ''}
          <th class="num">Min</th><th class="num">Max</th><th class="num">Stock</th><th class="num">On order</th><th class="num">Order Qty</th>
          ${canPlace ? '<th>Distributor</th>' : ''}
          ${M ? '<th class="num">Shelf days</th>' : ''}
          <th class="num">Sold 7d</th><th class="num">Sold 30d</th><th class="num">Sold 60d</th>${M ? '<th class="num">Sold 90d</th>' : ''}<th>Last sold</th></tr>` +
          shown.slice(0, SHOW).map((r) => `<tr data-id="${r.item_id}" class="${r.orderedToday ? 'ordered' : ''} ${unticked.has(r.item_id) ? 'off' : ''}">
            <td><input type="checkbox" class="tick" ${unticked.has(r.item_id) ? '' : 'checked'}></td>
            <td class="med ${r.bounced ? 'bounced' : ''}"><b>${esc(r.name)}</b> <span class="muted">${esc(r.pack_size)}</span>${extra.has(r.item_id) && !r.suggested ? ' <span class="pill">added</span>' : ''}
              ${r.warning ? ` <span class="pill warn">${esc(r.warning)}</span>` : ''}${todayNote(r)}
              ${r.odd_note && /check/i.test(r.odd_note) ? `<div class="small muted">${esc(r.odd_note)}</div>` : ''}</td>
            <td class="nowrap">${grpCell(r)}</td>
            ${M ? `<td class="small">${esc(r.category || '')}</td><td class="small">${esc(r.manufacturer || '')}</td><td class="small">${esc(r.speed || '')}</td><td class="num">${fmtNum(r.per_day, 2)}</td><td class="num">${fmtNum(r.normal_sale, 1)}</td><td class="num">${fmtNum(r.weeks_sold)}</td>` : ''}
            <td class="num">${fmtNum(r.min_stock)}</td><td class="num">${fmtNum(r.max_stock)}</td><td class="num">${stockCell(r)}</td>
            <td class="num">${r.open ? fmtNum(r.open, 2) : ''}</td>
            <td class="num"><input type="number" class="qty" min="0" step="1" value="${finalQty(r)}"></td>
            ${canPlace ? `<td><select class="dist ${distOf(r) ? '' : 'empty'}">${distOpts(distOf(r))}</select></td>` : ''}
            ${M ? `<td class="num">${r.shelfDays === null || r.shelfDays === 999 ? '—' : fmtNum(r.shelfDays)}</td>` : ''}
            <td class="num">${fmtNum(r.qty_7, 2)}</td><td class="num">${fmtNum(r.qty_30, 2)}</td><td class="num">${fmtNum(r.qty_60, 2)}</td>
            ${M ? `<td class="num">${fmtNum(r.qty_90, 2)}</td>` : ''}<td class="nowrap">${fmtDate(r.last_sold)}</td></tr>`).join('');
        $('#more', view).textContent = shown.length > SHOW ? `Showing ${SHOW} of ${fmtNum(shown.length)} — use search to find the rest; all ticked lines are included when you place the order.` : '';
        $$('input.qty', view).forEach((inp) => (inp.onchange = () => { qtyEdits.set(Number(inp.closest('tr').dataset.id), Math.max(Number(inp.value) || 0, 0)); summary(); }));
        $$('input.tick', view).forEach((cb) => (cb.onchange = () => {
          const id = Number(cb.closest('tr').dataset.id);
          if (cb.checked) { unticked.delete(id); userTicked.add(id); } else { unticked.add(id); userTicked.delete(id); }
          cb.closest('tr').classList.toggle('off', !cb.checked); summary();
        }));
        $$('select.dist', view).forEach((sel) => (sel.onchange = async () => {
          const id = Number(sel.closest('tr').dataset.id);
          if (sel.value === 'new') {
            const d = await addDistributor();
            if (!d) { sel.value = distOf(rows.find((r) => r.item_id === id)) || ''; return; }
            distChoice.set(id, d.id); paint(); summary(); return;
          }
          distChoice.set(id, sel.value ? Number(sel.value) : '');
          sel.classList.toggle('empty', !sel.value); summary();
        }));
        $('#all', view).onchange = (e) => {
          // "tick all" leaves out medicines already ordered today; tick those one by one
          list.forEach((r) => { if (!e.target.checked) unticked.add(r.item_id); else if (!r.orderedToday || userTicked.has(r.item_id)) unticked.delete(r.item_id); });
          paint(); summary();
        };
      };
      const chosen = () => list.filter((r) => !unticked.has(r.item_id) && finalQty(r) > 0);
      const byDistributor = () => {
        const groups = new Map();
        for (const r of chosen()) {
          const d = distOf(r) || '';
          if (!groups.has(d)) groups.set(d, []);
          groups.get(d).push(r);
        }
        return groups;
      };
      const summary = () => {
        const c = chosen();
        const g = byDistributor();
        const missing = (g.get('') || []).length;
        $('#sum', view).innerHTML = `<b>${fmtNum(c.length)}</b> medicines · <b>${fmtNum(c.reduce((a, r) => a + finalQty(r), 0))}</b> strips
          ${canPlace ? `· <b>${[...g.keys()].filter(Boolean).length}</b> distributor(s)${missing ? ` · <span class="warn-text">${missing} without distributor</span>` : ''}` : ''}`;
      };
      $('#q', view).oninput = paint;
      $$('#attrs select', view).forEach((sel) => (sel.onchange = () => { attr[sel.dataset.k] = sel.value; drawOrder(view); }));
      if ($('#clrA', view)) $('#clrA', view).onclick = () => { Object.keys(attr).forEach((k) => (attr[k] = '')); drawOrder(view); };
      $$('#grps .chip', view).forEach((b) => (b.onclick = () => {
        const g = b.dataset.g;
        if (!g) grpFilter.clear(); else grpFilter.has(g) ? grpFilter.delete(g) : grpFilter.add(g);
        drawOrder(view);
      }));
      $('#moreCols', view).onchange = (e) => {
        more = e.target.checked;
        try { localStorage.setItem('orderMoreCols', more ? '1' : ''); } catch { /* ignore */ }
        paint();
      };

      async function addDistributor() {
        const name = await promptBox({ title: 'Add distributor', label: 'Distributor name', ok: 'Add' });
        if (!name?.trim()) return null;
        try {
          const [d] = await sb.from('distributors').insert({ name: name.trim() }).select().then(check);
          dists.push(d); dists.sort((a, b) => a.name.localeCompare(b.name));
          return d;
        } catch (e) { toast(/duplicate/.test(e.message) ? 'That distributor already exists' : e.message, 'error'); return null; }
      }

      if (canPlace) {
        $('#distAll', view).onchange = async (e) => {
          let v = e.target.value;
          if (v === 'new') { const d = await addDistributor(); if (!d) { e.target.value = ''; return; } v = String(d.id); }
          if (!v) return;
          const c = chosen();
          c.forEach((r) => distChoice.set(r.item_id, Number(v)));
          toast(`${dists.find((d) => String(d.id) === v)?.name} set for ${c.length} ticked medicine(s)`);
          drawOrder(view);
        };
      }

      // add a medicine by hand
      let t;
      $('#addq', view).oninput = (e) => {
        clearTimeout(t);
        const q = e.target.value.trim();
        if (q.length < 2) { $('#addres', view).innerHTML = ''; return; }
        t = setTimeout(async () => {
          const found = await sb.from('items').select('id, name, pack_size').ilike('name', `%${q}%`).eq('status', 'active').order('name').limit(15).then(check);
          $('#addres', view).innerHTML = found.map((f) => `<button data-id="${f.id}">${esc(f.name)} <span class="muted">${esc(f.pack_size)}</span></button>`).join('') || '<div class="muted small">No match</div>';
          $$('#addres button', view).forEach((b) => (b.onclick = () => {
            const id = Number(b.dataset.id), f = found.find((x) => x.id === id);
            if (!rows.find((r) => r.item_id === id)) rows.push({ item_id: id, name: f.name, pack_size: f.pack_size, grp: 'Not sold', suggested: 0, closing: 0, open: 0 });
            extra.set(id, 1); unticked.delete(id);
            $('#addq', view).value = ''; $('#addres', view).innerHTML = '';
            drawOrder(view); toast(`${f.name} added`);
          }));
        }, 300);
      };

      const distName = (id) => dists.find((d) => String(d.id) === String(id))?.name || 'No distributor';
      const sheetFor = (when, dname, lines, no = '') => [[`${no ? `Order ${no}` : 'Order'} — ${warehouseName(whSel.value)} — ${when} — ${dname}`], [],
        ['Medicine Name', 'Pack Size', 'Qty (strips)'], ...lines.map((r) => [r.name, r.pack_size, finalQty(r)])];

      // Download without placing: one sheet per distributor
      $('#dl', view).onclick = () => {
        if (!chosen().length) return toast('Nothing ticked to order', 'error');
        const when = fmtDateTime(new Date());
        const sheets = {};
        for (const [d, lines] of byDistributor()) sheets[distName(d).slice(0, 31)] = sheetFor(when, distName(d), lines);
        downloadExcel(`Order ${warehouseName(whSel.value)} ${when.replace(/[,:]/g, '')}.xlsx`, sheets);
      };

      if (canPlace) {
        $('#place', view).onclick = async () => {
          const c = chosen();
          if (!c.length) return toast('Nothing ticked to order', 'error');
          const groups = byDistributor();
          if (groups.has('')) return toast(`Choose a distributor for ${groups.get('').length} medicine(s) — they are marked in orange`, 'error');
          const again = c.filter((r) => r.orderedToday);
          const ok = await confirmBox({
            title: 'Place these orders?',
            html: `<p><b>${fmtNum(c.length)}</b> medicines for <b>${esc(warehouseName(whSel.value))}</b>, split into <b>${groups.size}</b> order(s):</p>
                   <table class="tbl compact">${[...groups].map(([d, lines]) => `<tr><td>${esc(distName(d))}</td><td class="num">${lines.length} medicines</td>
                   <td class="num">${fmtNum(lines.reduce((a, r) => a + finalQty(r), 0))} strips</td></tr>`).join('')}</table>
                   ${again.length ? `<div class="note warn"><b>${again.length}</b> of these were already ordered today:
                     ${again.slice(0, 8).map((r) => esc(r.name)).join(', ')}${again.length > 8 ? '…' : ''}. Order them again?</div>` : ''}
                   <p class="muted small">Saved with your name and the time, so a later order today won't suggest the same medicines again.</p>`,
            ok: 'Place orders',
          });
          if (!ok) return;
          $('#place', view).disabled = true;
          try {
            const res = await sb.rpc('place_orders', {
              p_warehouse_id: Number(whSel.value), p_note: $('#note', view).value,
              p_lines: c.map((r) => ({ item_id: r.item_id, qty: finalQty(r), suggested: r.suggested || null, distributor_id: Number(distOf(r)) })),
            }).then(check);
            const when = fmtDateTime(new Date());
            const noOf = Object.fromEntries(res.map((x) => [String(x.distributor_id), x.order_no]));
            const placed = [...groups].map(([d, lines]) => ({ d, lines, no: noOf[String(d)] || '', sheet: sheetFor(when, distName(d), lines, noOf[String(d)]) }));
            extra.clear(); qtyEdits.clear(); unticked.clear(); userTicked.clear(); distChoice.clear();
            showPlaced(placed, when, res.length);
            load();
          } catch (e) { toast(e.message, 'error'); $('#place', view).disabled = false; }
        };
      }
      paint(); summary();
    }

    // after placing: one Excel per distributor, downloaded by button
    function showPlaced(placed, when, n) {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = `<div class="modal"><h3>${n} order(s) placed</h3>
        <p class="muted small">Download each distributor's Excel and send it to them.</p>
        <table class="tbl compact">${placed.map((p, i) => `<tr><td><b>${esc(p.no)}</b></td><td>${esc(distName0(p.d))}</td><td class="num">${p.lines.length} medicines</td>
          <td><button class="btn primary small" data-i="${i}">Download Excel</button></td></tr>`).join('')}</table>
        <div class="modal-actions"><button class="btn ghost" data-a="close">Done</button></div></div>`;
      document.body.appendChild(wrap);
      wrap.addEventListener('click', (e) => {
        const i = e.target.closest('[data-i]')?.dataset.i;
        if (i !== undefined) {
          const p = placed[Number(i)];
          downloadExcel(fileName(p.no, distName0(p.d)), { Order: p.sheet });
          e.target.textContent = 'Downloaded ✓';
        }
        if (e.target.closest('[data-a="close"]')) wrap.remove();
      });
    }
    const distName0 = (id) => dists.find((d) => String(d.id) === String(id))?.name || 'No distributor';

    // ---------------- Orders placed ----------------
    async function drawHistory(view) {
      view.innerHTML = '<div class="loading">Loading…</div>';
      const H = drawHistory.f || (drawHistory.f = { from: isoDaysAgo(14), to: todayISO(), status: 'all', dist: '', by: '', q: '' });
      const [orders, dl, people] = await Promise.all([
        sb.from('orders').select('*').eq('warehouse_id', Number(whSel.value))
          .gte('placed_at', `${H.from}T00:00:00+05:30`).lte('placed_at', `${H.to}T23:59:59+05:30`)
          .order('placed_at', { ascending: false }).limit(1000).then(check),
        sb.from('distributors').select('id, name').order('name').then(check),
        isRole('admin') ? sb.from('profiles').select('user_id, full_name').then(check) : Promise.resolve([]),
      ]);
      // bounced lines per order, for the status and the bounce report
      const ids = orders.map((o) => o.id);
      const lines = ids.length ? await fetchLines(ids) : [];
      const byOrder = new Map();
      lines.forEach((l) => { if (!byOrder.has(l.order_id)) byOrder.set(l.order_id, []); byOrder.get(l.order_id).push(l); });
      const bouncedLines = (o) => (byOrder.get(o.id) || []).filter((l) => l.bounced);

      const dn = Object.fromEntries(dl.map((d) => [d.id, d.name]));
      const pn = Object.fromEntries(people.map((p) => [p.user_id, p.full_name]));
      const nameOf = (o) => pn[o.placed_by] || (o.placed_by === state.profile.user_id ? state.profile.full_name : '');
      const status = (o) => o.cancelled_at ? '<span class="pill failed">Cancelled</span>'
        : o.received_at ? `<span class="pill done">Received</span>${o.received_source === 'purchase upload' ? '<div class="small muted">from purchase upload</div>' : ''}`
        : '<span class="pill running">On order</span>';
      const refs = (o) => o.invoice_no ? `<b>Inv ${esc(o.invoice_no)}</b><div class="small muted">${fmtDate(o.invoice_date)}${o.challan_no ? ` · Challan ${esc(o.challan_no)}` : ''}</div>`
        : o.challan_no ? `Challan ${esc(o.challan_no)}<div class="small warn-text">Invoice pending</div>` : '<span class="small warn-text">No invoice / challan yet</span>';
      const canRefs = isRole('admin', 'purchase');
      const byIds = [...new Set(orders.map((o) => o.placed_by))];

      view.innerHTML = `
        <div class="filters">
          <input type="search" id="hq" placeholder="Order no. / invoice / challan…" value="${esc(H.q)}">
          <select id="hs">
            ${[['all', 'All statuses'], ['open', 'On order'], ['received', 'Received'], ['cancelled', 'Cancelled'], ['pending', 'Invoice pending'], ['bounce', 'Has bounces']]
              .map(([v, l]) => `<option value="${v}" ${H.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <select id="hd"><option value="">All distributors</option>${dl.map((d) => `<option value="${d.id}" ${String(H.dist) === String(d.id) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
          <select id="hb"><option value="">Placed by anyone</option>${byIds.map((u) => `<option value="${u}" ${H.by === u ? 'selected' : ''}>${esc(pn[u] || (u === state.profile.user_id ? state.profile.full_name : 'Team member'))}</option>`).join('')}</select>
          <label class="small">From <input type="date" id="hf" value="${H.from}"></label>
          <label class="small">To <input type="date" id="ht" value="${H.to}"></label>
          <button class="btn ghost small" id="brep">Bounce report</button>
        </div>
        <p class="muted small">Orders count as "on order" for ${cfg.order_open_days || 2} day(s), or until received.</p>
        <div id="hl"></div><div id="lines"></div>`;

      const shown = () => orders.filter((o) => {
        const q = H.q.trim().toLowerCase();
        if (q && ![o.order_no, o.invoice_no, o.challan_no].some((x) => (x || '').toLowerCase().includes(q))) return false;
        if (H.dist && String(o.distributor_id) !== String(H.dist)) return false;
        if (H.by && o.placed_by !== H.by) return false;
        switch (H.status) {
          case 'open': return !o.cancelled_at && !o.received_at;
          case 'received': return !!o.received_at && !o.cancelled_at;
          case 'cancelled': return !!o.cancelled_at;
          case 'pending': return !o.cancelled_at && !o.invoice_no;
          case 'bounce': return bouncedLines(o).length > 0;
          default: return true;
        }
      });
      const paint = () => {
        const list = shown();
        $('#hl', view).innerHTML = list.length ? `<div class="scroll"><table class="tbl">
          <tr><th>Order no.</th><th>Placed</th><th>By</th><th>Distributor</th><th class="num">Medicines</th><th class="num">Strips</th><th>Challan / Invoice</th><th>Status</th><th></th></tr>
          ${list.map((o) => {
            const bl = bouncedLines(o);
            return `<tr data-id="${o.id}"><td class="nowrap"><b>${esc(o.order_no || '')}</b>${o.note ? `<div class="small muted">${esc(o.note)}</div>` : ''}</td>
            <td class="nowrap">${fmtDateTime(o.placed_at)}</td><td>${esc(nameOf(o))}</td><td><b>${esc(dn[o.distributor_id] || '—')}</b></td>
            <td class="num">${fmtNum(o.lines)}</td><td class="num">${fmtNum(o.total_qty, 2)}</td><td>${refs(o)}</td>
            <td>${status(o)}${bl.length ? `<div class="small bounce-text">${bl.length} bounced</div>` : ''}</td>
            <td class="nowrap"><button class="btn ghost small view">Lines</button>
            ${canRefs && !o.cancelled_at ? `<button class="btn ghost small refs">${o.invoice_no || o.challan_no ? 'Edit invoice' : 'Add challan / invoice'}</button>` : ''}
            ${!o.cancelled_at ? `<button class="btn ghost small recv">${o.received_at ? 'Edit received' : 'Receive'}</button>` : ''}
            ${!o.cancelled_at && !o.received_at ? '<button class="btn ghost small canc">Cancel</button>' : ''}</td></tr>`;
          }).join('')}
          </table></div><p class="muted small">${fmtNum(list.length)} order(s)</p>` : '<p class="muted">No orders match.</p>';
        wire();
      };
      const reload = () => drawHistory(view);
      $('#hq', view).oninput = (e) => { H.q = e.target.value; paint(); };
      $('#hs', view).onchange = (e) => { H.status = e.target.value; paint(); };
      $('#hd', view).onchange = (e) => { H.dist = e.target.value; paint(); };
      $('#hb', view).onchange = (e) => { H.by = e.target.value; paint(); };
      $('#hf', view).onchange = (e) => { H.from = e.target.value || isoDaysAgo(14); reload(); };
      $('#ht', view).onchange = (e) => { H.to = e.target.value || todayISO(); reload(); };
      $('#brep', view).onclick = () => bounceReport();

      const orderOf = (b) => orders.find((x) => String(x.id) === b.closest('tr').dataset.id);
      function wire() {
        $$('button.view', view).forEach((b) => (b.onclick = () => showLines(orderOf(b))));
        $$('button.refs', view).forEach((b) => (b.onclick = () => editRefs(orderOf(b))));
        $$('button.recv', view).forEach((b) => (b.onclick = () => receive(orderOf(b))));
        $$('button.canc', view).forEach((b) => (b.onclick = async () => {
          if (!(await confirmBox({ title: 'Cancel this order?', html: '<p>Its medicines will no longer count as on order.</p>', ok: 'Cancel order', cancel: 'Keep', danger: true }))) return;
          await sb.rpc('set_order_status', { p_order_id: Number(b.closest('tr').dataset.id), p_status: 'cancelled' }).then(check);
          toast('Order cancelled'); afterChange();
        }));
      }
      const afterChange = () => load().then(() => { tab = 'history'; draw(); });

      const titleOf = (o) => `Order ${o.order_no || ''} — ${warehouseName(whSel.value)} — ${fmtDateTime(o.placed_at)} — ${dn[o.distributor_id] || ''}${o.invoice_no ? ` — Invoice ${o.invoice_no}` : o.challan_no ? ` — Challan ${o.challan_no}` : ''}`;
      async function showLines(o) {
        const ls = byOrder.get(o.id) || [];
        const levels = await groupsFor(ls.map((l) => l.item_id));
        let g = '';
        const paintLines = () => {
          const sl = ls.filter((l) => !g || grpKey(levels[l.item_id] || '') === g);
          $('#ltab', view).innerHTML = `<tr><th>Medicine</th><th>Pack</th><th>Group</th><th class="num">Ordered</th><th class="num">Supplied</th><th class="num">Suggested</th></tr>
            ${sl.map((l) => `<tr class="${l.bounced ? 'bounced-row' : ''}"><td>${esc(l.name)}</td><td>${esc(l.pack_size)}</td><td>${esc(levels[l.item_id] || '')}</td>
              <td class="num">${fmtNum(l.qty, 2)}</td><td class="num">${l.supplied_qty == null ? '—' : fmtNum(l.supplied_qty, 2)}${l.bounced ? ' <span class="pill failed">bounced</span>' : ''}</td>
              <td class="num">${fmtNum(l.suggested_qty, 2)}</td></tr>`).join('')}`;
        };
        const gs = [...new Set(ls.map((l) => grpKey(levels[l.item_id] || '')))];
        $('#lines', view).innerHTML = `<h3>${esc(titleOf(o))}</h3>
          <div class="row"><select id="lg"><option value="">All groups</option>${gs.map((x) => `<option>${esc(x)}</option>`).join('')}</select>
          <button class="btn ghost small" id="dlo">Download Excel</button></div><table class="tbl compact" id="ltab"></table>`;
        $('#lg', view).onchange = (e) => { g = e.target.value; paintLines(); };
        $('#dlo', view).onclick = () => downloadExcel(fileName(o.order_no, dn[o.distributor_id]),
          { Order: [[titleOf(o)], [], ['Medicine Name', 'Pack Size', 'Qty (strips)', 'Supplied'], ...ls.map((l) => [l.name, l.pack_size, Number(l.qty), l.supplied_qty == null ? '' : Number(l.supplied_qty)])] });
        paintLines();
        $('#lines', view).scrollIntoView({ behavior: 'smooth' });
      }

      // Receive: supplied quantity per line; 0 = bounced
      function receive(o) {
        const ls = byOrder.get(o.id) || [];
        const wrap = document.createElement('div');
        wrap.className = 'modal-wrap';
        wrap.innerHTML = `<form class="modal wide"><h3>Receive ${esc(o.order_no || '')} — ${esc(dn[o.distributor_id] || '')}</h3>
          <p class="muted small">Change <b>Supplied</b> for anything that didn't come in full. Tick <b>Bounced</b> if it didn't come at all.
            Bounced medicines go straight back on the Order Sheet so you can order them from another distributor.</p>
          <div class="scroll modal-scroll"><table class="tbl compact"><tr><th>Medicine</th><th class="num">Ordered</th><th class="num">Supplied</th><th>Bounced</th></tr>
          ${ls.map((l) => `<tr data-i="${l.item_id}"><td>${esc(l.name)} <span class="muted">${esc(l.pack_size)}</span></td><td class="num">${fmtNum(l.qty, 2)}</td>
            <td class="num"><input type="number" class="sup" min="0" max="${l.qty}" step="any" value="${l.supplied_qty == null ? Number(l.qty) : Number(l.supplied_qty)}"></td>
            <td><input type="checkbox" class="bnc" ${l.supplied_qty != null && Number(l.supplied_qty) === 0 ? 'checked' : ''}></td></tr>`).join('')}</table></div>
          <div class="modal-actions"><button type="button" class="btn ghost" data-a="no">Cancel</button><button class="btn primary">Save — received</button></div></form>`;
        document.body.appendChild(wrap);
        $$('input.bnc', wrap).forEach((cb) => (cb.onchange = () => {
          const tr = cb.closest('tr'), inp = $('input.sup', tr);
          inp.value = cb.checked ? 0 : (ls.find((l) => String(l.item_id) === tr.dataset.i)?.qty || 0);
        }));
        $$('input.sup', wrap).forEach((inp) => (inp.oninput = () => { $('input.bnc', inp.closest('tr')).checked = Number(inp.value) === 0; }));
        $('[data-a="no"]', wrap).onclick = () => wrap.remove();
        $('form', wrap).onsubmit = async (e) => {
          e.preventDefault();
          const payload = $$('tr[data-i]', wrap).map((tr) => ({ item_id: Number(tr.dataset.i), supplied: Math.max(Number($('input.sup', tr).value) || 0, 0) }));
          try {
            await sb.rpc('receive_order', { p_order_id: o.id, p_lines: payload, p_source: 'manual' }).then(check);
            const b = payload.filter((p) => p.supplied < Number(ls.find((l) => l.item_id === p.item_id)?.qty || 0)).length;
            wrap.remove(); toast(b ? `Received. ${b} line(s) bounced or short — they are back on the Order Sheet.` : 'Received');
            afterChange();
          } catch (err) { toast(err.message, 'error'); }
        };
      }

      function editRefs(o) {
        const wrap = document.createElement('div');
        wrap.className = 'modal-wrap';
        wrap.innerHTML = `<form class="modal"><h3>Challan / Invoice — ${esc(o.order_no || '')}</h3>
          <p class="muted small">${esc(dn[o.distributor_id] || '')}, ${fmtDateTime(o.placed_at)}, ${fmtNum(o.lines)} medicines. Enter the challan no. now if the invoice isn't ready; add the invoice no. later.
            When the purchase file with this bill no. is uploaded, the order is received automatically and anything missing from the bill is marked bounced.</p>
          <label class="field"><span>Challan no.</span><input name="c" value="${esc(o.challan_no || '')}" autocomplete="off"></label>
          <label class="field"><span>Invoice no.</span><input name="i" value="${esc(o.invoice_no || '')}" autocomplete="off"></label>
          <label class="field"><span>Invoice date</span><input name="d" type="date" value="${o.invoice_date || todayISO()}"></label>
          <div class="modal-actions"><button type="button" class="btn ghost" data-a="no">Cancel</button><button class="btn primary">Save</button></div></form>`;
        document.body.appendChild(wrap);
        const f = $('form', wrap);
        f.c.focus();
        $('[data-a="no"]', wrap).onclick = () => wrap.remove();
        f.onsubmit = async (e) => {
          e.preventDefault();
          try {
            await sb.rpc('set_order_refs', { p_order_id: o.id, p_challan: f.c.value, p_invoice: f.i.value, p_invoice_date: f.i.value.trim() ? f.d.value : null }).then(check);
            Object.assign(o, { challan_no: f.c.value.trim() || null, invoice_no: f.i.value.trim() || null, invoice_date: f.i.value.trim() ? f.d.value : null });
            wrap.remove(); toast('Saved'); paint();
          } catch (err) { toast(err.message, 'error'); }
        };
      }

      // Bounces per distributor for the chosen dates
      function bounceReport() {
        const stats = new Map();
        for (const o of orders) {
          if (o.cancelled_at || !o.received_at) continue;
          const s = stats.get(o.distributor_id) || { orders: 0, lines: 0, strips: 0, bLines: 0, bStrips: 0 };
          const ls = byOrder.get(o.id) || [];
          s.orders++; s.lines += ls.length;
          ls.forEach((l) => { s.strips += Number(l.qty); if (l.bounced) { s.bLines++; s.bStrips += Number(l.qty) - Number(l.supplied_qty || 0); } });
          stats.set(o.distributor_id, s);
        }
        const rowsB = [...stats].map(([d, s]) => ({ d, ...s, pct: s.lines ? (100 * s.bLines) / s.lines : 0 })).sort((a, b) => b.pct - a.pct);
        $('#lines', view).innerHTML = `<h3>Bounce report — ${fmtDate(H.from)} to ${fmtDate(H.to)} (received orders)</h3>
          ${rowsB.length ? `<table class="tbl compact"><tr><th>Distributor</th><th class="num">Orders</th><th class="num">Lines</th><th class="num">Bounced lines</th><th class="num">Bounce %</th><th class="num">Strips not supplied</th></tr>
          ${rowsB.map((r) => `<tr><td>${esc(dn[r.d] || '—')}</td><td class="num">${r.orders}</td><td class="num">${r.lines}</td><td class="num">${r.bLines}</td>
            <td class="num"><b class="${r.pct >= 10 ? 'bounce-text' : ''}">${r.pct.toFixed(1)}%</b></td><td class="num">${fmtNum(r.bStrips, 2)}</td></tr>`).join('')}</table>`
          : '<p class="muted">No received orders in these dates.</p>'}`;
        $('#lines', view).scrollIntoView({ behavior: 'smooth' });
      }
      paint();
    }

    async function fetchLines(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 150) {
        const part = await sb.from('order_lines').select('order_id, item_id, qty, suggested_qty, supplied_qty, bounced').in('order_id', ids.slice(i, i + 150)).then(check);
        out.push(...part);
      }
      const itemIds = [...new Set(out.map((l) => l.item_id))];
      const names = {};
      for (let i = 0; i < itemIds.length; i += 300) {
        const it = await sb.from('items').select('id, name, pack_size').in('id', itemIds.slice(i, i + 300)).then(check);
        it.forEach((x) => (names[x.id] = x));
      }
      return out.map((l) => ({ ...l, name: names[l.item_id]?.name || '', pack_size: names[l.item_id]?.pack_size || '' }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    async function groupsFor(itemIds) {
      const g = {};
      for (let i = 0; i < itemIds.length; i += 300) {
        const lv = await sb.from('item_levels').select('item_id, grp').eq('warehouse_id', Number(whSel.value)).in('item_id', itemIds.slice(i, i + 300)).then(check);
        lv.forEach((x) => (g[x.item_id] = x.grp));
      }
      return g;
    }

    await load();
  },
};

// "GC-201126-03 M-s Jai Medical Agency.xlsx"
function fileName(no, dist) {
  return `${no || 'Order'} ${String(dist || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()}.xlsx`;
}

// why a medicine from the stock upload is not on the Order Sheet
function reason(r) {
  if (r.disc) return 'Discontinued (Duplicate Items list) — not ordered';
  if (r.closing === null) return 'No loose-to-strip conversion — fix in Item master';
  if (!r.can_order) return r.why || 'No sales in the last year';
  if (r.open > 0 && r.closing + r.open >= r.min_stock) return `Already on order (${r.open})`;
  if (r.recv > 0 && r.counted < r.min_stock) return `Received after the stock count (+${r.recv}) — now ${r.closing} ≥ Min ${r.min_stock}`;
  return `Enough stock (${r.closing} ≥ Min ${r.min_stock})`;
}
function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function reasonOrder(r) {
  const t = reason(r);
  return t.startsWith('No loose') ? 0 : t.startsWith('Already') ? 1 : t.startsWith('Enough') ? 2 : 3;
}

// strip HTML for the Excel download
function plain(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  const t = d.textContent.trim();
  const n = Number(t.replace(/,/g, ''));
  return t !== '' && isFinite(n) && /^[\d,.\-]+$/.test(t) ? n : t;
}
