import { sb, configured, check, state, loadProfile, loadWarehouses, role } from './db.js';
import { esc, $, $$, toast } from './ui.js';
import { APP_NAME } from './config.js';
import home from './pages/home.js';
import orders from './pages/orders.js';
import purchases from './pages/purchases.js';
import sales from './pages/sales.js';
import stock from './pages/stock.js';
import items from './pages/items.js';
import warehouses from './pages/warehouses.js';
import users from './pages/users.js';

// Each screen says which roles may open it. The database enforces the
// same rules, so hiding a menu item is for tidiness, not security.
const PAGES = { home, orders, purchases, sales, stock, items, warehouses, users };
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', purchase: 'Purchase Team', pending: 'Waiting for approval' };

const app = $('#app');

async function start() {
  if (!configured) {
    app.innerHTML = `<div class="center-card card"><h2>Almost there</h2>
      <p>Open <code>js/config.js</code> and fill in your Supabase project URL and anon key, then reload this page.</p></div>`;
    return;
  }
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  sb.auth.onAuthStateChange((event, session) => {
    const was = state.session?.user?.id;
    state.session = session;
    if ((session?.user?.id || null) !== (was || null)) boot();
  });
  window.addEventListener('hashchange', route);
  boot();
}

async function boot() {
  if (!state.session) return renderLogin();
  try {
    await loadProfile();
    if (!state.profile || !state.profile.active || role() === 'pending') return renderWaiting();
    await loadWarehouses();
    renderShell();
    route();
  } catch (e) {
    app.innerHTML = `<div class="center-card card"><h2>Something went wrong</h2><p>${esc(e.message)}</p>
      <button class="btn" id="out">Sign out</button></div>`;
    $('#out').onclick = () => sb.auth.signOut();
  }
}

// ---------------------------------------------------------------------
// Sign in / create account
// ---------------------------------------------------------------------
function renderLogin(mode = 'in', msg = '') {
  const up = mode === 'up';
  app.innerHTML = `
    <div class="login">
      <div class="login-card card">
        <div class="brand big"><span class="logo">℞</span>${esc(APP_NAME)}</div>
        <h2>${up ? 'Create your account' : 'Sign in'}</h2>
        ${msg ? `<div class="note ${msg.startsWith('!') ? 'error' : 'ok'}">${esc(msg.replace(/^!/, ''))}</div>` : ''}
        <form id="auth">
          ${up ? `<label class="field"><span>Your name</span><input name="name" required autocomplete="name"></label>` : ''}
          <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="username"></label>
          <label class="field"><span>Password</span><input name="password" type="password" required minlength="8"
            autocomplete="${up ? 'new-password' : 'current-password'}"></label>
          <button class="btn primary wide" id="go">${up ? 'Create account' : 'Sign in'}</button>
        </form>
        <p class="muted small">${up
          ? 'Already have an account? <a href="#" id="swap">Sign in</a>'
          : 'New to the team? <a href="#" id="swap">Create an account</a> — an Admin will approve it.'}</p>
        ${up ? '' : `<p class="muted small">Forgot your password? Ask your Admin — they can set a new one for you from the Users screen.</p>`}
      </div>
    </div>`;
  $('#swap').onclick = (e) => { e.preventDefault(); renderLogin(up ? 'in' : 'up'); };
  $('#auth').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, btn = $('#go');
    btn.disabled = true; btn.textContent = 'Please wait…';
    const email = f.email.value.trim(), password = f.password.value;
    if (up) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: f.name.value.trim() } } });
      if (error) return renderLogin('up', '!' + error.message);
      if (!data.session) return renderLogin('in', 'Account created. Ask your Admin to approve it, then sign in.');
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return renderLogin('in', '!' + (error.message === 'Invalid login credentials'
        ? 'Email or password is wrong.' : error.message));
    }
  };
}

function renderWaiting() {
  app.innerHTML = `<div class="center-card card">
    <h2>Waiting for approval</h2>
    <p>Your account <b>${esc(state.session.user.email)}</b> is created. An Admin needs to give you a role
       (Manager or Purchase Team) before you can use the app.</p>
    <p class="muted">Once they have, reload this page.</p>
    <div class="row"><button class="btn primary" onclick="location.reload()">Reload</button>
    <button class="btn ghost" id="out">Sign out</button></div></div>`;
  $('#out').onclick = () => sb.auth.signOut();
}

// ---------------------------------------------------------------------
// Main layout + menu
// ---------------------------------------------------------------------
function allowed(page) { return page.roles.includes(role()); }

function renderShell() {
  const menu = Object.entries(PAGES).filter(([, p]) => allowed(p));
  app.innerHTML = `
    <header class="top">
      <div class="brand"><span class="logo">℞</span>${esc(APP_NAME)}</div>
      <nav id="nav">${menu.map(([k, p]) => `<a href="#/${k}" data-k="${k}">${esc(p.title)}</a>`).join('')}</nav>
      <div class="who">
        <span class="badge ${role()}">${esc(state.profile.full_name || state.profile.email)} · ${ROLE_LABEL[role()]}</span>
        <button class="btn ghost small" id="out">Sign out</button>
      </div>
    </header>
    <main id="page"></main>`;
  $('#out').onclick = async () => { await sb.auth.signOut(); };
}

let current = null;
async function route() {
  if (!state.profile || !$('#page')) return;
  const key = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'home';
  const page = PAGES[key] && allowed(PAGES[key]) ? PAGES[key] : PAGES.home;
  const k = PAGES[key] && allowed(PAGES[key]) ? key : 'home';
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.k === k));
  // Each visit gets a fresh container, so a slow screen that finishes
  // loading after you've moved on can't overwrite the new one.
  const el = document.createElement('div');
  el.innerHTML = '<div class="loading">Loading…</div>';
  $('#page').replaceChildren(el);
  current = el;
  try {
    await page.render(el);
  } catch (e) {
    if (current === el) el.innerHTML = `<div class="card note error">${esc(e.message)}</div>`;
  }
}

window.addEventListener('unhandledrejection', (e) => toast(e.reason?.message || 'Something went wrong', 'error'));

start();
