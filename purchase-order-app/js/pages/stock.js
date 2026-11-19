import { sb, check, state, rememberWarehouse, warehouseName, isRole } from '../db.js';
import { esc, $, fmtDateTime, fmtNum, toast, confirmBox, readExcel, warehouseOptions, downloadExcel } from '../ui.js';

const PAGE = 300;

export default {
  title: 'Stock',
  roles: ['admin', 'purchase'],
  async render(el) {
    el.innerHTML = `
      <h1>Stock</h1>
      <div class="card">
        <div class="form-row">
          <label class="field"><span>Warehouse</span>
            <select id="wh">${warehouseOptions(state.warehouses, state.warehouseId)}</select></label>
        </div>
        <label class="drop" id="drop">
          <input type="file" id="file" accept=".xlsx,.xls,.csv" hidden>
          <b>Upload stock Excel</b>
          <span class="muted">3 columns: Medicine Name, Pack Size, Stock in Loose. Loose is converted to strips using the item master.</span>
        </label>
        <p class="small"><a href="#" id="sample">Download sample format</a></p>
        <div id="work"></div>
      </div>
      <div class="card">
        <div class="head-row">
          <h3 id="stockTitle">Current stock</h3>
          <div class="row">
            <input id="q" type="search" placeholder="Search medicine…">
            <select id="filter">
              <option value="all">All items</option>
              <option value="attention">Needs attention</option>
            </select>
            <button class="btn ghost small" id="dl">Download Excel</button>
          </div>
        </div>
        <div id="flags"></div>
        <div id="list" class="loading">Loading…</div>
      </div>`;

    const whSel = $('#wh', el);
    whSel.onchange = () => { rememberWarehouse(whSel.value); $('#work', el).innerHTML = ''; loadStock(); };

    $('#sample', el).onclick = (e) => {
      e.preventDefault();
      downloadExcel('Stock_sample.xlsx', { Stock: [
        ['Medicine Name', 'Pack Size', 'Stock in Loose'],
        ['Zincovit Tablet', '15 Tablet', 45],
        ['Dabur Chyawanprash', '900 Gm', 3],
      ] });
    };

    const fileInput = $('#file', el), drop = $('#drop', el);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); };
    fileInput.onchange = () => fileInput.files[0] && handle(fileInput.files[0]);

    async function handle(file) {
      const work = $('#work', el);
      work.innerHTML = `<div class="progress-line">Reading ${esc(file.name)}…</div>`;
      let parsed;
      try { parsed = await readExcel(file, 'stock'); }
      catch (e) { work.innerHTML = `<div class="note error">${esc(e.message)}</div>`; fileInput.value = ''; return; }
      const wh = whSel.value;
      const withStock = parsed.rows.filter((r) => r.l > 0).length;
      work.innerHTML = `
        <h3>Check before saving</h3>
        <div class="kv">
          <div><span>Sheet</span><b>${esc(parsed.sheet)}</b></div>
          <div><span>Medicines</span><b>${fmtNum(parsed.rows.length)}</b></div>
          <div><span>With stock (more than 0)</span><b>${fmtNum(withStock)}</b></div>
        </div>
        ${parsed.problems.length ? `<div class="note warn">${parsed.problems.length} row(s) have no readable stock number and will be left out.</div>` : ''}
        <div class="row"><button class="btn primary" id="save">Save stock for ${esc(warehouseName(wh))}</button>
          <button class="btn ghost" id="cancel">Cancel</button></div>`;
      $('#cancel', el).onclick = () => { work.innerHTML = ''; fileInput.value = ''; };
      $('#save', el).onclick = async () => {
        const ok = await confirmBox({
          title: 'Save this stock count?',
          html: `<p>${fmtNum(parsed.rows.length)} medicines will be saved as the current stock of</p>
                 <p class="big-name">${esc(warehouseName(wh))}</p><p class="muted">Is this the right warehouse?</p>`,
          ok: `Yes, ${warehouseName(wh)}`,
        });
        if (!ok) return;
        $('#save', el).disabled = true;
        try {
          const r = await sb.rpc('import_stock', { p_warehouse_id: Number(wh), p_file_name: file.name, p_rows: parsed.rows }).then(check);
          work.innerHTML = `<div class="note ok"><b>Stock saved.</b> ${fmtNum(r.lines)} medicines.
            ${r.no_conversion ? `<br><b>${fmtNum(r.no_conversion)}</b> have stock but no loose-to-strip conversion — they are listed under "Needs attention" and won't count until the Admin adds the conversion.` : ''}
            ${r.new_items ? `<br>${fmtNum(r.new_items)} medicine(s) were new to the item master.` : ''}</div>`;
          toast('Stock saved');
          fileInput.value = '';
          loadStock();
        } catch (e) {
          work.innerHTML = `<div class="note error">${esc(e.message)}</div>`;
        }
      };
    }

    const q = $('#q', el), filter = $('#filter', el);
    let t;
    q.oninput = () => { clearTimeout(t); t = setTimeout(loadStock, 300); };
    filter.onchange = loadStock;

    function query(base) {
      let s = base.eq('warehouse_id', Number(whSel.value));
      if (q.value.trim()) s = s.ilike('name', `%${q.value.trim()}%`);
      if (filter.value === 'attention') s = s.neq('flag', 'OK');
      return s;
    }

    async function loadStock() {
      const list = $('#list', el);
      const countOf = (flag) => sb.from('latest_stock').select('item_id', { count: 'exact', head: true })
        .eq('warehouse_id', Number(whSel.value)).eq('flag', flag).then((r) => { check(r); return r.count || 0; });
      const [rows, noConv, wrong] = await Promise.all([
        query(sb.from('latest_stock').select('*')).order('attention', { ascending: false }).order('name').limit(PAGE).then(check),
        countOf('No conversion'),
        countOf('Qty in Loose does not match pack size'),
      ]);
      const counted = rows[0]?.counted_at;
      $('#stockTitle', el).textContent = `Current stock — ${warehouseName(whSel.value)}${counted ? `, counted ${fmtDateTime(counted)}` : ''}`;
      $('#flags', el).innerHTML = noConv + wrong ? `<div class="note warn">
        ${noConv ? `<b>${noConv}</b> item(s) with stock have no conversion, so their strips are unknown. ` : ''}
        ${wrong ? `<b>${wrong}</b> item(s) have a conversion that doesn't match the pack size (e.g. 10 Capsules but 1). ` : ''}
        ${isRole('admin') ? '<a href="#/items">Fix in Item master</a>' : 'Ask the Admin to fix these in the Item master.'}</div>` : '';
      list.classList.remove('loading');
      if (!rows.length) { list.innerHTML = `<p class="muted">${counted === undefined && !q.value && filter.value === 'all' ? 'No stock uploaded yet for this warehouse.' : 'Nothing matches.'}</p>`; return; }
      list.innerHTML = `<div class="scroll"><table class="tbl">
        <tr><th>Medicine</th><th>Pack</th><th class="num">Loose</th><th class="num">Loose per strip</th><th class="num">Strips</th><th>In hand</th><th></th></tr>
        ${rows.map((r) => `<tr class="${r.flag !== 'OK' ? 'flag' : ''}">
          <td>${esc(r.name)}</td><td>${esc(r.pack_size)}</td>
          <td class="num">${fmtNum(r.loose_qty, 3)}</td><td class="num">${fmtNum(r.loose_per_strip, 3)}</td>
          <td class="num">${r.strips === null ? '—' : fmtNum(r.strips, 2)}</td>
          <td>${r.full_strips === null ? '—' : `${fmtNum(r.full_strips)} strip${Number(r.full_strips) === 1 ? '' : 's'}${Number(r.extra_loose) ? ` + ${fmtNum(r.extra_loose, 3)} loose` : ''}`}</td>
          <td>${r.flag !== 'OK' ? `<span class="pill warn">${esc(r.flag)}</span>` : ''}</td></tr>`).join('')}
      </table></div>${rows.length === PAGE ? `<p class="muted small">Showing the first ${PAGE}. Use search, or download the full list.</p>` : ''}`;
    }

    $('#dl', el).onclick = async () => {
      const all = [];
      for (let from = 0; ; from += 1000) {
        const part = await sb.from('latest_stock').select('name, pack_size, loose_qty, loose_per_strip, strips, full_strips, extra_loose, flag')
          .eq('warehouse_id', Number(whSel.value)).order('name').range(from, from + 999).then(check);
        all.push(...part);
        if (part.length < 1000) break;
      }
      downloadExcel(`Stock_${warehouseName(whSel.value)}.xlsx`, { Stock: all.map((r) => ({
        'Medicine Name': r.name, 'Pack Size': r.pack_size, 'Stock in Loose': Number(r.loose_qty),
        'Loose per Strip': r.loose_per_strip === null ? '' : Number(r.loose_per_strip),
        'Stock in Strips': r.strips === null ? '' : Number(r.strips),
        'Full Strips': r.full_strips === null ? '' : Number(r.full_strips),
        'Extra Loose': r.extra_loose === null ? '' : Number(r.extra_loose), 'Check': r.flag === 'OK' ? '' : r.flag,
      })) });
    };

    loadStock();
  },
};
