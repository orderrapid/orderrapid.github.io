import { sb, check, state, rememberWarehouse, warehouseName } from '../db.js';
import { recalculate } from '../levels.js';
import { dataTools } from '../datatools.js';
import { esc, $, fmtDate, fmtDateTime, fmtNum, toast, confirmBox, readExcel, warehouseOptions, addDays, downloadExcel } from '../ui.js';

const BATCH = 2500;

export default {
  title: 'Sales upload',
  roles: ['admin', 'manager'],
  async render(el) {
    el.innerHTML = `
      <h1>Sales upload</h1>
      <div class="card">
        <div class="form-row">
          <label class="field"><span>Warehouse</span>
            <select id="wh">${warehouseOptions(state.warehouses, state.warehouseId)}</select></label>
          <div class="field status-box" id="upto"></div>
        </div>
        <label class="drop" id="drop">
          <input type="file" id="file" accept=".xlsx,.xls,.csv" hidden>
          <b>Choose the sales Excel file</b>
          <span class="muted">or drag it here. Columns: Date, Sale Date Time, Bill No, Mobile No., Medicines Name, Pack Size, Total Quantity(Strip), Total Invoice Amount. Other columns are ignored.</span>
        </label>
        <p class="small"><a href="#" id="sample">Download sample format</a></p>
        <div id="work"></div>
      </div>
      <div class="card" id="dtools"></div>
      <div class="card"><h3>Recent uploads</h3><div id="history" class="loading">Loading…</div></div>`;

    const whSel = $('#wh', el);
    let status = [];
    const showStatus = async () => {
      status = await sb.rpc('sales_status').then(check);
      const s = status.find((x) => String(x.warehouse_id) === whSel.value);
      $('#upto', el).innerHTML = s?.last_date
        ? `<span class="label">${esc(s.warehouse)}: sales uploaded up to</span><span class="value">${fmtDate(s.last_date)}</span>
           <span class="hint">Next file should start from ${fmtDate(addDays(s.last_date, 1))}</span>`
        : `<span class="label">No sales uploaded yet for ${esc(warehouseName(whSel.value))}</span>
           <span class="hint">Your first file can hold the full history.</span>`;
    };
    whSel.onchange = () => { rememberWarehouse(whSel.value); showStatus(); $('#work', el).innerHTML = ''; };
    await showStatus();
    loadHistory(el);
    // after a delete: new "uploaded up to", and Min / Max from what is left
    dataTools($('#dtools', el), 'sales', async (whId) => {
      await showStatus();
      recalculate(whId).catch(() => { /* Orders recalculates when opened */ });
    });

    $('#sample', el).onclick = (e) => {
      e.preventDefault();
      downloadExcel('Sales_sample.xlsx', { Sales: [
        ['Date', 'Sale Date Time', 'Bill No', 'Mobile No.', 'Medicines Name', 'Pack Size', 'Total Quantity(Strip)', 'Total Invoice Amount'],
        ['08/11/2026', '08/11/2026 14:35:22', '2143', 9876543210, 'Dolo 650 Tablet', '15 Tablet', 2, 64.5],
      ] });
    };

    const fileInput = $('#file', el), drop = $('#drop', el);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); };
    fileInput.onchange = () => fileInput.files[0] && handle(fileInput.files[0]);

    async function handle(file) {
      const work = $('#work', el);
      work.innerHTML = `<div class="progress-line" id="pmsg">Reading ${esc(file.name)}…</div>`;
      let parsed;
      try {
        parsed = await readExcel(file, 'sales', (m) => { const p = $('#pmsg', el); if (p) p.textContent = m; });
      } catch (e) {
        work.innerHTML = `<div class="note error">${esc(e.message)}</div>`;
        fileInput.value = '';
        return;
      }
      const s = parsed.summary;
      const wh = whSel.value;
      const st = status.find((x) => String(x.warehouse_id) === wh);
      const warnings = [];
      if (!s.lines) warnings.push('No sales lines found in this file.');
      if (st?.last_date && s.firstDate > addDays(st.last_date, 1))
        warnings.push(`<b>Gap:</b> sales are uploaded up to ${fmtDate(st.last_date)} but this file starts on ${fmtDate(s.firstDate)}. ` +
          `${fmtDate(addDays(st.last_date, 1))} to ${fmtDate(addDays(s.firstDate, -1))} will be missing.`);
      if (st?.last_date && s.lastDate <= st.last_date)
        warnings.push(`Everything in this file is on or before ${fmtDate(st.last_date)}, which is already uploaded. Lines already saved will be skipped.`);
      if (s.problems) warnings.push(`${fmtNum(s.problems)} line(s) could not be read and will be left out (see below).`);
      if (s.lines && s.withTime < s.lines) warnings.push(s.withTime
        ? `${fmtNum(s.lines - s.withTime)} line(s) have no sale time. They still count, but not in hourly sales.`
        : 'No sale time found (column "Sale Date Time"). Sales will be saved, but hourly sales analysis won\'t include them.');
      if (s.noMobile) warnings.push(`${fmtNum(s.noMobile)} line(s) have no mobile number. They still count as sales, but not as a customer.`);
      const recentDays = s.perDay.slice(-7);

      work.innerHTML = `
        <h3>Check before saving</h3>
        <div class="kv">
          <div><span>Sheet</span><b>${esc(parsed.sheet)}</b></div>
          <div><span>Dates</span><b>${fmtDate(s.firstDate)} → ${fmtDate(s.lastDate)}</b> (${s.days} days)</div>
          <div><span>Sale lines</span><b>${fmtNum(s.lines)}</b></div>
          <div><span>Bills</span><b>${fmtNum(s.bills)}</b></div>
          <div><span>Different medicines</span><b>${fmtNum(s.medicines)}</b></div>
        </div>
        ${warnings.map((w) => `<div class="note warn">${w}</div>`).join('')}
        <details><summary>Lines per day (last ${recentDays.length} days in the file)</summary>
          <table class="tbl compact"><tr><th>Date</th><th class="num">Lines</th></tr>
          ${recentDays.map(([d, n]) => `<tr><td>${fmtDate(d)}</td><td class="num">${fmtNum(n)}</td></tr>`).join('')}</table>
        </details>
        ${parsed.problems.length ? `<details><summary>Lines that could not be read</summary>
          <table class="tbl compact"><tr><th>Excel row</th><th>Problem</th><th>Row</th></tr>
          ${parsed.problems.slice(0, 20).map((p) => `<tr><td>${p.row}</td><td>${esc(p.why)}</td><td class="small">${esc((p.value || []).join(' | '))}</td></tr>`).join('')}</table>
        </details>` : ''}
        <div class="row"><button class="btn primary" id="save" ${s.lines ? '' : 'disabled'}>Save to ${esc(warehouseName(wh))}</button>
          <button class="btn ghost" id="cancel">Cancel</button></div>
        <div id="prog"></div>`;

      $('#cancel', el).onclick = () => { work.innerHTML = ''; fileInput.value = ''; };
      $('#save', el).onclick = async () => {
        const ok = await confirmBox({
          title: 'Save these sales?',
          html: `<p>You are uploading <b>${fmtNum(s.lines)} lines</b> (${fmtDate(s.firstDate)} → ${fmtDate(s.lastDate)}) to</p>
                 <p class="big-name">${esc(warehouseName(wh))}</p><p class="muted">Is this the right warehouse?</p>`,
          ok: `Yes, save to ${warehouseName(wh)}`,
        });
        if (!ok) return;
        await save(file.name, wh, parsed.rows);
      };
    }

    async function save(fileName, wh, rows) {
      const prog = $('#prog', el);
      $('#save', el).disabled = true; $('#cancel', el).disabled = true; whSel.disabled = true;
      const uploadId = await sb.rpc('start_sales_upload', { p_warehouse_id: Number(wh), p_file_name: fileName }).then(check);
      const total = { saved: 0, already: 0, too_old: 0, skipped: 0 };
      try {
        for (let i = 0; i < rows.length; i += BATCH) {
          prog.innerHTML = `<div class="bar"><i style="width:${Math.round((i / rows.length) * 100)}%"></i></div>
            <p class="muted small">Saving… ${fmtNum(i)} of ${fmtNum(rows.length)} lines. Keep this page open.</p>`;
          const r = await retry(() => sb.rpc('import_sales_batch', { p_upload_id: uploadId, p_rows: rows.slice(i, i + BATCH) }).then(check));
          for (const k of Object.keys(total)) total[k] += r[k] || 0;
        }
        await sb.rpc('finish_sales_upload', { p_upload_id: uploadId, p_ok: true }).then(check);
      } catch (e) {
        await sb.rpc('finish_sales_upload', { p_upload_id: uploadId, p_ok: false });
        prog.innerHTML = `<div class="note error">Stopped: ${esc(e.message)}<br>Lines saved so far are kept. Upload the same file again — already-saved lines are skipped.</div>`;
        whSel.disabled = false;
        return;
      }
      whSel.disabled = false;
      prog.innerHTML = `<div class="note ok"><b>Saved.</b> ${fmtNum(total.saved)} new lines saved.
        ${total.already ? `${fmtNum(total.already)} were already uploaded and skipped.` : ''}
        ${total.too_old ? `${fmtNum(total.too_old)} were older than the history kept (Admin setting) and were not saved.` : ''}
        ${total.skipped ? `${fmtNum(total.skipped)} had zero/negative quantity (returns) and were left out.` : ''}</div>`;
      toast('Sales saved');
      // work out Min / Max again with the new sales
      const rc = document.createElement('p');
      rc.className = 'muted small';
      prog.appendChild(rc);
      try {
        const r = await recalculate(wh, (m) => (rc.textContent = `Updating Min / Max: ${m}`));
        rc.textContent = `Min / Max updated for ${fmtNum(r.count)} medicines (sales up to ${fmtDate(r.salesUpTo)}). Orders can use it now.`;
      } catch (e) {
        rc.textContent = `Sales are saved. Min / Max will update when someone opens Orders (${e.message}).`;
      }
      await showStatus();
      loadHistory(el);
    }
  },
};

async function retry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries || /not allowed|only admin/i.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 1500 * i)); }
  }
}

async function loadHistory(el) {
  const rows = await sb.from('sales_uploads')
    .select('id, warehouse_id, file_name, first_date, last_date, rows_saved, rows_already, status, created_at')
    .order('created_at', { ascending: false }).limit(15).then(check);
  const h = $('#history', el);
  if (!h) return;
  h.classList.remove('loading');
  h.innerHTML = rows.length ? `<div class="scroll"><table class="tbl">
    <tr><th>When</th><th>Warehouse</th><th>File</th><th>Dates in file</th><th class="num">New lines</th><th class="num">Skipped (already)</th><th>Status</th></tr>
    ${rows.map((r) => `<tr><td>${fmtDateTime(r.created_at)}</td><td>${esc(warehouseName(r.warehouse_id))}</td>
      <td>${esc(r.file_name)}</td><td>${fmtDate(r.first_date)} → ${fmtDate(r.last_date)}</td>
      <td class="num">${fmtNum(r.rows_saved)}</td><td class="num">${fmtNum(r.rows_already)}</td>
      <td><span class="pill ${r.status}">${r.status}</span></td></tr>`).join('')}
  </table></div>` : '<p class="muted">No uploads yet.</p>';
}
