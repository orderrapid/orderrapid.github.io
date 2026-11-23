// Small helpers shared by every screen.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// '2026-11-08' -> '8 Nov 2026'
export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const h = d.getHours(), mi = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${((h + 11) % 12) + 1}:${mi} ${h < 12 ? 'AM' : 'PM'}`;
}

export const fmtNum = (n, dp = 0) =>
  n === null || n === undefined || n === '' ? '—' :
  Number(n).toLocaleString('en-IN', { maximumFractionDigits: dp, minimumFractionDigits: 0 });

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export function addDays(iso, n) {
  const d = new Date(Date.parse(iso) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

let toastTimer;
export function toast(msg, kind = 'ok') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.className = `toast ${kind}`;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 7000 : 3500);
}

// A simple confirm box that can show HTML (used for "you are uploading to X").
export function confirmBox({ title, html, ok = 'Continue', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <div class="modal-body">${html}</div>
        <div class="modal-actions">
          <button class="btn ghost" data-a="no">${esc(cancel)}</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${esc(ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) done(false);
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a) done(a === 'yes');
    });
    $('[data-a="yes"]', wrap).focus();
  });
}

// Ask for one value in a box (used for setting a password).
export function promptBox({ title, label, type = 'text', ok = 'Save', value = '' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <form class="modal">
        <h3>${esc(title)}</h3>
        <label class="field"><span>${esc(label)}</span><input name="v" type="${type}" required autocomplete="off" value="${esc(value)}"></label>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-a="no">Cancel</button>
          <button class="btn primary">${esc(ok)}</button>
        </div>
      </form>`;
    document.body.appendChild(wrap);
    const form = $('form', wrap);
    $('input', wrap).focus();
    $('[data-a="no"]', wrap).onclick = () => { wrap.remove(); resolve(null); };
    form.onsubmit = (e) => { e.preventDefault(); const v = form.v.value; wrap.remove(); resolve(v); };
  });
}

// Read an Excel file in a background worker so the page doesn't freeze
// on big files (a year of sales is ~20 MB).
export function readExcel(file, kind, onStatus) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./excel-worker.js', import.meta.url), { type: 'module' });
    onStatus?.('Reading file…');
    worker.onmessage = (e) => {
      if (e.data.status) return onStatus?.(e.data.status);
      worker.terminate();
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result);
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Could not read the file')); };
    file.arrayBuffer().then((buf) => worker.postMessage({ buf, kind }, [buf]));
  });
}

// Download rows as an .xlsx file.
export async function downloadExcel(fileName, sheets) {
  const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = Array.isArray(rows[0]) ? XLSX.utils.aoa_to_sheet(rows) : XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  XLSX.writeFile(wb, fileName);
}

export function warehouseOptions(warehouses, selected) {
  return warehouses.map((w) =>
    `<option value="${w.id}" ${String(w.id) === String(selected) ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
}
