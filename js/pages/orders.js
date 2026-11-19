import { sb, check, state, rememberWarehouse, warehouseName, isRole } from '../db.js';
import { esc, $, $$, fmtDate, fmtDateTime, fmtNum, toast, confirmBox, promptBox, warehouseOptions, downloadExcel } from '../ui.js';
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
    const qtyEdits = new Map(), unticked = new Set();
    let more = false;
    try { more = localStorage.getItem('orderMoreCols') === '1'; } catch { /* ignore */ }

    whSel.onchange = () => { rememberWarehouse(whSel.value); extra.clear(); qtyEdits.clear(); unticked.clear(); load(); };
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
      stockAt = up[0]?.created_at || null;
      const stockFile = up[0]?.file_name || '';
      rows = sheet.map((r) => {
        const closing = r.closing === null ? (r.stock_flag === 'No conversion' ? null : 0) : Number(r.closing);
        const open = Number(r.open_qty || 0);
        const level = { can_order: r.can_order, min_stock: r.min_stock, max_stock: r.max_stock, grp: r.grp };
        return {
          ...r, closing, open,
          suggested: closing === null ? 0 : orderQty(level, closing, open, cfg),
          shelfDays: closing === null ? null : daysOnShelf(closing, Number(r.per_day || 0)),
          orderedToday: Number(r.today_qty || 0) > 0,
        };
      });

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
      if (noConv) alerts.push(`<b>${noConv}</b> medicine(s) have stock but no loose-to-strip conversion, so they are left out of the order. ${isRole('admin') ? '<a href="#/items">Fix in Item master</a>' : 'Ask the Admin to fix them in Item master.'}`);
      $('#alerts', el).innerHTML = alerts.map((a) => `<div class="note ${a.startsWith('<span class="info">') && !a.includes('not from today') ? '' : 'warn'}">${a}</div>`).join('');
      draw();
    }

    // ------------------------------------------------------------------
    const pick = {
      order: () => rows.filter((r) => r.suggested > 0 || extra.has(r.item_id))
        .sort((a, b) => (GROUP_ORDER[a.grp] ?? 9) - (GROUP_ORDER[b.grp] ?? 9) || (b.qty_30 || 0) - (a.qty_30 || 0)),
      decide: () => rows.filter((r) => r.grp === 'New' && !r.can_order && /decide by hand/.test(r.why || ''))
        .sort((a, b) => (a.days_since ?? 999) - (b.days_since ?? 999)),
      over: () => rows.filter((r) => r.closing > 0 && r.shelfDays > (cfg.expiry_warning_days || 60))
        .sort((a, b) => b.shelfDays - a.shelfDays),
      notorder: () => rows.filter((r) => !r.can_order && !/decide by hand/.test(r.why || ''))
        .sort((a, b) => (a.days_since ?? 9999) - (b.days_since ?? 9999)),
      slow: () => rows.filter((r) => (r.grp || '').startsWith('Slow')).sort((a, b) => (b.qty_90 || 0) - (a.qty_90 || 0)),
      checked: () => rows.filter((r) => !(r.suggested > 0) && !extra.has(r.item_id))
        .sort((a, b) => reasonOrder(a) - reasonOrder(b) || a.name.localeCompare(b.name)),
    };

    const grpCell = (r) => `${esc(r.grp)}${r.growing ? ' <span class="pill done">Growing</span>' : ''}`;
    const todayNote = (r) => r.orderedToday
      ? `<div class="today-note">Ordered today ${fmtDateTime(r.last_order_at).split(', ')[1] || ''} – ${fmtNum(r.today_qty, 2)} strips${r.last_order_by ? ` (${esc(r.last_order_by)})` : ''}${r.last_order_distributor ? `, ${esc(r.last_order_distributor)}` : ''}</div>` : '';
    const stockCell = (r) => r.closing === null ? '<span class="pill warn">No conversion</span>' : fmtNum(r.closing, 2);

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
        notorder: [['Medicine', (r) => esc(r.name)], ['Pack', (r) => esc(r.pack_size)], ['Why', (r) => esc(r.why || 'Not sold in the last year')],
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
      const list = pick.order();
      const leftOut = rows.filter((r) => r.orderedToday && r.suggested === 0 && !extra.has(r.item_id));
      const dists = await sb.from('distributors').select('id, name').eq('active', true).order('name').then(check);
      view.innerHTML = `
        <div class="row">
          <input type="search" id="q" placeholder="Search in this list…">
          <div class="add-box"><input type="search" id="addq" placeholder="+ Add another medicine…" autocomplete="off"><div id="addres" class="add-res"></div></div>
          <label class="switch"><input type="checkbox" id="moreCols" ${more ? 'checked' : ''}> Show more columns</label>
        </div>
        ${leftOut.length ? `<details class="note"><summary><b>${leftOut.length}</b> medicine(s) were ordered earlier today and are already covered — not suggested again</summary>
          <table class="tbl compact">${leftOut.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.pack_size)}</td><td>${todayNote(r)}</td></tr>`).join('')}</table></details>` : ''}
        <div class="scroll"><table class="tbl order" id="t"></table></div>
        <p class="muted small" id="more"></p>
        <div class="order-bar">
          <div id="sum"></div>
          ${canPlace ? `
          <select id="dist"><option value="">Distributor…</option>${dists.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}<option value="new">+ Add distributor…</option></select>
          <input id="note" placeholder="Note (optional)">
          <button class="btn primary" id="place">Place order</button>` : '<span class="muted small">Only Admin or Purchase Team can place orders.</span>'}
          <button class="btn ghost" id="dl">Download Excel</button>
        </div>`;

      const paint = () => {
        const q = $('#q', view).value.trim().toLowerCase();
        const shown = list.filter((r) => !q || r.name.toLowerCase().includes(q));
        const M = more;   // extra columns switched on?
        $('#t', view).innerHTML = `<tr><th><input type="checkbox" id="all" ${list.some((r) => !unticked.has(r.item_id)) ? 'checked' : ''} title="Tick / untick all"></th>
          <th>Medicine</th><th>Group</th>
          ${M ? '<th>Trend</th><th class="num">Strips /day</th><th class="num">Normal sale</th><th class="num">Weeks (of 13)</th>' : ''}
          <th class="num">Min</th><th class="num">Max</th><th class="num">Stock</th><th class="num">On order</th><th class="num">Order Qty</th>
          ${M ? '<th class="num">Days on shelf</th>' : ''}
          <th class="num">Sold 30d</th>${M ? '<th class="num">Sold 90d</th>' : ''}<th>Last sold</th></tr>` +
          shown.slice(0, SHOW).map((r) => `<tr data-id="${r.item_id}" class="${r.orderedToday ? 'ordered' : ''} ${unticked.has(r.item_id) ? 'off' : ''}">
            <td><input type="checkbox" class="tick" ${unticked.has(r.item_id) ? '' : 'checked'}></td>
            <td class="med"><b>${esc(r.name)}</b> <span class="muted">${esc(r.pack_size)}</span>${extra.has(r.item_id) && !r.suggested ? ' <span class="pill">added</span>' : ''}
              ${r.warning ? ` <span class="pill warn">${esc(r.warning)}</span>` : ''}${todayNote(r)}
              ${r.odd_note && /check/i.test(r.odd_note) ? `<div class="small muted">${esc(r.odd_note)}</div>` : ''}</td>
            <td>${grpCell(r)}</td>
            ${M ? `<td class="small">${esc(r.speed || '')}</td><td class="num">${fmtNum(r.per_day, 2)}</td><td class="num">${fmtNum(r.normal_sale, 1)}</td><td class="num">${fmtNum(r.weeks_sold)}</td>` : ''}
            <td class="num">${fmtNum(r.min_stock)}</td><td class="num">${fmtNum(r.max_stock)}</td><td class="num">${stockCell(r)}</td>
            <td class="num">${r.open ? fmtNum(r.open, 2) : ''}</td>
            <td class="num"><input type="number" class="qty" min="0" step="1" value="${finalQty(r)}"></td>
            ${M ? `<td class="num">${r.shelfDays === null || r.shelfDays === 999 ? '—' : fmtNum(r.shelfDays)}</td>` : ''}
            <td class="num">${fmtNum(r.qty_30, 2)}</td>${M ? `<td class="num">${fmtNum(r.qty_90, 2)}</td>` : ''}<td class="nowrap">${fmtDate(r.last_sold)}</td></tr>`).join('');
        $('#more', view).textContent = shown.length > SHOW ? `Showing ${SHOW} of ${fmtNum(shown.length)} — use search to find the rest; all ticked lines are included when you place the order.` : '';
        $$('input.qty', view).forEach((inp) => (inp.onchange = () => { qtyEdits.set(Number(inp.closest('tr').dataset.id), Math.max(Number(inp.value) || 0, 0)); summary(); }));
        $$('input.tick', view).forEach((cb) => (cb.onchange = () => {
          const id = Number(cb.closest('tr').dataset.id);
          cb.checked ? unticked.delete(id) : unticked.add(id);
          cb.closest('tr').classList.toggle('off', !cb.checked); summary();
        }));
        $('#all', view).onchange = (e) => { list.forEach((r) => (e.target.checked ? unticked.delete(r.item_id) : unticked.add(r.item_id))); paint(); summary(); };
      };
      const chosen = () => list.filter((r) => !unticked.has(r.item_id) && finalQty(r) > 0);
      const summary = () => {
        const c = chosen();
        $('#sum', view).innerHTML = `<b>${fmtNum(c.length)}</b> medicines · <b>${fmtNum(c.reduce((a, r) => a + finalQty(r), 0))}</b> strips`;
      };
      $('#q', view).oninput = paint;
      $('#moreCols', view).onchange = (e) => {
        more = e.target.checked;
        try { localStorage.setItem('orderMoreCols', more ? '1' : ''); } catch { /* ignore */ }
        paint();
      };

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

      const toExcel = (when, distName) => downloadExcel(
        `Order ${warehouseName(whSel.value)} ${when.replace(/[,:]/g, '')}.xlsx`,
        { Order: [[`Order — ${warehouseName(whSel.value)} — ${when}${distName ? ` — ${distName}` : ''}`], [],
          ['Medicine Name', 'Pack Size', 'Qty (strips)'],
          ...chosen().map((r) => [r.name, r.pack_size, finalQty(r)])] });

      $('#dl', view).onclick = () => { if (!chosen().length) return toast('Nothing ticked to order', 'error'); toExcel(fmtDateTime(new Date())); };

      if (canPlace) {
        const dist = $('#dist', view);
        dist.onchange = async () => {
          if (dist.value !== 'new') return;
          const name = await promptBox({ title: 'Add distributor', label: 'Distributor name', ok: 'Add' });
          if (!name?.trim()) { dist.value = ''; return; }
          try {
            const [d] = await sb.from('distributors').insert({ name: name.trim() }).select().then(check);
            dist.querySelector('option[value="new"]').insertAdjacentHTML('beforebegin', `<option value="${d.id}">${esc(d.name)}</option>`);
            dist.value = String(d.id);
          } catch (e) { toast(/duplicate/.test(e.message) ? 'That distributor already exists' : e.message, 'error'); dist.value = ''; }
        };
        $('#place', view).onclick = async () => {
          const c = chosen();
          if (!c.length) return toast('Nothing ticked to order', 'error');
          const distName = dist.value ? dist.options[dist.selectedIndex].text : '';
          const ok = await confirmBox({
            title: 'Place this order?',
            html: `<p><b>${fmtNum(c.length)}</b> medicines, <b>${fmtNum(c.reduce((a, r) => a + finalQty(r), 0))}</b> strips for</p>
                   <p class="big-name">${esc(warehouseName(whSel.value))}</p>
                   <p>${distName ? `Distributor: <b>${esc(distName)}</b>` : '<span class="muted">No distributor chosen.</span>'}</p>
                   <p class="muted small">It is saved with your name and the time, so a later order today won't suggest the same medicines again. The Excel downloads straight after.</p>`,
            ok: 'Place order',
          });
          if (!ok) return;
          $('#place', view).disabled = true;
          try {
            await sb.rpc('place_order', {
              p_warehouse_id: Number(whSel.value), p_distributor_id: dist.value ? Number(dist.value) : null,
              p_note: $('#note', view).value, p_lines: c.map((r) => ({ item_id: r.item_id, qty: finalQty(r), suggested: r.suggested || null })),
            }).then(check);
            toExcel(fmtDateTime(new Date()), distName);
            toast('Order placed');
            extra.clear(); qtyEdits.clear(); unticked.clear();
            load();
          } catch (e) { toast(e.message, 'error'); $('#place', view).disabled = false; }
        };
      }
      paint(); summary();
    }

    // ---------------- Orders placed ----------------
    async function drawHistory(view) {
      view.innerHTML = '<div class="loading">Loading…</div>';
      const since = new Date(Date.now() - 14 * 86400000).toISOString();
      const [orders, dists, people] = await Promise.all([
        sb.from('orders').select('*').eq('warehouse_id', Number(whSel.value)).gte('placed_at', since).order('placed_at', { ascending: false }).limit(100).then(check),
        sb.from('distributors').select('id, name').then(check),
        isRole('admin') ? sb.from('profiles').select('user_id, full_name').then(check) : Promise.resolve([]),
      ]);
      const dn = Object.fromEntries(dists.map((d) => [d.id, d.name]));
      const pn = Object.fromEntries(people.map((p) => [p.user_id, p.full_name]));
      const nameOf = (o) => pn[o.placed_by] || (o.placed_by === state.profile.user_id ? state.profile.full_name : '');
      const status = (o) => o.cancelled_at ? '<span class="pill failed">Cancelled</span>' : o.received_at ? '<span class="pill done">Received</span>'
        : `<span class="pill running">On order</span>`;
      view.innerHTML = `<p class="muted small">Orders count as "on order" for ${cfg.order_open_days || 2} day(s), or until marked received. Last 14 days shown.</p>
        ${orders.length ? `<div class="scroll"><table class="tbl">
        <tr><th>Placed</th><th>By</th><th>Distributor</th><th class="num">Medicines</th><th class="num">Strips</th><th>Note</th><th>Status</th><th></th></tr>
        ${orders.map((o) => `<tr data-id="${o.id}"><td>${fmtDateTime(o.placed_at)}</td><td>${esc(nameOf(o))}</td><td>${esc(dn[o.distributor_id] || '—')}</td>
          <td class="num">${fmtNum(o.lines)}</td><td class="num">${fmtNum(o.total_qty, 2)}</td><td>${esc(o.note || '')}</td><td>${status(o)}</td>
          <td class="nowrap"><button class="btn ghost small view">Lines</button>
          ${!o.cancelled_at && !o.received_at && isRole('admin', 'purchase', 'manager') ? '<button class="btn ghost small recv">Mark received</button><button class="btn ghost small canc">Cancel</button>' : ''}</td></tr>`).join('')}
        </table></div>` : '<p class="muted">No orders in the last 14 days.</p>'}
        <div id="lines"></div>`;
      const lines = async (id) => {
        const ls = await sb.from('order_lines').select('item_id, qty, suggested_qty, items(name, pack_size)').eq('order_id', id).then(check)
          .catch(async () => {
            const l = await sb.from('order_lines').select('item_id, qty, suggested_qty').eq('order_id', id).then(check);
            const it = await sb.from('items').select('id, name, pack_size').in('id', l.map((x) => x.item_id)).then(check);
            const m = Object.fromEntries(it.map((i) => [i.id, i]));
            return l.map((x) => ({ ...x, items: m[x.item_id] }));
          });
        return ls;
      };
      $$('button.view', view).forEach((b) => (b.onclick = async () => {
        const o = orders.find((x) => String(x.id) === b.closest('tr').dataset.id);
        const ls = await lines(o.id);
        $('#lines', view).innerHTML = `<h3>Order of ${fmtDateTime(o.placed_at)}</h3>
          <div class="row"><button class="btn ghost small" id="dlo">Download Excel</button></div>
          <table class="tbl compact"><tr><th>Medicine</th><th>Pack</th><th class="num">Qty</th><th class="num">Suggested</th></tr>
          ${ls.map((l) => `<tr><td>${esc(l.items?.name)}</td><td>${esc(l.items?.pack_size)}</td><td class="num">${fmtNum(l.qty, 2)}</td><td class="num">${fmtNum(l.suggested_qty, 2)}</td></tr>`).join('')}</table>`;
        $('#dlo', view).onclick = () => downloadExcel(`Order ${warehouseName(whSel.value)} ${fmtDateTime(o.placed_at).replace(/[,:]/g, '')}.xlsx`,
          { Order: [[`Order — ${warehouseName(whSel.value)} — ${fmtDateTime(o.placed_at)}${dn[o.distributor_id] ? ` — ${dn[o.distributor_id]}` : ''}`], [],
            ['Medicine Name', 'Pack Size', 'Qty (strips)'], ...ls.map((l) => [l.items?.name, l.items?.pack_size, Number(l.qty)])] });
        $('#lines', view).scrollIntoView({ behavior: 'smooth' });
      }));
      const setStatus = async (b, s, msg) => {
        if (s === 'cancelled' && !(await confirmBox({ title: 'Cancel this order?', html: '<p>Its medicines will no longer count as on order.</p>', ok: 'Cancel order', cancel: 'Keep', danger: true }))) return;
        await sb.rpc('set_order_status', { p_order_id: Number(b.closest('tr').dataset.id), p_status: s }).then(check);
        toast(msg); load().then(() => { tab = 'history'; draw(); });
      };
      $$('button.recv', view).forEach((b) => (b.onclick = () => setStatus(b, 'received', 'Marked received')));
      $$('button.canc', view).forEach((b) => (b.onclick = () => setStatus(b, 'cancelled', 'Order cancelled')));
    }

    await load();
  },
};

// why a medicine from the stock upload is not on the Order Sheet
function reason(r) {
  if (r.closing === null) return 'No loose-to-strip conversion — fix in Item master';
  if (!r.can_order) return r.why || 'No sales in the last year';
  if (r.open > 0 && r.closing + r.open >= r.min_stock) return `Already on order (${r.open})`;
  return `Enough stock (${r.closing} ≥ Min ${r.min_stock})`;
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
