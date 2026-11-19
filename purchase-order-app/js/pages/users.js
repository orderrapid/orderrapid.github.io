import { sb, check, state } from '../db.js';
import { esc, $$, toast, confirmBox, promptBox, fmtDate } from '../ui.js';

const ROLES = [
  ['pending', 'Waiting (no access)'],
  ['purchase', 'Purchase Team'],
  ['manager', 'Manager'],
  ['admin', 'Admin'],
];

export default {
  title: 'Users',
  roles: ['admin'],
  async render(el) {
    const rows = await sb.from('profiles').select('*').order('created_at').then(check);
    const waiting = rows.filter((r) => r.role === 'pending' && r.active).length;
    const admins = rows.filter((r) => r.role === 'admin' && r.active).length;
    el.innerHTML = `
      <h1>Users</h1>
      ${waiting ? `<div class="note warn"><b>${waiting}</b> new sign-up(s) waiting for a role.</div>` : ''}
      ${admins < 2 ? `<div class="note">Tip: give a second trusted person the Admin role, so someone can always reset passwords.</div>` : ''}
      <div class="card">
        <p class="muted">New people sign up from the login page, then you give them a role here.
          If someone forgets their password, use <b>Set password</b> and tell them the new one.</p>
        <div class="scroll"><table class="tbl">
          <tr><th>Name</th><th>Email</th><th>Joined</th><th>Role</th><th>Access</th><th></th></tr>
          ${rows.map((u) => {
            const me = u.user_id === state.profile.user_id;
            return `<tr data-id="${u.user_id}" class="${u.role === 'pending' ? 'flag' : ''}">
              <td>${esc(u.full_name)}${me ? ' <span class="muted">(you)</span>' : ''}</td>
              <td>${esc(u.email)}</td><td>${fmtDate(u.created_at)}</td>
              <td><select class="role" ${me ? 'disabled title="You can\'t change your own role"' : ''}>
                ${ROLES.map(([v, l]) => `<option value="${v}" ${u.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
              <td>${me ? 'On' : `<button class="btn ghost small act" data-a="${u.active}">${u.active ? 'On — block' : 'Blocked — allow'}</button>`}</td>
              <td><button class="btn ghost small pw">Set password</button></td></tr>`;
          }).join('')}
        </table></div>
      </div>`;

    $$('select.role', el).forEach((s) => (s.onchange = async () => {
      try { await sb.from('profiles').update({ role: s.value }).eq('user_id', s.closest('tr').dataset.id).then(check); toast('Role saved'); this.render(el); }
      catch (e) { toast(e.message, 'error'); }
    }));
    $$('button.act', el).forEach((b) => (b.onclick = async () => {
      const on = b.dataset.a === 'true';
      if (on && !(await confirmBox({ title: 'Block this user?', html: '<p>They will not be able to use the app until you allow them again.</p>', ok: 'Block', danger: true }))) return;
      await sb.from('profiles').update({ active: !on }).eq('user_id', b.closest('tr').dataset.id).then(check);
      this.render(el);
    }));
    $$('button.pw', el).forEach((b) => (b.onclick = async () => {
      const tr = b.closest('tr');
      const pw = await promptBox({ title: `New password for ${tr.children[1].textContent}`, label: 'At least 8 characters', type: 'text', ok: 'Set password' });
      if (!pw) return;
      try { await sb.rpc('admin_set_password', { p_user_id: tr.dataset.id, p_new_password: pw }).then(check); toast('Password set. Tell them the new password.'); }
      catch (e) { toast(e.message, 'error'); }
    }));
  },
};
