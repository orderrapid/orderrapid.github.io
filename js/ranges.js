// "Uploaded: 1 Aug 2026 → 22 Nov 2026 · 22,466 lines" + days with nothing uploaded
import { sb, check } from './db.js';
import { esc, fmtDate, fmtNum } from './ui.js';

export async function rangeHtml(kind, warehouseId) {
  let r;
  try { r = await sb.rpc('upload_range', { p_kind: kind, p_warehouse_id: Number(warehouseId) }).then(check); }
  catch { return ''; }   // database not updated yet
  if (!r || !r.first) return '';
  const miss = r.missing || [];
  const shown = miss.slice(0, 8).map((d) => fmtDate(d)).join(', ');
  const word = { sales: 'sales', purchases: 'purchases', returns: 'returns' }[kind];
  return `<span class="hint">From <b>${fmtDate(r.first)}</b> to <b>${fmtDate(r.last)}</b> · ${fmtNum(r.lines)} lines on ${fmtNum(r.days)} day(s)</span>
    ${miss.length ? `<span class="hint warn-text" title="${esc(miss.map((d) => fmtDate(d)).join(', '))}">No ${word} on ${miss.length} day(s) in between: ${esc(shown)}${miss.length > 8 ? ` and ${miss.length - 8} more` : ''}${kind === 'purchases' ? ' (fine if nothing was bought that day)' : kind === 'returns' ? ' (fine if nothing was returned that day)' : ' — check these days were uploaded'}</span>` : ''}`;
}
