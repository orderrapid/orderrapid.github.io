import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const configured = !SUPABASE_URL.includes('YOUR-PROJECT-ID');

export const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Turn a Supabase error into a plain sentence.
export function check({ data, error }) {
  if (error) {
    const msg = error.message || String(error);
    if (/JWT|session/i.test(msg)) throw new Error('Your login has expired. Please sign in again.');
    if (/Failed to fetch|NetworkError/i.test(msg)) throw new Error('Could not reach the server. Check the internet connection.');
    throw new Error(msg);
  }
  return data;
}

// App-wide state: who is logged in and the warehouse list.
export const state = {
  session: null,
  profile: null,      // { user_id, email, full_name, role, active }
  warehouses: [],
  warehouseId: null,  // last chosen warehouse, remembered per browser
};

export async function loadProfile() {
  const uid = state.session?.user?.id;
  state.profile = uid ? check(await sb.from('profiles').select('*').eq('user_id', uid).maybeSingle()) : null;
  return state.profile;
}

export async function loadWarehouses() {
  state.warehouses = check(await sb.from('warehouses').select('*').eq('active', true).order('name'));
  let saved = null;
  try { saved = localStorage.getItem('warehouseId'); } catch { /* storage blocked */ }
  const ids = state.warehouses.map((w) => String(w.id));
  state.warehouseId = ids.includes(saved) ? saved : ids[0] || null;
  return state.warehouses;
}

export function rememberWarehouse(id) {
  state.warehouseId = String(id);
  try { localStorage.setItem('warehouseId', String(id)); } catch { /* ignore */ }
}

export const role = () => state.profile?.role;
export const isRole = (...r) => r.includes(role());

export const warehouseName = (id) => state.warehouses.find((w) => String(w.id) === String(id))?.name || '';
