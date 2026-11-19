import { sb, check, state, isRole } from '../db.js';
import { esc, fmtDate, fmtDateTime, fmtNum, todayISO, daysBetween } from '../ui.js';

export default {
  title: 'Home',
  roles: ['admin', 'manager', 'purchase'],
  async render(el) {
    const [status, stockUps, toCheck] = await Promise.all([
      sb.rpc('sales_status').then(check),
      sb.from('stock_uploads').select('warehouse_id, created_at').order('created_at', { ascending: false }).limit(200).then(check),
      isRole('admin') ? sb.from('items_to_check').select('id', { count: 'exact', head: true }) : Promise.resolve({ count: null }),
    ]);
    const space = isRole('admin') ? await sb.rpc('db_space').then(check).catch(() => null) : null;
    const lastStock = {};
    for (const s of stockUps) if (!lastStock[s.warehouse_id]) lastStock[s.warehouse_id] = s.created_at;
    const today = todayISO();

    el.innerHTML = `
      <h1>Today at a glance</h1>
      <div class="grid">
        ${status.map((w) => {
          const behind = w.last_date ? daysBetween(w.last_date, today) : null;
          const tone = behind === null ? 'warn' : behind <= 1 ? 'good' : behind <= 3 ? 'warn' : 'bad';
          return `<div class="card wh">
            <h3>${esc(w.warehouse)}</h3>
            <div class="stat ${tone}">
              <span class="label">Sales uploaded up to</span>
              <span class="value">${w.last_date ? fmtDate(w.last_date) : 'Nothing yet'}</span>
              ${behind > 1 ? `<span class="hint">${behind - 1} day${behind - 1 === 1 ? '' : 's'} missing</span>` : ''}
            </div>
            <div class="stat">
              <span class="label">Stock last counted</span>
              <span class="value">${lastStock[w.warehouse_id] ? fmtDateTime(lastStock[w.warehouse_id]) : 'Nothing yet'}</span>
            </div>
          </div>`;
        }).join('')}
      </div>
      ${space ? (() => {
        const pct = Math.min(100, Math.round((space.used_mb / space.limit_mb) * 100));
        return `<div class="card"><div class="head-row"><h3>Database space used</h3><span class="${pct >= 80 ? 'pill failed' : pct >= 60 ? 'pill warn' : 'pill done'}">${pct}%</span></div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <p class="muted small">${fmtNum(space.used_mb, 1)} MB of ${fmtNum(space.limit_mb)} MB (free plan). Sales history: ${fmtNum(space.sales_mb, 1)} MB.
          ${pct >= 80 ? 'Time to summarise old sales or upgrade the plan — ask for help.' : ''}</p></div>`;
      })() : ''}
      <div class="card">
        <h3>What you can do</h3>
        <ul class="tasks">
          <li><a href="#/orders">Orders</a> — what to order now, Min / Max, too much stock, new medicines to decide on.</li>
          ${isRole('admin', 'manager') ? `<li><a href="#/sales">Upload sales</a> — new days only; the app skips anything already uploaded.</li>` : ''}
          ${isRole('admin', 'purchase') ? `<li><a href="#/stock">Upload stock</a> — Medicine Name, Pack Size, Stock in Loose. Converted to strips automatically.</li>` : ''}
          ${isRole('admin') ? `<li><a href="#/items">Item master</a> — ${toCheck.count ? `<b>${toCheck.count} items</b> have no conversion or a conversion that looks wrong.` : 'loose-per-strip conversions.'}</li>
          <li><a href="#/users">Users</a> — approve new sign-ups, set roles, reset passwords.</li>` : ''}
        </ul>
        <p class="muted small">Coming next: purchase upload and the overstock report (repeat orders, duplicate codes, pack sizes).</p>
      </div>`;
  },
};
