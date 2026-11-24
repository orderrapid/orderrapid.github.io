import { sb, check, state, rememberWarehouse, warehouseName } from '../db.js';
import { buildReport } from '../repeats.js';
import { dataTools } from '../datatools.js';
import { bnsCard } from '../bns.js';
import { loadSettings } from '../levels.js';
import { esc, $, $$, fmtDate, fmtDateTime, fmtNum, toast, confirmBox, readExcel, warehouseOptions, downloadExcel, todayISO, addDays } from '../ui.js';

const BATCH = 2500;

export default {
  title: 'Purchases',
  roles: ['admin', 'manager', 'purchase'],
  async render(el) {
    el.classList.add('wide-page');
    el.innerHTML = `
      <h1>Purchases</h1>
      <div class="card">
        <div class="form-row">
          <label class="field"><span>Warehouse</span><select id="wh">${warehouseOptions(state.warehouses, state.warehouseId)}</select></label>
          <div class="field status-box" id="upto"></div>
        </div>
        <label class="drop" id="drop"><input type="file" id="file" accept=".xlsx,.xls,.csv" hidden>
          <b>Upload purchase Excel</b>
          <span class="muted">Columns: Date, Bill No, Distributor Name, Medicine Name, Pack Size, Inv Amount, Qty (strips, including free).
            Lines already uploaded are skipped. A Bill No that matches an order's invoice / challan no. marks that order received.</span></label>
        <p class="small"><a href="#" id="sample">Download sample format</a></p>
        <div id="work"></div>
        <div class="field status-box" id="rupto"></div>
        <label class="drop" id="rdrop"><input type="file" id="rfile" accept=".xlsx,.xls,.csv" hidden>
          <b>Upload purchase returns Excel</b>
          <span class="muted">Columns: Date, Reference No, Distributor, Medicines Name, Pack Size, Total Quantity (loose units, e.g. tablets —
            turned into strips with the Strips sheet). Lines already uploaded are skipped.</span></label>
        <div id="rwork"></div>
      </div>
      <div class="card">
        <div class="filters">
          <div class="tabs-inline" id="rtabs" style="margin:0;border:0">
            <button class="tab on" data-r="same">Same-day repeats <span class="count" data-c="same"></span></button>
            <button class="tab" data-r="multi">Repeats within <span id="rdays">3</span> days <span class="count" data-c="multi"></span></button>
            <button class="tab" data-r="settled">Settled by a return <span class="count" data-c="settled"></span></button>
            <button class="tab" data-r="returns">Returns by distributor</button>
          </div>
          <label class="small">From <input type="date" id="rf" value="${addDays(todayISO(), -7)}"></label>
          <label class="small">To <input type="date" id="rt" value="${todayISO()}"></label>
          <input type="search" id="rq" placeholder="Search medicine…">
          <button class="btn ghost small" id="rdl">Download Excel</button>
        </div>
        <div id="report"><div class="loading">Loading…</div></div>
      </div>
      <div class="card" id="bns"></div>
      <div class="card" id="dtools"></div>`;

    const whSel = $('#wh', el);
    let status = [], rep = { same: [], multi: [], settled: [] }, rtab = 'same', retRep = null, retQuick = 7;
    const showStatus = async () => {
      status = await sb.rpc('purchase_status').then(check);
      const s = status.find((x) => String(x.warehouse_id) === whSel.value);
      $('#upto', el).innerHTML = s?.last_date
        ? `<span class="label">${esc(s.warehouse)}: purchases uploaded up to</span><span class="value">${fmtDate(s.last_date)}</span>`
        : `<span class="label">No purchases uploaded yet for ${esc(warehouseName(whSel.value))}</span>`;
    };
    let loadBns = () => {};
    const showRetStatus = async () => {
      let rs = [];
      try { rs = await sb.rpc('returns_status').then(check); } catch { /* database not updated yet */ }
      const r = rs.find((x) => String(x.warehouse_id) === whSel.value);
      $('#rupto', el).innerHTML = r?.last_date
        ? `<span class="label">${esc(warehouseName(whSel.value))}: purchase returns uploaded up to</span><span class="value">${fmtDate(r.last_date)}</span>`
        : `<span class="label">No purchase returns uploaded yet for ${esc(warehouseName(whSel.value))}</span>`;
    };
    whSel.onchange = () => { rememberWarehouse(whSel.value); $('#work', el).innerHTML = ''; $('#rwork', el).innerHTML = ''; showStatus(); showRetStatus(); loadReport(); loadBns(); };
    dataTools($('#dtools', el), 'purchases', () => { showStatus(); loadReport(); loadBns(); });

    $('#sample', el).onclick = (e) => {
      e.preventDefault();
      downloadExcel('Purchase_sample.xlsx', { Purchase: [
        ['Date', 'Bill No', 'Distributor Name', 'Medicine Name', 'Pack Size', 'Inv Amount', 'Qty'],
        ['20/11/2026', 'INV-889', 'M/s Jai Medical Agency', 'Dolo 650 Tablet', '15 Tablet', 300, 10],
      ] });
    };

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
      try { parsed = await readExcel(file, 'purchase'); }
      catch (e) { work.innerHTML = `<div class="note error">${esc(e.message)}</div>`; fileInput.value = ''; return; }
      const s = parsed.summary, wh = whSel.value;
      const st = status.find((x) => String(x.warehouse_id) === wh);
      const warn = [];
      if (st?.last_date && s.lastDate <= st.last_date) warn.push(`Everything in this file is on or before ${fmtDate(st.last_date)}, which is already uploaded. Lines already saved will be skipped.`);
      if (s.problems) warn.push(`${s.problems} line(s) could not be read and will be left out.`);
      work.innerHTML = `<h3>Check before saving</h3>
        <div class="kv"><div><span>Sheet</span><b>${esc(parsed.sheet)}</b></div>
          <div><span>Dates</span><b>${fmtDate(s.firstDate)} → ${fmtDate(s.lastDate)}</b></div>
          <div><span>Lines</span><b>${fmtNum(s.lines)}</b></div><div><span>Bills</span><b>${fmtNum(s.bills)}</b></div><div><span>Arrival time</span><b>${s.withArrival ? `${fmtNum(s.withArrival)} lines` : 'not in file'}</b></div>
          <div><span>Distributors</span><b>${fmtNum(s.distributors)}</b></div></div>
        ${warn.map((w) => `<div class="note warn">${w}</div>`).join('')}
        ${parsed.problems.length ? `<details><summary>Lines that could not be read</summary><table class="tbl compact">
          ${parsed.problems.slice(0, 20).map((p) => `<tr><td>${p.row}</td><td>${esc(p.why)}</td><td class="small">${esc((p.value || []).join(' | '))}</td></tr>`).join('')}</table></details>` : ''}
        <div class="row"><button class="btn primary" id="save" ${s.lines ? '' : 'disabled'}>Save to ${esc(warehouseName(wh))}</button>
          <button class="btn ghost" id="cancel">Cancel</button></div><div id="prog"></div>`;
      $('#cancel', el).onclick = () => { work.innerHTML = ''; fileInput.value = ''; };
      $('#save', el).onclick = async () => {
        if (!(await confirmBox({ title: 'Save these purchases?', html: `<p>${fmtNum(s.lines)} lines (${fmtDate(s.firstDate)} → ${fmtDate(s.lastDate)}) to</p>
          <p class="big-name">${esc(warehouseName(wh))}</p><p class="muted">Is this the right warehouse?</p>`, ok: `Yes, ${warehouseName(wh)}` }))) return;
        $('#save', el).disabled = true;
        const prog = $('#prog', el);
        const id = await sb.rpc('start_purchase_upload', { p_warehouse_id: Number(wh), p_file_name: file.name }).then(check);
        const tot = { saved: 0, already: 0, skipped: 0, matched: 0 };
        try {
          for (let i = 0; i < parsed.rows.length; i += BATCH) {
            prog.innerHTML = `<div class="bar"><i style="width:${Math.round((i / parsed.rows.length) * 100)}%"></i></div>`;
            const r = await sb.rpc('import_purchase_batch', { p_upload_id: id, p_rows: parsed.rows.slice(i, i + BATCH) }).then(check);
            for (const k of Object.keys(tot)) tot[k] += r[k] || 0;
          }
          await sb.rpc('finish_purchase_upload', { p_upload_id: id, p_ok: true }).then(check);
        } catch (e) {
          await sb.rpc('finish_purchase_upload', { p_upload_id: id, p_ok: false });
          prog.innerHTML = `<div class="note error">Stopped: ${esc(e.message)}. Lines saved so far are kept; upload the same file again to finish.</div>`;
          return;
        }
        prog.innerHTML = `<div class="note ok"><b>Saved.</b> ${fmtNum(tot.saved)} new purchase lines.
          ${tot.already ? `${fmtNum(tot.already)} were already uploaded and skipped.` : ''}
          ${tot.skipped ? `${fmtNum(tot.skipped)} had no quantity and were left out.` : ''}
          ${tot.matched ? `<br><b>${tot.matched}</b> app order(s) matched by bill no. and marked received; anything missing from the bill is marked bounced.` : ''}</div>`;
        toast('Purchases saved');
        fileInput.value = '';
        showStatus(); loadReport(); loadBns();
      };
    }

    // ---------------- repeat report ----------------
    $$('#rtabs .tab', el).forEach((b) => (b.onclick = () => {
      rtab = b.dataset.r; $$('#rtabs .tab', el).forEach((x) => x.classList.toggle('on', x === b)); paintReport();
    }));
    $('#rf', el).onchange = loadReport;
    $('#rt', el).onchange = loadReport;
    $('#rq', el).oninput = paintReport;

    async function loadReport() {
      const box = $('#report', el);
      box.innerHTML = '<div class="loading">Loading…</div>';
      const from = $('#rf', el).value, to = $('#rt', el).value;
      const data = await sb.rpc('purchase_report_data', { p_warehouse_id: Number(whSel.value), p_from: from, p_to: to }).then(check);
      rep = buildReport(data, from, to);
      retQuick = data.return_days || 7; retRep = null;
      $('#rdays', el).textContent = data.repeat_days;
      $('[data-c="same"]', el).textContent = `(${rep.same.length})`;
      $('[data-c="multi"]', el).textContent = `(${rep.multi.length})`;
      $('[data-c="settled"]', el).textContent = `(${rep.settled.length})`;
      paintReport();
    }

    function paintReport() {
      const q = $('#rq', el).value.trim().toLowerCase();
      const box = $('#report', el);
      if (rtab === 'returns') return paintReturns(box, q);
      const list = rep[rtab].filter((r) => !q || r.name.toLowerCase().includes(q));
      box.innerHTML = `<p class="muted small">${rtab === 'same'
          ? 'The same medicine bought on more than one bill on the same day.'
          : rtab === 'multi' ? `The same medicine bought again within ${esc($('#rdays', el).textContent)} days (on different days). Same-day repeats are in the other tab.`
          : `Repeats where the extra purchase was sent back within ${retQuick} days — what was kept is no more than one purchase. Shown for the record; no action needed.`}
          Biggest extra first. "Kept" = bought − returned within ${retQuick} days. "Extra over Max" = kept − the Max stock the app works out for this medicine.</p>
        ${list.length ? `<div class="scroll"><table class="tbl">
          <tr><th>Medicine</th><th>Group</th><th>Purchases</th><th class="num">Total bought</th><th class="num">Returned</th><th class="num">Kept</th><th class="num">Max</th><th class="num">Extra over Max</th><th class="num">Sold (period)</th><th>Likely cause</th></tr>
          ${list.slice(0, 500).map((r) => `<tr><td class="med"><b>${esc(r.name)}</b> <span class="muted">${esc(r.pack)}</span></td><td>${esc(r.grp || '')}</td>
            <td class="small">${r.buys.map((b) => `${fmtDate(b.date)} · ${esc(b.dist)} · bill ${esc(b.bill)} · <b>${fmtNum(b.qty, 2)}</b>`).join('<br>')}</td>
            <td class="num">${fmtNum(r.total, 2)}</td><td class="num">${r.returned ? `<span class="bounce-text">−${fmtNum(r.returned, 2)}</span>` : ''}</td>
            <td class="num"><b>${fmtNum(r.kept, 2)}</b></td><td class="num">${r.max == null ? '—' : fmtNum(r.max)}</td>
            <td class="num">${r.extra > 0 ? `<b class="bounce-text">${fmtNum(r.extra, 2)}</b>` : '0'}</td><td class="num">${fmtNum(r.sold, 2)}</td>
            <td>${r.causes.map((c) => `<div class="cause">${esc(c)}</div>`).join('')}</td></tr>`).join('')}
        </table></div>${list.length > 500 ? '<p class="muted small">First 500 shown — download for all.</p>' : ''}`
        : '<p class="muted">No repeats in these dates.</p>'}`;
    }

    $('#rdl', el).onclick = () => {
      const flat = (list) => list.flatMap((r) => r.buys.map((b, i) => ({
        'Medicine Name': r.name, 'Pack Size': r.pack, Group: r.grp || '', Date: b.date, Distributor: b.dist, 'Bill No': b.bill, Qty: Number(b.qty),
        'Total bought': i ? '' : r.total, Returned: i ? '' : r.returned, Kept: i ? '' : r.kept, Max: i ? '' : (r.max ?? ''), 'Extra over Max': i ? '' : r.extra, 'Sold (period)': i ? '' : r.sold,
        'Likely cause': i ? '' : r.causes.join('; '),
      })));
      downloadExcel(`Repeat purchases ${warehouseName(whSel.value)} ${$('#rf', el).value} to ${$('#rt', el).value}.xlsx`,
        { 'Same-day': flat(rep.same), [`Within ${$('#rdays', el).textContent} days`]: flat(rep.multi), 'Settled by return': flat(rep.settled),
          ...(retRep ? { 'Returns by distributor': retRep.rows.map((d) => ({ Distributor: d.dist, 'Return challans': d.challans, Lines: d.lines,
            'Strips returned': Number(d.strips), [`Returned within ${retRep.quick_days} days of buying`]: Number(d.quick_strips),
            'Strips bought': Number(d.bought), 'Returned % of bought': Number(d.bought) ? +((100 * d.strips) / d.bought).toFixed(1) : '' })) } : {}) });
    };

    // ---------------- returns by distributor ----------------
    async function paintReturns(box, q) {
      if (!retRep) {
        box.innerHTML = '<div class="loading">Loading…</div>';
        try { retRep = await sb.rpc('returns_report', { p_warehouse_id: Number(whSel.value), p_from: $('#rf', el).value, p_to: $('#rt', el).value }).then(check); }
        catch (e) { box.innerHTML = `<div class="note error">${esc(e.message)}</div>`; return; }
      }
      const rows = retRep.rows.filter((d) => !q || d.dist.toLowerCase().includes(q) || (d.top || []).some((t) => t.name.toLowerCase().includes(q)));
      box.innerHTML = `<p class="muted small">Purchase returns in these dates, by distributor. "Quick" = sent back within ${retRep.quick_days} days of buying the medicine
          (usually a wrong or extra order); the rest are mostly expiry / breakage. Click a distributor to see every line.</p>
        ${rows.length ? `<div class="scroll"><table class="tbl">
          <tr><th>Distributor</th><th class="num">Return challans</th><th class="num">Lines</th><th class="num">Strips returned</th><th class="num">Quick returns</th>
            <th class="num">Strips bought</th><th class="num">Returned %</th><th>Most returned</th></tr>
          ${rows.map((d, i) => `<tr class="click" data-i="${i}"><td><b>${esc(d.dist)}</b>${d.no_conv ? `<div class="small muted">${d.no_conv} line(s) without strip conversion</div>` : ''}</td>
            <td class="num">${fmtNum(d.challans)}</td><td class="num">${fmtNum(d.lines)}</td><td class="num"><b>${fmtNum(d.strips, 2)}</b></td>
            <td class="num">${Number(d.quick_strips) ? `<span class="bounce-text">${fmtNum(d.quick_strips, 2)}</span>` : ''}</td>
            <td class="num">${fmtNum(d.bought, 2)}</td><td class="num">${Number(d.bought) ? `${((100 * d.strips) / d.bought).toFixed(1)}%` : '—'}</td>
            <td class="small">${(d.top || []).slice(0, 3).map((t) => `${esc(t.name)} (${fmtNum(t.strips, 2)})`).join('<br>')}</td></tr>`).join('')}
        </table></div><div id="retl"></div>` : '<p class="muted">No purchase returns uploaded for these dates.</p>'}`;
      $$('tr.click', box).forEach((tr) => (tr.onclick = () => {
        const d = rows[Number(tr.dataset.i)];
        $('#retl', box).innerHTML = `<h4>${esc(d.dist)} — ${d.lines} line(s)</h4><div class="scroll"><table class="tbl compact">
          <tr><th>Date</th><th>Ref</th><th>Medicine</th><th class="num">Loose</th><th class="num">Strips</th><th></th></tr>
          ${d.lines_list.map((x) => `<tr><td class="nowrap">${fmtDate(x.date)}</td><td>${esc(x.ref)}</td><td>${esc(x.name)} <span class="muted">${esc(x.pack)}</span></td>
            <td class="num">${fmtNum(x.loose, 2)}</td><td class="num">${x.strips == null ? '<span class="pill warn">no conversion</span>' : fmtNum(x.strips, 2)}</td>
            <td>${x.quick ? `<span class="pill warn">quick</span>` : ''}</td></tr>`).join('')}</table></div>`;
      }));
    }

    // ---------------- purchase returns upload ----------------
    const rIn = $('#rfile', el), rDrop = $('#rdrop', el);
    rDrop.ondragover = (e) => { e.preventDefault(); rDrop.classList.add('over'); };
    rDrop.ondragleave = () => rDrop.classList.remove('over');
    rDrop.ondrop = (e) => { e.preventDefault(); rDrop.classList.remove('over'); if (e.dataTransfer.files[0]) handleReturns(e.dataTransfer.files[0]); };
    rIn.onchange = () => rIn.files[0] && handleReturns(rIn.files[0]);
    async function handleReturns(file) {
      const work = $('#rwork', el), wh = whSel.value;
      work.innerHTML = `<div class="progress-line">Reading ${esc(file.name)}…</div>`;
      let parsed;
      try { parsed = await readExcel(file, 'returns'); }
      catch (e) { work.innerHTML = `<div class="note error">${esc(e.message)}</div>`; rIn.value = ''; return; }
      const s = parsed.summary;
      work.innerHTML = `<h3>Check before saving</h3>
        <div class="kv"><div><span>Sheet</span><b>${esc(parsed.sheet)}</b></div><div><span>Dates</span><b>${fmtDate(s.firstDate)} → ${fmtDate(s.lastDate)}</b></div>
          <div><span>Lines</span><b>${fmtNum(s.lines)}</b></div><div><span>Return challans</span><b>${fmtNum(s.refs)}</b></div><div><span>Distributors</span><b>${fmtNum(s.distributors)}</b></div></div>
        ${s.problems ? `<div class="note warn">${s.problems} line(s) could not be read and will be left out.</div>` : ''}
        <div class="row"><button class="btn primary" id="rsave" ${s.lines ? '' : 'disabled'}>Save returns to ${esc(warehouseName(wh))}</button>
          <button class="btn ghost" id="rcancel">Cancel</button></div><div id="rprog"></div>`;
      $('#rcancel', el).onclick = () => { work.innerHTML = ''; rIn.value = ''; };
      $('#rsave', el).onclick = async () => {
        if (!(await confirmBox({ title: 'Save these purchase returns?', html: `<p>${fmtNum(s.lines)} lines (${fmtDate(s.firstDate)} → ${fmtDate(s.lastDate)}) to</p>
          <p class="big-name">${esc(warehouseName(wh))}</p><p class="muted">Is this the right warehouse?</p>`, ok: `Yes, ${warehouseName(wh)}` }))) return;
        $('#rsave', el).disabled = true;
        const prog = $('#rprog', el), tot = { saved: 0, already: 0, skipped: 0, no_conversion: 0 };
        let up = null;
        try {
          for (let i = 0; i < parsed.rows.length; i += 5000) {
            prog.innerHTML = `<div class="bar"><i style="width:${Math.round((i / parsed.rows.length) * 100)}%"></i></div>`;
            const r = await sb.rpc('import_purchase_returns', { p_warehouse_id: Number(wh), p_upload_id: up, p_file: file.name, p_rows: parsed.rows.slice(i, i + 5000) }).then(check);
            up = r.upload_id;
            for (const k of Object.keys(tot)) tot[k] += r[k] || 0;
          }
        } catch (e) {
          prog.innerHTML = `<div class="note error">Stopped: ${esc(e.message)}. Lines saved so far are kept; upload the same file again to finish.</div>`;
          return;
        }
        prog.innerHTML = `<div class="note ok"><b>Saved.</b> ${fmtNum(tot.saved)} new return lines.
          ${tot.already ? `${fmtNum(tot.already)} were already uploaded and skipped.` : ''}
          ${tot.no_conversion ? `<br>${fmtNum(tot.no_conversion)} line(s) are for medicines with no strip conversion — they count as 0 strips until fixed in Item master → Needs checking.` : ''}</div>`;
        toast('Purchase returns saved');
        rIn.value = '';
        showRetStatus(); loadReport(); loadBns();
      };
    }

    await showStatus();
    showRetStatus();
    loadReport();
    loadBns = bnsCard($('#bns', el), () => whSel.value, await loadSettings());
    loadBns();
  },
};

