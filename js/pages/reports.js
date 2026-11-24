import { sb, check, state, rememberWarehouse, warehouseName } from '../db.js';
import { esc, $, $$, fmtDate, fmtNum, warehouseOptions, downloadExcel, todayISO, addDays } from '../ui.js';
import { drawTat } from '../tat.js';

const BY = [['category', 'Category'], ['ailment', 'Type of Ailment'], ['manufacturer', 'Manufacturer'], ['brand', 'Brand']];
const TABS = [['summary', 'Summary'], ['buysell', 'Buying vs Selling'], ['movers', 'Rising & Falling'], ['hourly', 'Hourly sales'], ['tat', 'Turn Around Time']];
const OVERBUY = 1.2;   // bought more than 120% of what was sold = flag

const pct = (now, prev) => (prev > 0 ? ((now - prev) / prev) * 100 : now > 0 ? null : 0);
const growthCell = (now, prev) => {
  const g = pct(now, prev);
  if (g === null) return '<span class="up">new</span>';
  if (Math.abs(g) < 0.5) return '<span class="muted">0%</span>';
  return `<span class="${g > 0 ? 'up' : 'down'}">${g > 0 ? '↑' : '↓'} ${Math.abs(g).toFixed(0)}%</span>`;
};
const money = (n) => `₹${fmtNum(n, 0)}`;

