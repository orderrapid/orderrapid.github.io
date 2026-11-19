import { sb, check, loadWarehouses } from '../db.js';
import { esc, $, $$, toast, confirmBox, fmtDate } from '../ui.js';

export default {
  title: 'Warehouses',
  roles: ['admin'],
  async render(el) {
    const rows = await sb.from('warehouses').select('*').order('name').then(check);
    el.innerHTML = `
      <h1>Warehouses</h1>
      <div class="card">
        <form id="add" class="row">
          <input name="name" placeholder="New warehouse name" required>
          <button class="btn primary">Add warehouse</button>
        </form>
        <p class="muted small">A new warehouse shows up straight away in sales upload, stock and reports.
          Switching one off hides it everywhere but keeps its history.</p>
        <table class="tbl">
          <tr><th>Name</th><th>Added</th><th>Status</th><th></th></tr>
          ${rows.map((w) => `<tr data-id="${w.id}">
            <td><input class="name" value="${esc(w.name)}"></td>
            <td>${fmtDate(w.created_at)}</td>
            <td>${w.active ? '<span class="pill done">In use</span>' : '<span class="pill">Switched off</span>'}</td>
            <td><button class="btn ghost small tog" data-a="${w.active}">${w.active ? 'Switch off' : 'Switch on'}</button></td></tr>`).join('')}
        </table>
      </div>`;

    const reload = async () => { await loadWarehouses(); location.reload(); };
    $('#add', el).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await sb.from('warehouses').insert({ name: e.target.name.value.trim() }).then(check);
        toast('Warehouse added'); reload();
      } catch (err) { toast(/duplicate/.test(err.message) ? 'That name already exists' : err.message, 'error'); }
    };
    $$('input.name', el).forEach((inp) => (inp.onchange = async () => {
      try { await sb.from('warehouses').update({ name: inp.value.trim() }).eq('id', inp.closest('tr').dataset.id).then(check); toast('Renamed'); await loadWarehouses(); }
      catch (err) { toast(err.message, 'error'); }
    }));
    $$('button.tog', el).forEach((b) => (b.onclick = async () => {
      const on = b.dataset.a === 'true';
      if (on && !(await confirmBox({ title: 'Switch off this warehouse?', html: '<p>It will be hidden from uploads and reports. History is kept and you can switch it back on.</p>', ok: 'Switch off', danger: true }))) return;
      await sb.from('warehouses').update({ active: !on }).eq('id', b.closest('tr').dataset.id).then(check);
      reload();
    }));
  },
};
