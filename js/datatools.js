// "Download / delete" box on the Sales upload and Purchases screens.
// Download: Admin, Manager. Delete: Admin only, after a preview and typing the warehouse name.
import { sb, check, state, isRole, warehouseName } from './db.js';
import { esc, $, fmtDate, fmtNum, toast, warehouseOptions, addDays, todayISO, downloadExcel } from './ui.js';

const KIND = {
  sales: {
    label: 'sales',
    head: ['Date', 'Sale Time', 'Bill No', 'Mobile No.', 'Medicines Name', 'Pack Size', 'Total Quantity(Strip)', 'Total Invoice Amount'],
    num: [6, 7],
  },
  purchases: {
    label: 'purchases',
    head: ['DATE', 'BILL NO', 'DISTRIBUTOR NAME', 'MEDICINE NAME', 'PACK SIZE', 'INV AMOUNT', 'QTY'],
    num: [5, 6],
  },
};

// split a date range into pieces of about a month, so big ranges stay quick
function chunks(from, to) {
  const out = [];
  for (let a = from; a <= to; ) {
    const b = addDays(a, 30) < to ? addDays(a, 30) : to;
    out.push([a, b]); a = addDays(b, 1);
  }
  return out;
}

export function dataTools(box, kind, onChanged) {
  const K = KIND[kind];
  const canDelete = isRole('admin');
  if (!isRole('admin', 'manager')) { box.remove(); return; }
  box.innerHTML = `
    <h3>Download ${canDelete ? 'or delete ' : ''}${K.label}</h3>
    <p class="muted small">Pick a warehouse and dates. The download has the same columns as the upload file${kind === 'sales' ? ', including mobile numbers' : ''}.
      ${canDelete ? 'Delete is for wrong uploads: it cannot be undone, so download first.' : ''}</p>
    <div class="filters">
      <label class="small">Warehouse <select class="dt-wh">${warehouseOptions(state.warehouses, state.warehouseId)}</select></label>
      <label class="small">From <input type="date" class="dt-from"></label>
      <label class="small">To <input type="date" class="dt-to"></label>
      <button class="btn small dt-dl">Download Excel</button>
      ${canDelete ? '<button class="btn danger small dt-del">Delete…</button>' : ''}
    </div>
    <div class="dt-msg"></div>`;
  const wh = $('.dt-wh', box), from = $('.dt-from', box), to = $('.dt-to', box), msg = $('.dt-msg', box);
  to.value = todayISO(); from.value = addDays(todayISO(), -29);

  const range = () => {
    if (!from.value || !to.value || from.value > to.value) { toast('Check the From and To dates', 'error'); return null; }
    return { id: Number(wh.value), name: warehouseName(wh.value), from: from.value, to: to.value };
  };

  async function download(r, btn) {
    const old = btn.textContent; btn.disabled = true;
    try {
      const rows = [];
      const parts = chunks(r.from, r.to);
      for (let i = 0; i < parts.length; i++) {
        btn.textContent = `Preparing… ${Math.round((i / parts.length) * 100)}%`;
        const got = await sb.rpc('export_data', { p_kind: kind, p_warehouse_id: r.id, p_from: parts[i][0], p_to: parts[i][1] }).then(check);
        // real Excel dates (local midnight), numbers as numbers
        for (const a of got) rows.push(a.map((v, j) => (j === 0 && v ? new Date(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10))
          : K.num.includes(j) && v !== null ? Number(v) : v ?? '')));
      }
      if (!rows.length) { toast(`No ${K.label} for ${r.name} in these dates`); return false; }
      await downloadExcel(`${r.name} ${K.label} ${r.from} to ${r.to}.xlsx`, { [K.label]: [K.head, ...rows] });
      toast(`${fmtNum(rows.length)} lines downloaded`);
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  $('.dt-dl', box).onclick = (e) => { const r = range(); if (r) download(r, e.target); };
  const del = $('.dt-del', box);
  if (del) del.onclick = async () => {
    const r = range(); if (!r) return;
    let p;
    try { p = await sb.rpc('data_preview', { p_kind: kind, p_warehouse_id: r.id, p_from: r.from, p_to: r.to }).then(check); }
    catch (e) { toast(e.message, 'error'); return; }
    if (!p.lines) { msg.innerHTML = `<div class="note">No ${K.label} saved for ${esc(r.name)} from ${fmtDate(r.from)} to ${fmtDate(r.to)}.</div>`; return; }
    confirmDelete(r, p);
  };

  function confirmDelete(r, p) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <form class="modal">
        <h3>Delete ${K.label}?</h3>
        <div class="note error">This removes, for <b>${esc(r.name)}</b>, ${fmtDate(p.first)} to ${fmtDate(p.last)}:<br>
          <b>${fmtNum(p.lines)}</b> lines · <b>${fmtNum(p.bills)}</b> bills · <b>${fmtNum(p.qty)}</b> strips · <b>₹${fmtNum(p.amount)}</b><br>
          It cannot be undone.</div>
        <p><button type="button" class="btn ghost small" data-a="dl">Download these ${K.label} first</button></p>
        ${kind === 'sales' ? '<p class="muted small">Orders, purchases, stock, customers and the item master are not touched. Min / Max is worked out again.</p>'
          : '<p class="muted small">Sales, stock and orders are not touched. Orders already marked received stay received.</p>'}
        <label class="field"><span>Type <b>${esc(r.name)}</b> to confirm</span><input name="c" autocomplete="off"></label>
        <div class="modal-actions"><button type="button" class="btn ghost" data-a="no">Cancel</button>
          <button class="btn danger" disabled>Delete</button></div>
        <div class="dt-prog"></div>
      </form>`;
    document.body.appendChild(wrap);
    const f = $('form', wrap), go = $('button.danger', f);
    f.c.oninput = () => { go.disabled = f.c.value.trim().toLowerCase() !== r.name.trim().toLowerCase(); };
    $('[data-a="no"]', f).onclick = () => wrap.remove();
    $('[data-a="dl"]', f).onclick = (e) => download(r, e.target);
    f.onsubmit = async (e) => {
      e.preventDefault();
      go.disabled = true; $('[data-a="no"]', f).disabled = true;
      let lines = 0, amount = 0;
      const parts = chunks(r.from, r.to);
      try {
        for (let i = 0; i < parts.length; i++) {
          $('.dt-prog', f).innerHTML = `<div class="progress-line">Deleting… ${Math.round((i / parts.length) * 100)}%</div>`;
          const d = await sb.rpc('delete_data', { p_kind: kind, p_warehouse_id: r.id, p_from: parts[i][0], p_to: parts[i][1], p_confirm: f.c.value }).then(check);
          lines += d.lines; amount += Number(d.amount);
        }
        wrap.remove();
        msg.innerHTML = `<div class="note ok"><b>Deleted</b> ${fmtNum(lines)} ${K.label} lines (₹${fmtNum(amount)}) for ${esc(r.name)}, ${fmtDate(r.from)} to ${fmtDate(r.to)}.
          ${kind === 'sales' ? 'You can now upload the correct file.' : 'You can now upload the correct purchase file.'}</div>`;
        toast('Deleted');
        onChanged?.(r.id);
      } catch (err) {
        $('.dt-prog', f).innerHTML = `<div class="note error">Stopped: ${esc(err.message)}${lines ? ` (${fmtNum(lines)} lines were already deleted — run Delete again to finish)` : ''}</div>`;
        $('[data-a="no"]', f).disabled = false;
      }
    };
  }
}