export default {
  title: 'Reports',
  roles: ['admin', 'manager', 'purchase'],
  async render(el) {
    el.classList.add('wide-page');
    const sales = await sb.rpc('sales_status').then(check);
    el.innerHTML = `
      <h1>Reports</h1>
      <div class="card">
        <div class="filters">
          <label class="small">Warehouse <select id="wh">${warehouseOptions(state.warehouses, state.warehouseId)}</select></label>
          <label class="small sales-only">Group by <select id="by">${BY.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
          <select id="preset" class="sales-only">
            <option value="30">Last 30 days</option><option value="7">Last 7 days</option><option value="90">Last 90 days</option>
            <option value="365">Last 365 days</option><option value="custom">Custom dates</option>
          </select>
          <label class="small sales-only">From <input type="date" id="from"></label>
          <label class="small sales-only">To <input type="date" id="to"></label>
          <button class="btn ghost small sales-only" id="dl">Download Excel</button>
        </div>
        <p class="muted small sales-only" id="period"></p>
      </div>
      <div class="card">
        <div class="tabs-inline" id="tabs">${TABS.map(([k, l]) => `<button class="tab" data-t="${k}">${l}</button>`).join('')}</div>
        <div id="view"><div class="loading">Loading…</div></div>
      </div>`;

    const whSel = $('#wh', el), bySel = $('#by', el), preset = $('#preset', el), fromI = $('#from', el), toI = $('#to', el);
    let tab = 'summary', groups = [], movers = [], hourly = [], hourGrp = '';

    // "today" for reports = the last day with sales uploaded
    const lastSalesDay = () => sales.find((s) => String(s.warehouse_id) === whSel.value)?.last_date || todayISO();
    const setPreset = () => {
      if (preset.value === 'custom') return;
      const to = lastSalesDay();
      toI.value = to; fromI.value = addDays(to, -(Number(preset.value) - 1));
    };
    setPreset();

    whSel.onchange = () => { rememberWarehouse(whSel.value); setPreset(); load(); };
    bySel.onchange = () => { hourGrp = ''; load(); };
    preset.onchange = () => { setPreset(); load(); };
    fromI.onchange = toI.onchange = () => { preset.value = 'custom'; load(); };
    $$('#tabs .tab', el).forEach((b) => (b.onclick = () => {
      const fromTat = tab === 'tat';
      tab = b.dataset.t;
      if (fromTat && tab !== 'tat') load(); else draw();   // sales data may not be loaded yet
    }));

    const prevRange = () => {
      const days = Math.round((Date.parse(toI.value) - Date.parse(fromI.value)) / 86400000) + 1;
      return [addDays(fromI.value, -days), addDays(fromI.value, -1), days];
    };

    async function load() {
      if (tab === 'tat') return draw();
      const view = $('#view', el);
      view.innerHTML = '<div class="loading">Loading…</div>';
      const args = { p_warehouse_id: Number(whSel.value), p_from: fromI.value, p_to: toI.value };
      const [pf, pt, days] = prevRange();
      $('#period', el).textContent = `${warehouseName(whSel.value)}: ${fmtDate(fromI.value)} to ${fmtDate(toI.value)} (${days} days), compared with ${fmtDate(pf)} to ${fmtDate(pt)}. Sales uploaded up to ${fmtDate(lastSalesDay())}.`;
      try {
        [groups, movers, hourly] = await Promise.all([
          sb.rpc('report_groups', { ...args, p_by: bySel.value }).then(check),
          sb.rpc('report_movers', { ...args, p_limit: 20 }).then(check),
          sb.rpc('report_hourly', { ...args, p_by: bySel.value, p_grp: hourGrp || null }).then(check),
        ]);
      } catch (e) { view.innerHTML = `<div class="note error">${esc(e.message)}</div>`; return; }
      draw();
    }

    const byLabel = () => BY.find(([v]) => v === bySel.value)[1];

    function draw() {
      $$('#tabs .tab', el).forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
      // Turn Around Time has its own dates (orders, up to today)
      $$('.sales-only', el).forEach((x) => (x.style.display = tab === 'tat' ? 'none' : ''));
      const view = $('#view', el);
      if (tab === 'tat') return drawTat(view, whSel.value);
      if (tab === 'summary') return drawSummary(view);
      if (tab === 'buysell') return drawBuySell(view);
      if (tab === 'movers') return drawMovers(view);
      return drawHourly(view);
    }

    // ---------------- 1. Summary ----------------
    function drawSummary(view) {
      const total = groups.reduce((a, g) => a + Number(g.sales_amt), 0);
      const totQ = groups.reduce((a, g) => a + Number(g.sales_qty), 0);
      const totP = groups.reduce((a, g) => a + Number(g.prev_amt), 0);
      view.innerHTML = `
        <div class="kv">
          <div><span>Sales</span><b>${money(total)}</b> ${growthCell(total, totP)}</div>
          <div><span>Strips sold</span><b>${fmtNum(totQ)}</b></div>
          <div><span>Purchases</span><b>${money(groups.reduce((a, g) => a + Number(g.purchase_amt), 0))}</b></div>
          <div><span>${byLabel()} groups</span><b>${fmtNum(groups.length)}</b></div>
        </div>
        <p class="muted small">Click a row to see its medicines. "(not set)" = medicines without a ${byLabel().toLowerCase()} in the item master.</p>
        <div class="scroll"><table class="tbl rep">
          <tr><th>${byLabel()}</th><th class="num">Medicines</th><th class="num">Sales ₹</th><th class="num">Share</th><th class="num">Growth</th>
            <th class="num">Strips sold</th><th class="num">Bills</th><th class="num">Customers</th><th class="num">Purchases ₹</th><th class="num">Strips bought</th></tr>
          ${groups.map((g, i) => `<tr class="click" data-i="${i}"><td><b>${esc(g.grp)}</b></td><td class="num">${fmtNum(g.items)}</td>
            <td class="num">${money(g.sales_amt)}</td><td class="num">${total ? ((100 * g.sales_amt) / total).toFixed(1) : 0}%</td>
            <td class="num">${growthCell(Number(g.sales_amt), Number(g.prev_amt))}</td><td class="num">${fmtNum(g.sales_qty)}</td>
            <td class="num">${fmtNum(g.bills)}</td><td class="num">${fmtNum(g.customers)}</td>
            <td class="num">${money(g.purchase_amt)}</td><td class="num">${fmtNum(g.purchase_qty)}</td></tr>`).join('')}
        </table></div><div id="drill"></div>`;
      $$('tr.click', view).forEach((tr) => (tr.onclick = () => drill(groups[Number(tr.dataset.i)].grp)));
    }

    let drillRows = [], drillName = '';
    async function drill(grp) {
      const box = $('#drill', el);
      box.innerHTML = '<div class="loading">Loading…</div>';
      drillName = grp;
      drillRows = await sb.rpc('report_items', { p_warehouse_id: Number(whSel.value), p_from: fromI.value, p_to: toI.value, p_by: bySel.value, p_grp: grp }).then(check);
      box.innerHTML = `<h3>${esc(byLabel())}: ${esc(grp)} — ${fmtNum(drillRows.length)} medicines</h3>
        <div class="row"><input type="search" id="dq" placeholder="Search medicine…"></div>
        <div class="scroll"><table class="tbl compact" id="dt"></table></div>`;
      const paint = () => {
        const q = $('#dq', el).value.trim().toLowerCase();
        const rows = drillRows.filter((r) => !q || r.name.toLowerCase().includes(q)).slice(0, 500);
        $('#dt', el).innerHTML = `<tr><th>Medicine</th><th>Pack</th><th class="num">Sales ₹</th><th class="num">Strips sold</th><th class="num">Before</th><th class="num">Growth</th>
          <th class="num">Bills</th><th class="num">Customers</th><th class="num">Strips bought</th><th class="num">Returned</th><th class="num">Kept / sold</th></tr>
          ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.pack_size)}</td><td class="num">${money(r.sales_amt)}</td><td class="num">${fmtNum(r.sales_qty, 2)}</td>
            <td class="num">${fmtNum(r.prev_qty, 2)}</td><td class="num">${growthCell(Number(r.sales_qty), Number(r.prev_qty))}</td>
            <td class="num">${fmtNum(r.bills)}</td><td class="num">${fmtNum(r.customers)}</td><td class="num">${fmtNum(r.purchase_qty, 2)}</td>
            <td class="num">${Number(r.returned_qty) ? `−${fmtNum(r.returned_qty, 2)}` : ''}</td>
            <td class="num">${ratioCell(keptOf(r), r.sales_qty)}</td></tr>`).join('')}`;
      };
      $('#dq', el).oninput = paint;
      paint();
      box.scrollIntoView({ behavior: 'smooth' });
    }

    // ---------------- 2. Buying vs Selling ----------------
    const ratioCell = (bought, sold) => {
      bought = Number(bought); sold = Number(sold);
      if (!bought) return '<span class="muted">—</span>';
      if (!sold) return '<span class="down"><b>no sales</b></span>';
      const r = bought / sold;
      return `<span class="${r > OVERBUY ? 'down' : ''}">${r > OVERBUY ? '<b>' : ''}${(r * 100).toFixed(0)}%${r > OVERBUY ? '</b>' : ''}</span>`;
    };
    // strips kept = bought − returned (returns in the same dates)
    const keptOf = (g) => Math.max(Number(g.purchase_qty) - Number(g.returned_qty || 0), 0);
    function drawBuySell(view) {
      const rows = groups.filter((g) => Number(g.purchase_qty) > 0)
        .map((g) => ({ ...g, kept: keptOf(g), ratio: Number(g.sales_qty) ? keptOf(g) / Number(g.sales_qty) : Infinity }))
        .sort((a, b) => b.ratio - a.ratio || b.purchase_qty - a.purchase_qty);
      const flagged = rows.filter((r) => r.ratio > OVERBUY);
      view.innerHTML = `<p class="muted small">Strips kept (bought − returned) vs strips sold in the same dates. Above <b>${OVERBUY * 100}%</b> = buying more than selling, so stock is building up (flagged in red).
          Needs purchases uploaded for these dates.</p>
        ${rows.length ? `<div class="note ${flagged.length ? 'warn' : 'ok'}"><b>${flagged.length}</b> of ${rows.length} ${byLabel().toLowerCase()} groups bought more than ${OVERBUY * 100}% of what sold.</div>
        <div class="scroll"><table class="tbl rep">
          <tr><th>${byLabel()}</th><th class="num">Strips bought</th><th class="num">Returned</th><th class="num">Kept</th><th class="num">Strips sold</th><th class="num">Kept / sold</th><th class="num">Extra strips</th>
            <th class="num">Purchases ₹</th><th class="num">Sales ₹</th></tr>
          ${rows.map((r) => `<tr class="click ${r.ratio > OVERBUY ? 'flag' : ''}" data-g="${esc(r.grp)}"><td><b>${esc(r.grp)}</b></td><td class="num">${fmtNum(r.purchase_qty)}</td>
            <td class="num">${Number(r.returned_qty) ? `−${fmtNum(r.returned_qty)}` : ''}</td><td class="num"><b>${fmtNum(r.kept)}</b></td>
            <td class="num">${fmtNum(r.sales_qty)}</td><td class="num">${ratioCell(r.kept, r.sales_qty)}</td>
            <td class="num">${fmtNum(Math.max(r.kept - Number(r.sales_qty), 0))}</td>
            <td class="num">${money(r.purchase_amt)}</td><td class="num">${money(r.sales_amt)}</td></tr>`).join('')}
        </table></div><div id="drill"></div>`
        : '<p class="muted">No purchases uploaded for these dates. Upload them on the Purchases screen.</p>'}`;
      $$('tr.click', view).forEach((tr) => (tr.onclick = () => drill(tr.dataset.g)));
    }

    // ---------------- 3. Rising & Falling ----------------
    function drawMovers(view) {
      const g = groups.map((x) => ({ ...x, change: Number(x.sales_qty) - Number(x.prev_qty) })).filter((x) => x.grp !== '(not set)');
      const gUp = [...g].filter((x) => x.change > 0).sort((a, b) => b.change - a.change).slice(0, 10);
      const gDown = [...g].filter((x) => x.change < 0).sort((a, b) => a.change - b.change).slice(0, 10);
      const up = movers.filter((m) => m.direction === 'up'), down = movers.filter((m) => m.direction === 'down');
      const gTable = (list, title) => `<div><h3>${title}</h3>${list.length ? `<table class="tbl compact"><tr><th>${byLabel()}</th><th class="num">Now</th><th class="num">Before</th><th class="num">Change</th></tr>
        ${list.map((x) => `<tr><td>${esc(x.grp)}</td><td class="num">${fmtNum(x.sales_qty)}</td><td class="num">${fmtNum(x.prev_qty)}</td><td class="num">${growthCell(Number(x.sales_qty), Number(x.prev_qty))}</td></tr>`).join('')}</table>` : '<p class="muted">None.</p>'}</div>`;
      const mTable = (list, title) => `<div><h3>${title}</h3>${list.length ? `<table class="tbl compact"><tr><th>Medicine</th><th class="num">Now</th><th class="num">Before</th><th class="num">Change</th></tr>
        ${list.map((m) => `<tr><td>${esc(m.name)} <span class="muted">${esc(m.pack_size)}</span>${m.category ? `<div class="small muted">${esc(m.category)}</div>` : ''}</td>
          <td class="num">${fmtNum(m.now_qty)}</td><td class="num">${fmtNum(m.prev_qty)}</td>
          <td class="num"><span class="${m.change > 0 ? 'up' : 'down'}">${m.change > 0 ? '+' : ''}${fmtNum(m.change)}</span></td></tr>`).join('')}</table>` : '<p class="muted">None.</p>'}</div>`;
      view.innerHTML = `<p class="muted small">Strips sold now vs the same number of days just before. Rising = new demand to stock up on; falling = slow down ordering before stock piles up.</p>
        <div class="two">${gTable(gUp, `${byLabel()} — rising`)}${gTable(gDown, `${byLabel()} — falling`)}</div>
        <div class="two">${mTable(up, 'Medicines — rising most (top 20)')}${mTable(down, 'Medicines — falling most (top 20)')}</div>`;
    }

    // ---------------- 4. Hourly ----------------
    function drawHourly(view) {
      const byHour = Object.fromEntries(hourly.map((h) => [h.hour, h]));
      const max = Math.max(1, ...hourly.map((h) => Number(h.bills)));
      const totalBills = hourly.reduce((a, h) => a + Number(h.bills), 0);
      const top = [...hourly].sort((a, b) => b.bills - a.bills).slice(0, 3).map((h) => h.hour).sort((a, b) => a - b);
      const lab = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
      view.innerHTML = `
        <div class="filters"><label class="small">${byLabel()} <select id="hg"><option value="">All medicines</option>
          ${groups.map((g) => `<option ${hourGrp === g.grp ? 'selected' : ''}>${esc(g.grp)}</option>`).join('')}</select></label>
          ${top.length ? `<span class="small">Busiest hours: <b>${top.map(lab).join(', ')}</b></span>` : ''}</div>
        ${hourly.length ? `<div class="hours">${Array.from({ length: 24 }, (_, h) => {
          const x = byHour[h], b = x ? Number(x.bills) : 0;
          return `<div class="hcol" title="${lab(h)}: ${fmtNum(b)} bills, ${fmtNum(x?.sales_qty || 0)} strips, ${money(x?.sales_amt || 0)}">
            <div class="hval">${b ? fmtNum(b) : ''}</div><div class="hbar" style="height:${(100 * b) / max}%"></div><div class="hlab">${lab(h)}</div></div>`;
        }).join('')}</div>
        <p class="muted small">Bills per hour of the day, ${fmtNum(totalBills)} bills in total. Hover a bar for strips and ₹.</p>
        <table class="tbl compact"><tr><th>Hour</th><th class="num">Bills</th><th class="num">Strips</th><th class="num">Sales ₹</th><th class="num">Share of bills</th></tr>
          ${hourly.map((h) => `<tr><td>${lab(h.hour)}–${lab((h.hour + 1) % 24)}</td><td class="num">${fmtNum(h.bills)}</td><td class="num">${fmtNum(h.sales_qty)}</td>
            <td class="num">${money(h.sales_amt)}</td><td class="num">${totalBills ? ((100 * h.bills) / totalBills).toFixed(1) : 0}%</td></tr>`).join('')}</table>`
        : '<p class="muted">No sales with a time in these dates.</p>'}`;
      $('#hg', view).onchange = async (e) => {
        hourGrp = e.target.value;
        hourly = await sb.rpc('report_hourly', { p_warehouse_id: Number(whSel.value), p_from: fromI.value, p_to: toI.value, p_by: bySel.value, p_grp: hourGrp || null }).then(check);
        drawHourly(view);
      };
    }

    // ---------------- Excel ----------------
    $('#dl', el).onclick = () => {
      const g = groups.map((x) => ({
        [byLabel()]: x.grp, Medicines: x.items, 'Sales ₹': Number(x.sales_amt), 'Sales ₹ before': Number(x.prev_amt),
        'Growth %': pct(Number(x.sales_amt), Number(x.prev_amt)) === null ? 'new' : Number(pct(Number(x.sales_amt), Number(x.prev_amt)).toFixed(1)),
        'Strips sold': Number(x.sales_qty), 'Strips sold before': Number(x.prev_qty), Bills: Number(x.bills), Customers: Number(x.customers),
        'Purchases ₹': Number(x.purchase_amt), 'Strips bought': Number(x.purchase_qty), 'Strips returned': Number(x.returned_qty || 0),
        'Kept / sold %': Number(x.sales_qty) ? Number(((100 * keptOf(x)) / x.sales_qty).toFixed(0)) : '',
      }));
      const sheets = { [`By ${byLabel()}`.slice(0, 31)]: g,
        'Rising & Falling': movers.map((m) => ({ Direction: m.direction === 'up' ? 'Rising' : 'Falling', Medicine: m.name, Pack: m.pack_size,
          Category: m.category || '', Manufacturer: m.manufacturer || '', 'Strips now': Number(m.now_qty), 'Strips before': Number(m.prev_qty), Change: Number(m.change) })),
        Hourly: hourly.map((h) => ({ Hour: h.hour, Bills: Number(h.bills), Strips: Number(h.sales_qty), 'Sales ₹': Number(h.sales_amt) })) };
      if (drillRows.length) sheets[`Medicines - ${drillName}`.slice(0, 31).replace(/[\\/?*[\]:]/g, '-')] = drillRows.map((r) => ({
        Medicine: r.name, Pack: r.pack_size, 'Sales ₹': Number(r.sales_amt), 'Strips sold': Number(r.sales_qty), 'Strips before': Number(r.prev_qty),
        Bills: Number(r.bills), Customers: Number(r.customers), 'Strips bought': Number(r.purchase_qty) }));
      downloadExcel(`Report ${warehouseName(whSel.value)} ${fromI.value} to ${toI.value}.xlsx`, sheets);
    };

    load();
  },
};
