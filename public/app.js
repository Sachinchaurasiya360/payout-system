// Payout Console — talks to the payout API on the same origin.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const enc = encodeURIComponent;
const state = { user: null, brands: [], users: [] };

/* ---------- HTTP ---------- */
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* body may be empty */ }
  if (!res.ok) {
    const info = (data && data.error) || { code: res.status, message: res.statusText };
    const err = new Error(info.message || 'Request failed');
    err.code = info.code;
    err.details = info.details;
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- Formatting ---------- */
const money = (n) =>
  '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (d) => (d ? new Date(d).toLocaleString() : '—');
const short = (id) => (id ? String(id).slice(0, 8) : '');
const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function pill(status) {
  const s = String(status).toLowerCase();
  const tone = {
    pending: 'amber', processing: 'blue',
    approved: 'green', completed: 'green', paid: 'green', advance: 'blue', withdrawal: 'muted',
    rejected: 'red', failed: 'red', cancelled: 'red',
  }[s] || 'muted';
  return `<span class="pill pill-${tone}">${s}</span>`;
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

const emptyRow = (cols, text) => `<tr><td colspan="${cols}" class="empty-cell">${text}</td></tr>`;

/* Wrap an async action so its trigger button shows a spinner + disables. */
async function run(btn, fn) {
  if (btn) { btn.classList.add('loading'); btn.disabled = true; }
  try { return await fn(); }
  catch (err) { toast(err.message, 'error'); }
  finally { if (btn) { btn.classList.remove('loading'); btn.disabled = false; } }
}
const submitter = (e) => e.submitter || e.target.querySelector('button[type="submit"], button:not([type])');
const showUsersLoader = (on) => { const s = $('#usersLoader'); if (s) s.hidden = !on; };

/* ---------- Health / brands / users ---------- */
async function checkHealth() {
  const health = $('#healthPill');
  const gw = $('#gatewayMode');
  try {
    const h = await api('GET', '/health');
    health.className = 'pill pill-green';
    health.textContent = 'API online';
    if (h.gatewayMode) gw.textContent = `gateway: ${h.gatewayMode}`;
  } catch {
    health.className = 'pill pill-red';
    health.textContent = 'API offline';
  }
}

async function loadBrands() {
  try {
    const { brands } = await api('GET', '/brands');
    state.brands = brands || [];
  } catch { state.brands = []; }
  renderBrands();
}

function renderBrands() {
  $('#brandsList').innerHTML = state.brands.length
    ? state.brands.map((b) => `<span class="chip">${b.code}</span>`).join('')
    : '<span class="muted small">No brands yet</span>';
  const sel = $('#saleBrand');
  if (sel) {
    sel.innerHTML = state.brands.length
      ? state.brands.map((b) => `<option value="${b.code}">${b.code}</option>`).join('')
      : '<option value="" disabled selected>no brands</option>';
  }
}

async function loadUsers() {
  showUsersLoader(true);
  try {
    const { users } = await api('GET', '/users');
    state.users = users || [];
    renderUsers();
  } catch {
    $('#usersList').innerHTML = '<span class="muted small">Could not load users</span>';
  } finally {
    showUsersLoader(false);
  }
}

function renderUsers() {
  const list = $('#usersList');
  if (!list) return;
  set('#usersCount', state.users.length);
  if (!state.users.length) { list.innerHTML = '<span class="muted small">No accounts yet</span>'; return; }
  const active = state.user && state.user.handle;
  list.innerHTML = state.users
    .map((u) => {
      const handle = esc(u.handle);
      return `
      <button type="button" class="user-chip${u.handle === active ? ' active' : ''}" data-user="${handle}">
        <span class="user-chip-main">
          <strong>${handle}</strong>
          <span class="mono">${short(u.id)}</span>
        </span>
        <span class="user-chip-balance${u.withdrawableBalance < 0 ? ' neg' : ''}">${money(u.withdrawableBalance)}</span>
      </button>`;
    })
    .join('');
}

/* ---------- Account ---------- */
async function loadAccount(handle) {
  showUsersLoader(true);
  try {
    const [userRes, salesRes, payoutsRes, ledgerRes] = await Promise.all([
      api('GET', `/users/${enc(handle)}`),
      api('GET', `/sales?userId=${enc(handle)}`),
      api('GET', `/users/${enc(handle)}/payouts`),
      api('GET', `/users/${enc(handle)}/ledger`),
    ]);
    state.user = userRes.user;
    document.querySelector('.layout')?.classList.remove('is-start');
    $('#account').hidden = false;
    const sales = salesRes.sales || [];
    const payouts = payoutsRes.payouts || [];
    const ledger = ledgerRes.ledger || [];
    renderUser(userRes.user);
    renderStats(sales, payouts);
    renderSales(sales);
    renderPayouts(payouts);
    renderLedger(ledger);
    renderUsers();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    showUsersLoader(false);
  }
}

function renderUser(u) {
  const bal = $('#balance');
  bal.textContent = money(u.withdrawableBalance);
  bal.className = 'balance' + (u.withdrawableBalance < 0 ? ' neg' : '');
  set('#userHandle', u.handle);
  set('#userId', short(u.id));

  set('#cuHandle', u.handle);
  set('#cuId', short(u.id));
  const cub = $('#cuBalance');
  cub.textContent = money(u.withdrawableBalance);
  cub.className = 'cu-balance' + (u.withdrawableBalance < 0 ? ' neg' : '');
  $('#currentUser').hidden = false;
  const input = document.querySelector('#loadUserForm input[name="handle"]');
  if (input) input.value = u.handle;
}

function renderStats(sales, payouts) {
  const pending = sales.filter((s) => s.status === 'pending').length;
  const advanced = payouts.filter((p) => p.type === 'advance').reduce((a, p) => a + p.amount, 0);
  set('#statSales', sales.length);
  set('#statPending', pending);
  set('#statAdvanced', money(advanced));
  set('#statPayouts', payouts.length);
}

function renderSales(sales) {
  set('#salesCount', sales.length);
  const body = $('#salesBody');
  if (!sales.length) { body.innerHTML = emptyRow(5, 'No sales yet'); return; }
  body.innerHTML = sales.map((s) => `
    <tr>
      <td>${s.brand ?? '—'}</td>
      <td class="num">${money(s.earning)}</td>
      <td>${pill(s.status)}</td>
      <td class="num">${s.advancePaid ? money(s.advancePaid) : '—'}</td>
      <td class="num">
        <div class="row-actions">
          ${s.status === 'pending'
            ? `<button class="btn btn-tiny btn-green" data-reconcile data-sale-id="${s.id}" data-status="approved">Approve</button>
               <button class="btn btn-tiny btn-red" data-reconcile data-sale-id="${s.id}" data-status="rejected">Reject</button>`
            : '<span class="muted small">done</span>'}
        </div>
      </td>
    </tr>`).join('');
}

function renderPayouts(payouts) {
  set('#payoutsCount', payouts.length);
  const body = $('#payoutsBody');
  if (!payouts.length) { body.innerHTML = emptyRow(5, 'No payouts yet'); return; }
  body.innerHTML = payouts.map((p) => {
    const canSettle = p.type === 'withdrawal' && ['pending', 'processing'].includes(p.status);
    const details = p.failureReason
      ? `<span class="neg">${p.failureReason}</span>`
      : p.saleId ? `sale ${short(p.saleId)}`
      : p.providerRef ? p.providerRef
      : '—';
    return `
    <tr>
      <td>${pill(p.type)}</td>
      <td class="num">${money(p.amount)}</td>
      <td>${pill(p.status)}</td>
      <td class="muted small">${details}</td>
      <td class="num">
        <div class="row-actions">
          ${canSettle
            ? `<button class="btn btn-tiny btn-green" data-settle data-payout-id="${p.id}" data-status="completed">Complete</button>
               <button class="btn btn-tiny btn-red" data-settle data-payout-id="${p.id}" data-status="failed">Fail</button>`
            : '<span class="muted small">—</span>'}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderLedger(ledger) {
  set('#ledgerCount', ledger.length);
  const body = $('#ledgerBody');
  if (!ledger.length) { body.innerHTML = emptyRow(5, 'No ledger entries yet'); return; }
  body.innerHTML = ledger.slice().reverse().map((e) => `
    <tr>
      <td class="small">${e.type}</td>
      <td class="num ${e.amount < 0 ? 'neg' : 'pos'}">${e.amount < 0 ? '−' : '+'}${money(Math.abs(e.amount))}</td>
      <td class="num">${money(e.balanceAfter)}</td>
      <td class="muted small">${e.reason ?? '—'}</td>
      <td class="muted small">${when(e.createdAt)}</td>
    </tr>`).join('');
}

function requireUser() {
  if (!state.user) { toast('Load a user first', 'error'); return false; }
  return true;
}

/* ---------- Event wiring ---------- */
function init() {
  $('#createUserForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const handle = new FormData(e.target).get('handle').trim();
    run(submitter(e), async () => {
      const { user } = await api('POST', '/users', { handle });
      toast(`User "${user.handle}" created`, 'success');
      e.target.reset();
      await loadUsers();
      await loadAccount(user.handle);
    });
  });

  $('#createBrandForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const code = fd.get('code').trim();
    const name = fd.get('name').trim();
    run(submitter(e), async () => {
      await api('POST', '/brands', name ? { code, name } : { code });
      toast(`Brand "${code}" created`, 'success');
      e.target.reset();
      await loadBrands();
    });
  });

  $('#loadUserForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const handle = new FormData(e.target).get('handle').trim();
    run(submitter(e), () => loadAccount(handle));
  });

  $('#createSaleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!requireUser()) return;
    const fd = new FormData(e.target);
    const brand = fd.get('brand');
    const earning = Number(fd.get('earning'));
    if (!brand) { toast('Create a brand first', 'error'); return; }
    run(submitter(e), async () => {
      await api('POST', '/sales', { userId: state.user.handle, brand, earning });
      toast(`Sale of ${money(earning)} added`, 'success');
      e.target.reset();
      renderBrands();
      await loadAccount(state.user.handle);
    });
  });

  $('#runAdvanceBtn').addEventListener('click', (e) => {
    if (!requireUser()) return;
    run(e.currentTarget, async () => {
      const r = await api('POST', '/jobs/advance-payout', { userId: state.user.handle });
      toast(`Advance job — paid ${r.paid}, skipped ${r.skipped}, transferred ${money(r.totalTransferred)}`, 'success');
      await loadAccount(state.user.handle);
    });
  });

  $('#withdrawForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!requireUser()) return;
    const fd = new FormData(e.target);
    const amountRaw = fd.get('amount');
    const key = fd.get('idempotencyKey').trim();
    const body = {};
    if (amountRaw) body.amount = Number(amountRaw);
    if (key) body.idempotencyKey = key;
    run(submitter(e), async () => {
      const r = await api('POST', `/users/${enc(state.user.handle)}/withdrawals`, body);
      toast(
        r.replayed
          ? 'Idempotent replay — original payout returned, no new debit'
          : `Withdrawal of ${money(r.payout.amount)} initiated`,
        'success',
      );
      e.target.reset();
      await loadAccount(state.user.handle);
    });
  });

  // Reconcile (delegated)
  $('#salesBody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-reconcile]');
    if (!btn) return;
    const { saleId, status } = btn.dataset;
    run(btn, async () => {
      const r = await api('POST', `/sales/${enc(saleId)}/reconcile`, { status });
      const sign = r.adjustment < 0 ? '−' : '+';
      toast(`Sale ${status} — balance ${sign}${money(Math.abs(r.adjustment))}`, 'success');
      await loadAccount(state.user.handle);
    });
  });

  // Settle (delegated)
  $('#payoutsBody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-settle]');
    if (!btn) return;
    const { payoutId, status } = btn.dataset;
    run(btn, async () => {
      const r = await api('POST', `/payouts/${enc(payoutId)}/settle`, { status });
      toast(
        r.refunded
          ? `Payout ${status} — ${money(r.payout.amount)} refunded to balance`
          : `Payout marked ${status}`,
        'success',
      );
      await loadAccount(state.user.handle);
    });
  });

  // Select a registered user (delegated)
  $('#usersList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-user]');
    if (!btn) return;
    run(btn, () => loadAccount(btn.dataset.user));
  });

  // Refresh
  $('[data-refresh]').addEventListener('click', (e) => {
    if (state.user) run(e.currentTarget, () => loadAccount(state.user.handle));
  });

  // Scaffold a demo account
  $('#demoBtn').addEventListener('click', (e) => {
    run(e.currentTarget, async () => {
      const handle = 'demo_' + Date.now().toString(36);
      await api('POST', '/users', { handle });
      try { await api('POST', '/brands', { code: 'brand_demo', name: 'Demo Brand' }); } catch { /* may exist */ }
      for (let i = 0; i < 3; i += 1) {
        await api('POST', '/sales', { userId: handle, brand: 'brand_demo', earning: 40 });
      }
      await loadBrands();
      await loadUsers();
      toast(`Demo account "${handle}" created with 3 × ₹40 sales`, 'success');
      await loadAccount(handle);
    });
  });
}

/* ---------- Boot ---------- */
async function includePartials() {
  const nodes = [...document.querySelectorAll('[data-include]')];
  await Promise.all(nodes.map(async (node) => {
    try {
      const res = await fetch(node.dataset.include);
      node.innerHTML = await res.text();
    } catch {
      node.innerHTML = '<p class="muted small" style="padding:16px">Failed to load section.</p>';
    }
  }));
}

async function boot() {
  await includePartials();
  init();
  checkHealth();
  loadBrands();
  loadUsers();
}

boot();
