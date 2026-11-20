import { sb, check, state, isRole } from '../db.js';
import { esc, $, $$, fmtNum, fmtDateTime, toast, confirmBox, readExcel, downloadExcel } from '../ui.js';

const PAGE = 200;   // medicines shown per page; the download has everything
const FILTERS = [
  ['all', 'All medicines', 'total'],
  ['no_conv', 'Needs checking (strip conversion)', 'no_conv'],
  ['no_category', 'No category', 'no_category'],
  ['no_manufacturer', 'No manufacturer', 'no_manufacturer'],
  ['chronic', 'Chronic', 'chronic'],
  ['discontinued', 'Discontinued', 'discontinued'],
];
const KIND_LABEL = { strips: 'Strips sheet', details: 'Medicine details', discontinue: 'Duplicate Items (discontinue)' };

export default {
  title: 'Item master',
  roles: ['admin', 'manager', 'purchase'],
  async render(el) {
    const canEdit = isRole('admin', 'manager');
    const whName = (id) => state.warehouses.find((w) => String(w.id) === String(id))?.name || `Warehouse ${id}`;
    el.classList.add('wide-page');
    el.innerHTML = `
      <h1>Item master</h1>
      <div class="card">
        <div class="tabs-inline" id="tabs">
          <button class="tab on" data-v="all">All medicines</button>
          <button class="tab" data-v="check">Needs checking</button>
          <button class="tab" data-v="history">Upload history</button>
          ${canEdit ? '<button class="tab" data-v="upload">Upload sheets</button>' : ''}
        </div>
        ${canEdit ? '' : '<p class="muted small">You can view the item master. Admin or Manager can upload sheets and edit medicines.</p>'}
        <div id="view"></div>
      </div>`;

    let current = 'all';
    $$('#tabs .tab', el).forEach((b) => (b.onclick = () => show(b.dataset.v)));
    const log = async (kind, file, sheet, wh, rows, added, updated) => {
      try { await sb.rpc('log_item_upload', { p_kind: kind, p_file: file, p_sheet: sheet || '', p_warehouse_id: wh, p_rows: rows, p_added: added, p_updated: updated }).then(check); }
      catch { /* history is a convenience; the upload itself worked */ }
    };

    function show(v) {
      current = v;
      $$('#tabs .tab', el).forEach((x) => x.classList.toggle('on', x.dataset.v === v));
      const view = $('#view', el);
      view.innerHTML = '<div class="loading">Loading…</div>';
      ({ all: showAll, check: showCheck, history: showHistory, upload: showUpload })[v](view)
        .catch((e) => { view.innerHTML = `<div class="note error">${esc(e.message)}</div>`; });
    }

    // ================= All medicines =================
    const L = { filter: 'all', q: '', offset: 0 };
    async function showAll(view) {
      const counts = await sb.rpc('items_overview').then(check);
      view.innerHTML = `
        <div class="chips" id="cnt">${FILTERS.map(([k, label, c]) => `<button class="chip ${L.filter === k ? 'on' : ''}" data-f="${k}">${label} <span>${fmtNum(counts[c])}</span></button>`).join('')}</div>
        <div class="row"><input id="q" type="search" placeholder="Search medicine…" value="${esc(L.q)}">
          <button class="btn ghost small" id="dla">Download Excel</button>
          <span class="muted small">The download has the same columns as the upload sheets: fill the blanks and upload it back.</span></div>
        <div id="res"><div class="loading">Loading…</div></div>`;
      $$('#cnt .chip', view).forEach((b) => (b.onclick = () => {
        L.filter = b.dataset.f; L.offset = 0;
        $$('#cnt .chip', view).forEach((x) => x.classList.toggle('on', x === b));
        list(view);
      }));
      let t;
      $('#q', view).oninput = (e) => { clearTimeout(t); t = setTimeout(() => { L.q = e.target.value; L.offset = 0; list(view); }, 300); };
      $('#dla', view).onclick = () => downloadAll($('#dla', view));
      list(view);
    }

    const toRow = (a) => ({ id: a[0], name: a[1], pack: a[2], loose: a[3], category: a[4], ailment: a[5], brand: a[6],
      manufacturer: a[7], chronic: a[8], status: a[9], dw: a[10] || [], updated: a[11] });
    const discText = (r) => r.status === 'discontinued' ? 'All warehouses' : r.dw.map(whName).join(', ');

    async function list(view) {
      const res = $('#res', view);
      const asked = { ...L };
      const out = await sb.rpc('items_list', { p_q: L.q, p_filter: L.filter, p_offset: L.offset, p_limit: PAGE }).then(check);
      if (asked.q !== L.q || asked.filter !== L.filter || asked.offset !== L.offset) return;   // a newer search is on its way
      const rows = out.rows.map(toRow);
      const from = out.total ? L.offset + 1 : 0, to = L.offset + rows.length;
      res.innerHTML = `
        <div class="scroll"><table class="tbl">
          <tr><th>Medicine</th><th>Pack</th><th class="num">Qty in Loose</th><th>Category</th><th>Ailment</th><th>Brand</th>
            <th>Manufacturer</th><th>Chronic</th><th>Discontinued</th>${canEdit ? '<th></th>' : ''}</tr>
          ${rows.map((r) => `<tr data-id="${r.id}">
            <td>${esc(r.name)}</td><td>${esc(r.pack)}</td>
            <td class="num">${r.loose === null ? '<span class="pill warn">none</span>' : fmtNum(r.loose)}</td>
            <td>${esc(r.category || '')}</td><td>${esc(r.ailment || '')}</td><td>${esc(r.brand || '')}</td><td>${esc(r.manufacturer || '')}</td>
            <td>${r.chronic ? '<span class="pill chronic">Chronic</span>' : ''}</td>
            <td>${discText(r) ? `<span class="pill failed">${esc(discText(r))}</span>` : ''}</td>
            ${canEdit ? '<td><button class="btn ghost small ed">Edit</button></td>' : ''}</tr>`).join('')}
        </table></div>
        <div class="row"><span class="muted small">${out.total ? `Showing ${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(out.total)}` : 'No medicines match.'}</span>
          ${L.offset > 0 ? '<button class="btn ghost small" id="prev">‹ Previous</button>' : ''}
          ${to < out.total ? '<button class="btn ghost small" id="next">Next ›</button>' : ''}</div>`;
      const p = $('#prev', res), n = $('#next', res);
      if (p) p.onclick = () => { L.offset = Math.max(0, L.offset - PAGE); list(view); };
      if (n) n.onclick = () => { L.offset += PAGE; list(view); };
      $$('button.ed', res).forEach((b) => (b.onclick = async () => {
        const r = rows.find((x) => x.id === Number(b.closest('tr').dataset.id));
        if (await editItem(r)) showAll(view);
      }));
    }

    async function downloadAll(btn) {
      btn.disabled = true; btn.textContent = 'Preparing…';
      try {
        const all = [];
        for (let off = 0; ; off += 5000) {
          const out = await sb.rpc('items_list', { p_q: L.q, p_filter: L.filter, p_offset: off, p_limit: 5000 }).then(check);
          all.push(...out.rows.map(toRow));
          if (all.length >= out.total || !out.rows.length) break;
        }
        const label = FILTERS.find((f) => f[0] === L.filter)[1];
        downloadExcel(`Item master - ${label}.xlsx`, { Medicines: all.map((r) => ({
          'Medicine Name': r.name, 'Pack Size': r.pack, 'Qty in Loose': r.loose === null ? '' : Number(r.loose),
          Category: r.category || '', 'Type of Ailment': r.ailment || '', 'Brand Name': r.brand || '', Manufacturer: r.manufacturer || '',
          Chronic: r.chronic ? 'Yes' : '', 'Discontinued in': discText(r) })) });
      } catch (e) { toast(e.message, 'error'); }
      btn.disabled = false; btn.textContent = 'Download Excel';
    }

    // edit one medicine in a dialog; resolves true when saved
    let keys = null;
    async function editItem(r) {
      if (!keys) {
        keys = {};
        await Promise.all(['category', 'ailment', 'manufacturer', 'brand'].map(async (k) => {
          try { keys[k] = (await sb.rpc('report_keys', { p_by: k }).then(check)).map((x) => (typeof x === 'string' ? x : Object.values(x)[0])).filter((x) => x && x !== '(not set)'); }
          catch { keys[k] = []; }
        }));
      }
      return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.className = 'modal-wrap';
        const txt = (k, label, v) => `<label class="field"><span>${label}</span><input name="${k}" value="${esc(v || '')}" list="dl-${k}" autocomplete="off">
          <datalist id="dl-${k}">${(keys[k] || []).map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>`;
        const allDisc = r.status === 'discontinued';
        wrap.innerHTML = `
          <form class="modal wide">
            <h3>${esc(r.name)} <span class="muted">${esc(r.pack)}</span></h3>
            <div class="grid2">
              <label class="field"><span>Qty in Loose (loose units in one strip)</span><input name="loose" type="number" min="0.001" step="any" value="${r.loose ?? ''}"></label>
              ${txt('category', 'Category', r.category)}
              ${txt('ailment', 'Type of Ailment', r.ailment)}
              ${txt('brand', 'Brand Name', r.brand)}
              ${txt('manufacturer', 'Manufacturer', r.manufacturer)}
            </div>
            <label class="switch"><input type="checkbox" name="chronic" ${r.chronic ? 'checked' : ''}> Chronic – stocked after the first sale</label>
            <fieldset class="disc-box"><legend>Discontinued (not suggested in orders)</legend>
              <label class="switch"><input type="checkbox" name="discAll" ${allDisc ? 'checked' : ''}> All warehouses</label>
              ${state.warehouses.map((w) => `<label class="switch"><input type="checkbox" name="wh" value="${w.id}" ${allDisc ? 'disabled' : ''} ${r.dw.includes(w.id) ? 'checked' : ''}> ${esc(w.name)}</label>`).join('')}
            </fieldset>
            <p class="muted small">Pick from the list where you can, so the same company isn't spelled two ways.</p>
            <div class="modal-actions"><button type="button" class="btn ghost" data-a="no">Cancel</button><button class="btn primary">Save</button></div>
          </form>`;
        document.body.appendChild(wrap);
        const f = $('form', wrap);
        f.discAll.onchange = () => $$('input[name="wh"]', f).forEach((c) => (c.disabled = f.discAll.checked));
        $('[data-a="no"]', wrap).onclick = () => { wrap.remove(); resolve(false); };
        f.onsubmit = async (e) => {
          e.preventDefault();
          const loose = f.loose.value === '' ? null : Number(f.loose.value);
          if (loose !== null && !(loose > 0)) { toast('Qty in Loose must be more than 0', 'error'); return; }
          try {
            await sb.rpc('update_item', {
              p_id: r.id, p_loose: loose, p_category: f.category.value, p_ailment: f.ailment.value, p_brand: f.brand.value,
              p_manufacturer: f.manufacturer.value, p_chronic: f.chronic.checked, p_disc_all: f.discAll.checked,
              p_disc_wh: f.discAll.checked ? [] : $$('input[name="wh"]:checked', f).map((c) => Number(c.value)),
            }).then(check);
            wrap.remove(); toast('Saved'); resolve(true);
          } catch (err) { toast(err.message, 'error'); }
        };
      });
    }

    // ================= Needs checking =================
    async function showCheck(view) {
      const rows = await sb.rpc('items_needing_check').then(check);
      const sold = rows.filter((r) => Number(r.sold_90d) > 0 || r.has_stock);
      view.innerHTML = `
        <p class="muted">Medicines with no loose-to-strip conversion, or a tablet/capsule conversion that doesn't match the pack size.
          Busiest first. ${canEdit ? 'Type the right Qty in Loose — it saves straight away and the stock screen updates.' : 'Admin or Manager can fix these.'}</p>
        <div class="row"><span><b>${fmtNum(rows.length)}</b> to check, <b>${fmtNum(sold.length)}</b> of them sold in the last 90 days or in stock.</span>
          <button class="btn ghost small" id="dlc">Download list</button></div>
        <div class="scroll"><table class="tbl">
          <tr><th>Medicine</th><th>Pack</th><th>Qty in Loose</th><th>Problem</th><th class="num">Sold 90d (strips)</th><th>In stock</th></tr>
          ${rows.slice(0, 400).map((r) => `<tr data-id="${r.id}"><td>${esc(r.name)}</td><td>${esc(r.pack_size)}</td>
            <td>${canEdit ? `<input class="conv" type="number" min="0.001" step="any" value="${r.loose_per_strip ?? ''}" placeholder="—">` : esc(r.loose_per_strip ?? '—')}</td>
            <td><span class="pill warn">${esc(r.problem)}</span></td>
            <td class="num">${fmtNum(r.sold_90d, 2)}</td><td>${r.has_stock ? 'Yes' : ''}</td></tr>`).join('')}
        </table></div>${rows.length > 400 ? '<p class="muted small">Showing the first 400. Download the list for all.</p>' : ''}`;
      $('#dlc', view).onclick = () => downloadExcel('Items_to_check.xlsx', { 'To check': rows.map((r) => ({
        'Item Name': r.name, 'Pack Size': r.pack_size, 'Qty in Loose now': r.loose_per_strip ?? '',
        Problem: r.problem, 'Sold last 90 days (strips)': Number(r.sold_90d), 'In stock': r.has_stock ? 'Yes' : '',
        'Qty in Loose (correct)': '' })) });
      $$('input.conv', view).forEach((inp) => (inp.onchange = async () => {
        const v = inp.value === '' ? null : Number(inp.value);
        if (v !== null && !(v > 0)) { toast('Must be more than 0', 'error'); return; }
        try {
          await sb.rpc('set_item_conversion', { p_id: Number(inp.closest('tr').dataset.id), p_loose: v }).then(check);
          inp.classList.add('saved'); setTimeout(() => inp.classList.remove('saved'), 1200);
          toast('Saved');
        } catch (e) { toast(e.message, 'error'); }
      }));
    }

    // ================= Upload history =================
    async function showHistory(view) {
      const rows = await sb.from('item_uploads').select('*').order('created_at', { ascending: false }).limit(200).then(check);
      view.innerHTML = rows.length ? `
        <p class="muted small">Every Strips, Medicine details and Duplicate Items upload, newest first.</p>
        <div class="scroll"><table class="tbl">
          <tr><th>When</th><th>Sheet</th><th>File</th><th>Warehouse</th><th class="num">Rows</th><th class="num">Added</th><th class="num">Updated / marked</th><th>By</th></tr>
          ${rows.map((r) => `<tr><td class="nowrap">${fmtDateTime(r.created_at)}</td><td>${esc(KIND_LABEL[r.kind] || r.kind)}</td>
            <td>${esc(r.file_name || '')}</td><td>${r.kind === 'discontinue' ? esc(r.warehouse_id ? whName(r.warehouse_id) : 'All warehouses') : 'All'}</td>
            <td class="num">${fmtNum(r.rows)}</td><td class="num">${fmtNum(r.added)}</td><td class="num">${fmtNum(r.updated)}</td>
            <td>${esc(r.by_name || '')}</td></tr>`).join('')}
        </table></div>`
        : '<p class="muted">No uploads recorded yet. Uploads from now on are listed here (earlier ones were not recorded).</p>';
    }

    // ================= Upload sheets (Admin, Manager) =================
    async function showUpload(view) {
      view.innerHTML = `
        <div class="card inner">
          <h3>Strips sheet</h3>
          <p class="muted">Columns: Item Name, Pack Size, Qty in Loose (how many loose units make one strip / pack —
            Zincovit Tablet, 15 Tablet → 15). Same for every warehouse. New items are added and existing conversions are updated.
            An item listed twice with different values is not changed; it is shown for you to decide.</p>
          <label class="drop" id="drop1"><input type="file" id="file1" accept=".xlsx,.xls,.csv" hidden>
            <b>Choose the Strips Excel file</b><span class="muted">or drag it here</span></label>
          <div id="work1"></div>
        </div>
        <div class="card inner">
          <h3>Medicine details</h3>
          <p class="muted">Columns: Medicine Name, Pack Size, Category, Type of Ailment, Brand Name, Manufacturer, Chronic (Yes / No).
            Same for every warehouse. Any detail column can be missing, and a blank cell never wipes what is already saved —
            so you can fill gaps over time. To take Chronic off a medicine, write <b>No</b>.</p>
          <label class="drop" id="drop3"><input type="file" id="file3" accept=".xlsx,.xls,.csv" hidden>
            <b>Choose the medicine details Excel file</b><span class="muted">or drag it here</span></label>
          <div id="work3"></div>
        </div>
        <div class="card inner">
          <h3>Duplicate Items sheet (discontinue)</h3>
          <p class="muted">Columns: Item Name, Pack Size, decision. Medicines marked <b>discontinue</b> are no longer suggested in
            orders for the warehouse you pick, and the purchase report shows "Discontinued item bought" if one is purchased there.</p>
          <label class="field inline"><span>Discontinue in</span>
            <select id="dwh"><option value="">All warehouses</option>${state.warehouses.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label>
          <label class="drop" id="drop2"><input type="file" id="file2" accept=".xlsx,.xls,.csv" hidden>
            <b>Choose the Duplicate Items Excel file</b><span class="muted">or the order sheet workbook — the right sheet is found automatically</span></label>
          <div id="work2"></div>
        </div>`;
      wireDrop(view, 1, strips);
      wireDrop(view, 3, details);
      wireDrop(view, 2, dupes);
    }

    function wireDrop(view, n, fn) {
      const input = $(`#file${n}`, view), drop = $(`#drop${n}`, view), work = $(`#work${n}`, view);
      const go = async (file) => { await fn(file, work); input.value = ''; };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) go(e.dataTransfer.files[0]); };
      input.onchange = () => input.files[0] && go(input.files[0]);
    }

    async function strips(file, work) {
      work.innerHTML = `<div class="progress-line">Reading ${esc(file.name)}…</div>`;
      try {
        const parsed = await readExcel(file, 'items');
        if (!(await confirmBox({ title: 'Load the Strips sheet?',
          html: `<p>Sheet <b>${esc(parsed.sheet)}</b>: ${fmtNum(parsed.rows.length)} items with a Qty in Loose.</p>
                 ${parsed.problems.length ? `<p class="muted">${parsed.problems.length} row(s) without a number are left out.</p>` : ''}`, ok: 'Load' }))) { work.innerHTML = ''; return; }
        work.innerHTML = '<div class="progress-line">Saving…</div>';
        const r = await sb.rpc('import_item_master', { p_rows: parsed.rows }).then(check);
        await log('strips', file.name, parsed.sheet, null, parsed.rows.length, r.added, r.conversion_set);
        work.innerHTML = `<div class="note ok"><b>Done.</b> ${fmtNum(r.added)} new items added, ${fmtNum(r.conversion_set)} conversions set or changed.</div>
          ${r.conflicts.length ? `<div class="note warn"><b>${r.conflicts.length} item(s) are listed more than once with different values</b> and were not changed. Set the right value under All medicines → Edit:
            <table class="tbl compact">${r.conflicts.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.pack)}</td><td>values in file: ${esc(c.values)}</td></tr>`).join('')}</table></div>` : ''}`;
        toast('Strips sheet loaded');
      } catch (e) { work.innerHTML = `<div class="note error">${esc(e.message)}</div>`; }
    }

    async function details(file, work) {
      work.innerHTML = `<div class="progress-line">Reading ${esc(file.name)}…</div>`;
      try {
        const parsed = await readExcel(file, 'details');
        const label = { category: 'Category', ailment: 'Type of Ailment', brand: 'Brand Name', manufacturer: 'Manufacturer', chronic: 'Chronic' };
        if (!(await confirmBox({ title: 'Load medicine details?', html: `<p>Sheet <b>${esc(parsed.sheet)}</b>: ${fmtNum(parsed.rows.length)} medicines.</p>
            <p>Columns found: <b>${parsed.found.map((f) => label[f]).join(', ')}</b></p>
            <p class="muted small">Blank cells keep what is already saved.</p>`, ok: 'Load' }))) { work.innerHTML = ''; return; }
        let added = 0, updated = 0, chronic = 0;
        for (let i = 0; i < parsed.rows.length; i += 5000) {
          work.innerHTML = `<div class="progress-line">Saving… ${fmtNum(i)} of ${fmtNum(parsed.rows.length)}</div>`;
          const r = await sb.rpc('import_item_details', { p_rows: parsed.rows.slice(i, i + 5000) }).then(check);
          added += r.added; updated += r.updated; chronic = r.chronic;
        }
        await log('details', file.name, parsed.sheet, null, parsed.rows.length, added, updated);
        work.innerHTML = `<div class="note ok"><b>Done.</b> ${fmtNum(updated)} medicines updated${added ? `, ${fmtNum(added)} new medicines added` : ''}.
          ${fmtNum(chronic)} medicines are now marked Chronic. Min / Max uses this the next time it is worked out (Orders → Recalculate).</div>`;
        toast('Medicine details loaded');
      } catch (e) { work.innerHTML = `<div class="note error">${esc(e.message)}</div>`; }
    }

    async function dupes(file, work) {
      const whv = $('#dwh', el).value;
      const where = whv ? whName(whv) : 'all warehouses';
      work.innerHTML = `<div class="progress-line">Reading ${esc(file.name)}…</div>`;
      try {
        const parsed = await readExcel(file, 'dupes');
        const n = parsed.rows.filter((r) => /discontinu/i.test(r.x)).length;
        if (!(await confirmBox({ title: 'Mark discontinued medicines?',
          html: `<p>Sheet <b>${esc(parsed.sheet)}</b>: ${fmtNum(n)} medicines marked "discontinue".</p>
                 <p>They will be discontinued in <b>${esc(where)}</b>.</p>`, ok: 'Mark them' }))) { work.innerHTML = ''; return; }
        const r = await sb.rpc('mark_discontinued', { p_rows: parsed.rows, p_warehouse_id: whv ? Number(whv) : null }).then(check);
        await log('discontinue', file.name, parsed.sheet, whv ? Number(whv) : null, r.rows, r.added, r.marked);
        work.innerHTML = `<div class="note ok"><b>Done.</b> ${fmtNum(r.marked)} medicines newly marked discontinued in ${esc(where)}${r.added ? `, ${fmtNum(r.added)} added to the item master` : ''}.
          ${r.rows - r.marked > 0 ? `${fmtNum(r.rows - r.marked)} were already marked.` : ''}</div>`;
      } catch (e) { work.innerHTML = `<div class="note error">${esc(e.message)}</div>`; }
    }

    show('all');
  },
};
