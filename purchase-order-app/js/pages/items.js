import { sb, check } from '../db.js';
import { esc, $, $$, fmtNum, toast, confirmBox, readExcel, downloadExcel } from '../ui.js';

export default {
  title: 'Item master',
  roles: ['admin'],
  async render(el) {
    el.innerHTML = `
      <h1>Item master</h1>
      <div class="card">
        <h3>Load the Strips sheet</h3>
        <p class="muted">Columns: Item Name, Pack Size, Qty in Loose (how many loose units make one strip / pack —
          Zincovit Tablet, 15 Tablet → 15). New items are added and existing conversions are updated.
          An item listed twice with different values is not changed; it is shown for you to decide.</p>
        <label class="drop" id="drop"><input type="file" id="file" accept=".xlsx,.xls,.csv" hidden>
          <b>Choose the Strips Excel file</b><span class="muted">or drag it here</span></label>
        <div id="work"></div>
      </div>
      <div class="card">
        <div class="tabs-inline">
          <button class="tab on" data-v="check">Needs checking</button>
          <button class="tab" data-v="all">All items</button>
        </div>
        <div id="view"></div>
      </div>`;

    // ---------------- upload ----------------
    const fileInput = $('#file', el), drop = $('#drop', el);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); };
    fileInput.onchange = () => fileInput.files[0] && handle(fileInput.files[0]);

    async function handle(file) {
      const work = $('#work', el);
      work.innerHTML = `<div class="progress-line">Reading ${esc(file.name)}…</div>`;
      let parsed;
      try { parsed = await readExcel(file, 'items'); }
      catch (e) { work.innerHTML = `<div class="note error">${esc(e.message)}</div>`; fileInput.value = ''; return; }
      const ok = await confirmBox({
        title: 'Load item master?',
        html: `<p>Sheet <b>${esc(parsed.sheet)}</b>: ${fmtNum(parsed.rows.length)} items with a Qty in Loose.</p>
               ${parsed.problems.length ? `<p class="muted">${parsed.problems.length} row(s) without a number are left out.</p>` : ''}`,
        ok: 'Load',
      });
      if (!ok) { work.innerHTML = ''; fileInput.value = ''; return; }
      work.innerHTML = `<div class="progress-line">Saving…</div>`;
      try {
        const r = await sb.rpc('import_item_master', { p_rows: parsed.rows }).then(check);
        work.innerHTML = `<div class="note ok"><b>Done.</b> ${fmtNum(r.added)} new items added, ${fmtNum(r.conversion_set)} conversions set or changed.</div>
          ${r.conflicts.length ? `<div class="note warn"><b>${r.conflicts.length} item(s) are listed more than once with different values</b> and were not changed. Set the right value below:
            <table class="tbl compact">${r.conflicts.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.pack)}</td><td>values in file: ${esc(c.values)}</td></tr>`).join('')}</table></div>` : ''}`;
        toast('Item master loaded');
        fileInput.value = '';
        show(current);
      } catch (e) {
        work.innerHTML = `<div class="note error">${esc(e.message)}</div>`;
      }
    }

    // ---------------- lists ----------------
    let current = 'check';
    $$('.tab', el).forEach((b) => (b.onclick = () => {
      $$('.tab', el).forEach((x) => x.classList.toggle('on', x === b));
      show(b.dataset.v);
    }));

    function rowHTML(r, extra = '') {
      return `<tr data-id="${r.id}">
        <td>${esc(r.name)}</td><td>${esc(r.pack_size)}</td>
        <td><input class="conv" type="number" min="0.001" step="any" value="${r.loose_per_strip ?? ''}" placeholder="—"></td>
        ${extra}</tr>`;
    }

    function wireEdits(root) {
      $$('input.conv', root).forEach((inp) => (inp.onchange = async () => {
        const id = inp.closest('tr').dataset.id;
        const v = inp.value === '' ? null : Number(inp.value);
        if (v !== null && !(v > 0)) { toast('Must be more than 0', 'error'); return; }
        try {
          await sb.from('items').update({ loose_per_strip: v }).eq('id', id).then(check);
          inp.classList.add('saved'); setTimeout(() => inp.classList.remove('saved'), 1200);
          toast('Saved');
        } catch (e) { toast(e.message, 'error'); }
      }));
      $$('button.disc', root).forEach((b) => (b.onclick = async () => {
        const id = b.closest('tr').dataset.id;
        const next = b.dataset.s === 'active' ? 'discontinued' : 'active';
        await sb.from('items').update({ status: next }).eq('id', id).then(check);
        b.dataset.s = next; b.textContent = next === 'active' ? 'Active' : 'Discontinued';
        b.classList.toggle('muted-btn', next !== 'active');
      }));
    }

    async function show(v) {
      current = v;
      const view = $('#view', el);
      view.innerHTML = '<div class="loading">Loading…</div>';
      if (v === 'check') {
        const rows = await sb.rpc('items_needing_check').then(check);
        const sold = rows.filter((r) => Number(r.sold_90d) > 0 || r.has_stock);
        view.innerHTML = `
          <p class="muted">Items with no conversion, or a tablet/capsule conversion that doesn't match the pack size.
            Busiest first. Type the right Qty in Loose — it saves straight away and the stock screen updates.</p>
          <div class="row"><span><b>${fmtNum(rows.length)}</b> to check, <b>${fmtNum(sold.length)}</b> of them sold in the last 90 days or in stock.</span>
            <button class="btn ghost small" id="dlc">Download list</button></div>
          <div class="scroll"><table class="tbl">
            <tr><th>Medicine</th><th>Pack</th><th>Qty in Loose</th><th>Problem</th><th class="num">Sold 90d (strips)</th><th>In stock</th></tr>
            ${rows.slice(0, 400).map((r) => rowHTML(r, `<td><span class="pill warn">${esc(r.problem)}</span></td>
              <td class="num">${fmtNum(r.sold_90d, 2)}</td><td>${r.has_stock ? 'Yes' : ''}</td>`)).join('')}
          </table></div>${rows.length > 400 ? `<p class="muted small">Showing the first 400. Download the list for all.</p>` : ''}`;
        $('#dlc', view).onclick = () => downloadExcel('Items_to_check.xlsx', { 'To check': rows.map((r) => ({
          'Item Name': r.name, 'Pack Size': r.pack_size, 'Qty in Loose now': r.loose_per_strip ?? '',
          Problem: r.problem, 'Sold last 90 days (strips)': Number(r.sold_90d), 'In stock': r.has_stock ? 'Yes' : '',
          'Qty in Loose (correct)': '' })) });
        wireEdits(view);
      } else {
        view.innerHTML = `<div class="row"><input id="q" type="search" placeholder="Search medicine…" autofocus>
          <button class="btn ghost small" id="dla">Download all</button></div><div id="res"></div>`;
        const q = $('#q', view);
        let t;
        const search = async () => {
          let s = sb.from('items').select('id, name, pack_size, loose_per_strip, status').order('name').limit(200);
          if (q.value.trim()) s = s.ilike('name', `%${q.value.trim()}%`);
          const rows = await s.then(check);
          $('#res', view).innerHTML = `<div class="scroll"><table class="tbl">
            <tr><th>Medicine</th><th>Pack</th><th>Qty in Loose</th><th>Status</th></tr>
            ${rows.map((r) => rowHTML(r, `<td><button class="btn ghost small disc ${r.status === 'active' ? '' : 'muted-btn'}" data-s="${r.status}">
              ${r.status === 'active' ? 'Active' : 'Discontinued'}</button></td>`)).join('')}
          </table></div>${rows.length === 200 ? '<p class="muted small">First 200 shown — search to narrow down.</p>' : ''}`;
          wireEdits($('#res', view));
        };
        q.oninput = () => { clearTimeout(t); t = setTimeout(search, 300); };
        $('#dla', view).onclick = async () => {
          const all = [];
          for (let from = 0; ; from += 1000) {
            const part = await sb.from('items').select('name, pack_size, loose_per_strip, status').order('name').range(from, from + 999).then(check);
            all.push(...part);
            if (part.length < 1000) break;
          }
          downloadExcel('Item_master.xlsx', { Items: all.map((r) => ({ 'Item Name': r.name, 'Pack Size': r.pack_size,
            'Qty in Loose': r.loose_per_strip === null ? '' : Number(r.loose_per_strip), Status: r.status })) });
        };
        search();
      }
    }
    show('check');
  },
};
