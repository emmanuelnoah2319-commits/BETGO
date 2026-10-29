import { MAX_LEGS, combinedOdds, minorToNaira, nairaToMinor, summarizeTicket } from './ticket-calc.js';
const $ = (selector) => document.querySelector(selector);
$('#year').textContent = String(new Date().getFullYear());

// Betting workspace state (functions are defined at the end of this file).
let sportyAccounts = [];
let openGame = null;
let liveTimer = null;
let liveRefreshing = false;
const LIVE_REFRESH_MS = 5000;
const ticket = { legs: [], submitKey: null, submitPayload: null };

const koboToNaira = (value) => (Number(value) / 100).toFixed(2);

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const failure = new Error(body?.error?.message || 'Request failed'); failure.code = body?.error?.code; throw failure; }
  return body;
}
async function csrf() { return request('/api/csrf'); }
async function mutate(url, method, data) {
  const { csrfToken } = await csrf();
  const headers = { 'X-CSRF-Token': csrfToken };
  const options = { method, headers };
  if (data !== undefined) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(data); }
  return request(url, options);
}
function showLogin(message = '') {
  resetWorkspace();
  $('#login-panel').hidden = false; $('#dashboard').hidden = true;
  $('#login-error').hidden = !message; $('#login-error').textContent = message;
}
function showMessage(id, message = '', isError = false) {
  const node = document.getElementById(id); node.textContent = message;
  node.classList.toggle('form-error', isError); node.classList.toggle('form-success', Boolean(message) && !isError); node.hidden = !message;
}
function showDashboardMessage(message = '', isError = false) { showMessage('account-message', message, isError); }
function element(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
}
function renderAccount(account) {
  const card = element('article', 'account-card'); const top = element('div', 'account-card-top'); const identity = element('div');
  identity.append(element('strong', '', account.displayName), element('small', '', account.platform));
  const statusLabels = { not_connected: 'Not connected', connecting: 'Connecting…', connected: 'Connected', needs_attention: 'Needs attention', disconnected: 'Disconnected' };
  top.append(identity, element('span', 'pill', statusLabels[account.connectionStatus] || 'Not connected'));
  card.append(top, element('p', 'account-notes', account.notes || 'No notes added.'));
  const details = element('div', 'account-details');
  details.append(element('span', '', `Activity: ${account.enabledForNewActivity ? 'enabled' : 'disabled'}`), element('span', '', account.balanceMinor == null ? 'Balance: not synced' : `Balance: ${account.currency || '₦'} ${koboToNaira(account.balanceMinor)}`));
  const actions = element('div', 'account-actions'); const edit = element('button', 'button-secondary', 'Edit details');
  edit.type = 'button'; edit.addEventListener('click', () => openEditForm(account, card)); actions.append(edit);
  const checkedText = account.lastCheckedAt ? `Last checked ${new Date(account.lastCheckedAt).toLocaleString()}` : 'Never checked';
  details.append(element('span', '', checkedText));
  if (account.connectionReason) details.append(element('span', '', account.connectionReason));
  const check = element('button', 'button-secondary', 'Check connection'); check.type = 'button';
  check.addEventListener('click', async () => {
    check.disabled = true;
    try { await mutate(`/api/accounts/${account.id}/connection/check`, 'POST'); showDashboardMessage('Connection verified.'); }
    catch (error) { showDashboardMessage(error.message, true); }
    finally { check.disabled = false; await loadAccounts(); }
  });
  actions.append(check);
  const remove = element('button', 'button-secondary', 'Remove'); remove.type = 'button';
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Remove ${account.displayName}? This cannot be undone.`)) return;
    remove.disabled = true;
    try { await mutate(`/api/accounts/${account.id}`, 'DELETE'); showDashboardMessage('Account removed.'); }
    catch (error) { showDashboardMessage(error.message, true); }
    finally { await loadAccounts(); }
  });
  actions.append(remove);
  if (['connected', 'needs_attention'].includes(account.connectionStatus)) {
    const disconnect = element('button', 'button-secondary', 'Disconnect'); disconnect.type = 'button';
    disconnect.addEventListener('click', async () => {
      disconnect.disabled = true;
      try { await mutate(`/api/accounts/${account.id}/connection/disconnect`, 'POST'); showDashboardMessage('Account disconnected.'); }
      catch (error) { showDashboardMessage(error.message, true); }
      finally { await loadAccounts(); }
    });
    actions.append(disconnect);
  }
  card.append(details, actions); return card;
}
function openEditForm(account, card) {
  const existing = card.querySelector('.inline-edit-form'); if (existing) { existing.remove(); return; }
  const form = element('form', 'inline-edit-form');
  const nameLabel = element('label', '', 'Account label'); const name = element('input');
  name.name = 'displayName'; name.required = true; name.maxLength = 60; name.value = account.displayName; nameLabel.append(name);
  const notesLabel = element('label', '', 'Notes'); const notes = element('textarea');
  notes.name = 'notes'; notes.maxLength = 300; notes.rows = 3; notes.value = account.notes || ''; notesLabel.append(notes);
  const error = element('p', 'form-error'); error.hidden = true; error.setAttribute('role', 'alert');
  const save = element('button', '', 'Save changes'); save.type = 'submit';
  const cancel = element('button', 'button-secondary', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => form.remove());
  const controls = element('div', 'form-actions'); controls.append(save, cancel); form.append(nameLabel, notesLabel, error, controls);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true; save.textContent = 'Saving…'; error.hidden = true;
    try { await mutate(`/api/accounts/${encodeURIComponent(account.id)}`, 'PATCH', { displayName: name.value.trim(), notes: notes.value.trim() }); showDashboardMessage('Account details updated.'); await loadAccounts(); }
    catch (e) { error.textContent = e.message; error.hidden = false; }
    finally { save.disabled = false; save.textContent = 'Save changes'; }
  });
  card.append(form); name.focus();
}
async function loadAccounts() {
  const { accounts } = await request('/api/accounts'); $('#account-count').textContent = String(accounts.length);
  sportyAccounts = accounts.filter((account) => account.platform === 'SportyBet'); renderTicketAccounts();
  const list = $('#account-list'); list.replaceChildren();
  if (!accounts.length) list.append(element('p', 'empty-state', 'No account records yet. Add a label for each bookmaker account you manage.'));
  else list.append(...accounts.map(renderAccount));
}
async function loadIntegrations() {
  const { integrations } = await request('/api/integrations');
  $('#integration-count').textContent = `${integrations.filter((item) => item.status === 'available').length} / ${integrations.length}`;
  $('#integration-list').replaceChildren(...integrations.map((item) => {
    const card = element('article', 'integration'); const info = element('div');
    info.append(element('strong', '', item.name), element('small', '', item.reason));
    card.append(info, element('span', 'pill', item.status === 'available' ? 'Available' : 'Unavailable')); return card;
  }));
}
async function loadDashboard() {
  try {
    const { user } = await request('/api/me'); $('#welcome').textContent = `Signed in as ${user.email}`;
    $('#login-panel').hidden = true; $('#dashboard').hidden = false; $('#dashboard-error').hidden = true;
    $('#admin-applications-section').hidden = user.role !== 'owner';
    $('#admin-users-section').hidden = user.role !== 'owner';
    $('#member-subscription-panel').hidden = user.role === 'owner';
    $('#operations-section').hidden = user.role !== 'owner';
    if (user.role !== 'owner') {
      const subscriptions = user.subscriptions || [];
      const active = subscriptions.filter((item) => item.active);
      $('#member-bookmaker').textContent = active.length ? active.map((item) => item.bookmaker).join(', ') : (user.bookmaker || 'Not assigned');
      const expiries = active.map((item) => (item.expiresAt ? new Date(item.expiresAt) : null)).filter((date) => date && !Number.isNaN(date.getTime()));
      const expiry = expiries.length ? new Date(Math.min(...expiries.map((date) => date.getTime()))) : (user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt) : null);
      $('#member-expiry').textContent = expiry && !Number.isNaN(expiry.getTime()) ? expiry.toLocaleDateString() : 'Not available';
      const daysLeft = (item) => (item.expiresAt ? Math.max(0, Math.ceil((new Date(item.expiresAt).getTime() - Date.now()) / 86400000)) : null);
      $('#member-days-left').textContent = subscriptions.length
        ? subscriptions.map((item) => { const days = daysLeft(item); return `${item.bookmaker}: ${!item.active ? 'expired' : days === null ? 'no expiry' : `${days} day${days === 1 ? '' : 's'} left`}`; }).join(' · ')
        : 'Contact support if this looks incorrect.';
      renderRenewals(subscriptions);
      const allowed = active.length ? active.map((item) => item.bookmaker) : (user.bookmaker ? [user.bookmaker] : []);
      for (const option of $('#account-platform').options) option.disabled = !allowed.includes(option.value);
      if (allowed.length && !allowed.includes($('#account-platform').value)) $('#account-platform').value = allowed[0];
    } else { for (const option of $('#account-platform').options) option.disabled = false; }
    $('#password-change-panel').hidden = !user.mustChangePassword;
    setupViews(user.mustChangePassword ? 'overview' : null);
    if (user.mustChangePassword) return;
    await Promise.all([loadAccounts(), loadIntegrations(), ...(user.role === 'owner' ? [loadApplications(), loadUsers(), loadOperations()] : [])]);
  } catch (error) {
    if (error.message === 'Login required' || error.message.includes('Session')) return showLogin();
    $('#dashboard-error').hidden = false; $('#dashboard-error').textContent = error.message;
  }
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#login-button'); button.disabled = true; button.textContent = 'Signing in…'; $('#login-error').hidden = true;
  try { await mutate('/api/auth/login', 'POST', { email: $('#email').value, password: $('#password').value }); $('#password').value = ''; loadPlans(); loadDashboard(); }
  catch (error) { showLogin(error.message); }
  finally { button.disabled = false; button.innerHTML = 'Sign in <span aria-hidden="true">→</span>'; }
});
$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#create-account-button'); button.disabled = true; button.textContent = 'Adding…'; showDashboardMessage();
  try { await mutate('/api/accounts', 'POST', { displayName: $('#account-name').value.trim(), platform: $('#account-platform').value, notes: $('#account-notes').value.trim() }); $('#account-form').reset(); showDashboardMessage('Account record added. It is not connected to the bookmaker.'); await loadAccounts(); }
  catch (error) { showDashboardMessage(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Add account record'; }
});
$('#application-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#application-button'); button.disabled = true; button.textContent = 'Submitting…'; showMessage('application-message');
  try { const result = await mutate('/api/applications', 'POST', { fullName: $('#application-name').value.trim(), email: $('#application-email').value.trim(), bookmaker: $('#application-bookmaker').value }); $('#application-form').reset(); showMessage('application-message', result.message); }
  catch (error) { showMessage('application-message', error.message, true); }
  finally { button.disabled = false; button.textContent = 'Submit application'; }
});
async function loadApplications() {
  const { applications } = await request('/api/admin/applications'); const list = $('#applications-list'); list.replaceChildren();
  if (!applications.length) { list.append(element('p', 'empty-state', 'No applications yet.')); return; }
  for (const item of applications) { const card = element('article', 'account-card'); card.append(element('strong', '', item.fullName), element('p', '', item.email), element('p', 'fixture-meta', `${item.bookmaker} · ₦${Number(item.priceNgn).toLocaleString('en-NG')} / 30 days · ${item.type === 'renewal' ? 'renewal · ' : item.type === 'add_bookmaker' ? 'extra bookmaker · ' : ''}${item.status}`));
    if (item.status === 'pending') { const actions = element('div', 'account-actions'); const approve = element('button', '', 'Approve & send payment link'); approve.type = 'button'; approve.addEventListener('click', async () => { approve.disabled = true; try { const result = await mutate(`/api/admin/applications/${encodeURIComponent(item.id)}/approve`, 'POST', {}); showMessage('applications-message', result.message); await loadApplications(); } catch (error) { showMessage('applications-message', error.message, true); approve.disabled = false; } }); const reject = element('button', 'button-secondary', 'Reject'); reject.type = 'button'; reject.addEventListener('click', async () => { const reason = window.prompt('Enter the reason for rejecting this application:'); if (!reason || reason.trim().length < 3) return; reject.disabled = true; try { const result = await mutate(`/api/admin/applications/${encodeURIComponent(item.id)}/reject`, 'POST', { reason: reason.trim() }); showMessage('applications-message', result.message); await loadApplications(); } catch (error) { showMessage('applications-message', error.message, true); reject.disabled = false; } }); actions.append(approve, reject); card.append(actions); }
    if (item.status === 'approved_awaiting_payment') { const actions = element('div', 'account-actions'); const resend = element('button', 'button-secondary', 'Resend payment email'); resend.type = 'button'; resend.addEventListener('click', async () => { resend.disabled = true; try { const result = await mutate(`/api/admin/applications/${encodeURIComponent(item.id)}/resend-payment-email`, 'POST', {}); showMessage('applications-message', result.message, !result.notificationSent); } catch (error) { showMessage('applications-message', error.message, true); } finally { resend.disabled = false; } }); actions.append(resend); if (item.paymentUrl) { const copy = element('button', 'button-secondary', 'Copy payment link'); copy.type = 'button'; copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(item.paymentUrl); showMessage('applications-message', 'Payment link copied.'); } catch { window.prompt('Copy this payment link:', item.paymentUrl); } }); actions.append(copy); } card.append(actions); }
    list.append(card);
  }
}
$('#refresh-applications').addEventListener('click', async () => { try { await loadApplications(); showMessage('applications-message', 'Applications refreshed.'); } catch (error) { showMessage('applications-message', error.message, true); } });
$('#password-change-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await mutate('/api/me/password', 'POST', { currentPassword: $('#temporary-password').value, newPassword: $('#new-password').value }); showMessage('password-change-message', result.message); await mutate('/api/auth/logout', 'POST'); showLogin('Password changed. Sign in with your new password.'); } catch (error) { showMessage('password-change-message', error.message, true); } });

$('#logout-button').addEventListener('click', async () => {
  try { await mutate('/api/auth/logout', 'POST'); showLogin(); }
  catch (error) { $('#dashboard-error').hidden = false; $('#dashboard-error').textContent = error.message; }
});
async function loadPlans() { try { const { plans } = await request('/api/plans'); const select = $('#application-bookmaker'); for (const option of select.options) { const plan = plans.find((item) => item.bookmaker === option.value); if (plan) option.textContent = `${plan.bookmaker} — ₦${Number(plan.priceNgn).toLocaleString('en-NG')} / ${plan.durationDays} days`; } } catch { /* Keep the visible defaults if the plans endpoint is temporarily unavailable. */ } }
loadPlans();
loadDashboard();

function renderRenewals(subscriptions) {
  const panel = $('#member-subscription-panel');
  let box = $('#member-renewals');
  if (!box) { box = element('div', 'account-actions'); box.id = 'member-renewals'; panel.append(box); }
  box.replaceChildren();
  for (const item of subscriptions) {
    const button = element('button', 'button-secondary', `Renew ${item.bookmaker}`);
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { const result = await mutate('/api/subscriptions/renew', 'POST', { bookmaker: item.bookmaker }); window.alert(result.message); }
      catch (error) { window.alert(error.message); }
      finally { button.disabled = false; }
    });
    box.append(button);
  }
}

// Password reset. The token arrives in the URL fragment; it is read once, then removed from the address bar.
let resetToken = null;
function readResetTokenFromUrl() {
  const match = /^#reset=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
  if (!match) return;
  resetToken = match[1];
  history.replaceState(null, '', window.location.pathname + window.location.search);
  $('#reset-form').hidden = false;
  $('#login-form').hidden = true;
  $('#forgot-toggle').hidden = true;
}
$('#forgot-toggle').addEventListener('click', () => { $('#forgot-form').hidden = !$('#forgot-form').hidden; if (!$('#forgot-form').hidden) $('#forgot-email').focus(); });
$('#forgot-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#forgot-button'); button.disabled = true; button.textContent = 'Sending…'; showMessage('forgot-message');
  try { const result = await mutate('/api/auth/forgot-password', 'POST', { email: $('#forgot-email').value.trim() }); showMessage('forgot-message', result.message); $('#forgot-form').reset(); }
  catch (error) { showMessage('forgot-message', error.message, true); }
  finally { button.disabled = false; button.textContent = 'Email me a reset link'; }
});
$('#reset-form').addEventListener('submit', async (event) => {
  event.preventDefault(); showMessage('reset-message');
  if ($('#reset-password').value !== $('#reset-confirm').value) return showMessage('reset-message', 'The two passwords do not match.', true);
  const button = $('#reset-button'); button.disabled = true; button.textContent = 'Saving…';
  try {
    const result = await mutate('/api/auth/reset-password', 'POST', { token: resetToken, newPassword: $('#reset-password').value });
    $('#reset-form').reset(); $('#reset-form').hidden = true; resetToken = null; $('#login-form').hidden = false; $('#forgot-toggle').hidden = false;
    showMessage('reset-message', result.message);
  } catch (error) { showMessage('reset-message', error.message, true); }
  finally { button.disabled = false; button.textContent = 'Set new password'; }
});
readResetTokenFromUrl();

async function loadUsers() {
  const q = $('#user-search').value.trim();
  const { users } = await request(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const list = $('#users-list'); list.replaceChildren();
  if (!users.length) { list.append(element('p', 'empty-state', q ? 'No members match that search.' : 'No members yet.')); return; }
  for (const user of users) {
    const card = element('article', 'account-card'); const top = element('div', 'account-card-top'); const identity = element('div');
    identity.append(element('strong', '', user.fullName || user.email), element('small', '', user.email));
    top.append(identity, element('span', 'pill', user.disabled ? 'Deactivated' : 'Active')); card.append(top);
    const subs = user.subscriptions.length
      ? user.subscriptions.map((item) => `${item.bookmaker}: ${item.active ? 'active' : 'expired'}${item.expiresAt ? ` until ${new Date(item.expiresAt).toLocaleDateString()}` : ''}`).join(' · ')
      : 'No subscriptions';
    card.append(element('p', 'fixture-meta', subs));
    if (user.disabledReason) card.append(element('p', 'fixture-meta', `Reason: ${user.disabledReason}`));
    const actions = element('div', 'account-actions');
    const act = (label, handler) => { const button = element('button', 'button-secondary', label); button.type = 'button'; button.addEventListener('click', async () => { button.disabled = true; try { const result = await handler(); showMessage('users-message', result.message); await loadUsers(); } catch (error) { showMessage('users-message', error.message, true); button.disabled = false; } }); actions.append(button); };
    if (!user.disabled) {
      act('Send reset link', () => mutate(`/api/admin/users/${user.id}/reset-password`, 'POST'));
      act('Deactivate', () => { if (!window.confirm(`Deactivate ${user.email}? They will be signed out everywhere.`)) return Promise.reject(new Error('Cancelled.')); const reason = window.prompt('Reason (optional)') || ''; return mutate(`/api/admin/users/${user.id}/deactivate`, 'POST', { reason }); });
    } else {
      act('Reactivate', () => mutate(`/api/admin/users/${user.id}/reactivate`, 'POST'));
    }
    card.append(actions); list.append(card);
  }
}
$('#refresh-users').addEventListener('click', async () => { try { await loadUsers(); showMessage('users-message', 'Members refreshed.'); } catch (error) { showMessage('users-message', error.message, true); } });
let userSearchTimer = null;
$('#user-search').addEventListener('input', () => { clearTimeout(userSearchTimer); userSearchTimer = setTimeout(() => { loadUsers().catch((error) => showMessage('users-message', error.message, true)); }, 300); });

async function loadOperations() {
  try {
    const { operations } = await request('/api/admin/operations');
    const stop = operations.emergencyStop;
    $('#ops-status').textContent = stop.emergencyStop
      ? `Emergency stop is ACTIVE${stop.reason ? ` — ${stop.reason}` : ''}${stop.updatedAt ? ` (${new Date(stop.updatedAt).toLocaleString()})` : ''}.`
      : `Emergency stop is cleared${stop.updatedAt ? ` (${new Date(stop.updatedAt).toLocaleString()})` : ''}. Betting execution is still disabled.`;
    const counts = operations.submissionCounts || {};
    const alerts = operations.alerts || [];
    $('#ops-counts').textContent = `Submissions — queued ${counts.queued ?? 0}, unknown ${counts.unknown ?? 0}, accepted ${counts.accepted ?? 0}. Recovery worker: ${operations.worker?.state || 'unknown'}.${alerts.length ? ` Alerts: ${alerts.join(', ')}.` : ''}`;
    $('#ops-engage').disabled = stop.emergencyStop === true;
  } catch (error) { showMessage('ops-message', error.message, true); }
}
$('#ops-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#ops-engage'); button.disabled = true;
  try {
    await mutate('/api/admin/emergency-stop', 'PATCH', { enabled: true, reason: $('#ops-reason').value.trim() });
    $('#ops-form').reset(); showMessage('ops-message', 'Emergency stop engaged.');
  } catch (error) { showMessage('ops-message', error.message, true); }
  await loadOperations();
});

// Dashboard pages. Each section carries data-view; a tab is offered only when one of its sections is allowed for this role
// (the role logic above uses the `hidden` attribute, so page switching uses a separate class and never overrides it).
const VIEW_ORDER = ['overview', 'betting', 'accounts', 'applications', 'members', 'operations'];
let activeView = null;
function viewSections(view) { return [...document.querySelectorAll(`#dashboard [data-view="${view}"]`)]; }
function availableViews() { return VIEW_ORDER.filter((view) => viewSections(view).some((node) => !node.hidden)); }
function showView(view) {
  const views = availableViews();
  activeView = views.includes(view) ? view : views[0];
  for (const name of VIEW_ORDER) for (const node of viewSections(name)) node.classList.toggle('view-off', name !== activeView);
  for (const tab of document.querySelectorAll('#view-nav [data-tab]')) {
    tab.hidden = !views.includes(tab.dataset.tab);
    const current = tab.dataset.tab === activeView; tab.classList.toggle('active', current);
    if (current) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
}
function setupViews(forceView) {
  const wanted = forceView || window.location.hash.slice(1);
  showView(wanted);
  if (window.location.hash.slice(1) !== activeView) history.replaceState(null, '', `#${activeView}`);
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', () => { if (!$('#dashboard').hidden) { showView(window.location.hash.slice(1)); window.scrollTo({ top: 0 }); } });


// ---------------------------------------------------------------------------------------------------------------------
// Betting workspace: search a game -> pick odds from its markets -> build a ticket with a max-profit cap.
// Odds are read-only SportyBet data. The server re-verifies every selection before it saves a ticket.
// ---------------------------------------------------------------------------------------------------------------------
const readSpecifier = (specifier) => String(specifier || '').split('|').map((part) => (part.includes('=') ? part.split('=')[1] : part)).join(' · ');
const marketTitle = (market) => `${market.marketName || 'Market'}${market.specifier ? ` (${readSpecifier(market.specifier)})` : ''}`;
const usableOdds = (outcome) => outcome.active === true && Number.isFinite(Number(outcome.odds)) && Number(outcome.odds) > 1;
const activeMarket = (markets, leg) => markets.find((item) => item.marketId === leg.marketId && (item.specifier || '') === (leg.specifier || '') && item.status === 'active');
const sameSelection = (leg, game, market, outcome) => leg.eventId === game.eventId && leg.marketId === market.marketId && (leg.specifier || '') === (market.specifier || '') && leg.outcomeId === outcome.outcomeId;
const kickoffText = (iso) => (iso ? new Date(iso).toLocaleString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Time not available');

function liveBadge(game) {
  const wrap = element('span', 'live-badge');
  wrap.append(element('span', 'live-dot'), document.createTextNode(['LIVE', game.score, game.clock].filter(Boolean).join(' · ')));
  return wrap;
}

function stopLiveRefresh() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
// A live game's odds list refreshes itself (every 5 s) while it is open and visible. Ticket selections keep the odds you tapped until you
// press "Refresh odds" or save, so a price never changes under you without notice.
function startLiveRefresh() {
  stopLiveRefresh();
  if (!openGame?.isLive) return;
  const eventId = openGame.eventId;
  liveTimer = setInterval(async () => {
    if (liveRefreshing || document.hidden || !openGame || openGame.eventId !== eventId || $('#markets-section').hidden || $('#markets-section').classList.contains('view-off')) return;
    liveRefreshing = true; // never stack a new request on a slow one
    try { const fresh = await fetchGame(eventId); if (openGame?.eventId === eventId) { openGame = fresh; renderMarkets(); if (!fresh.isLive) stopLiveRefresh(); } } catch { /* keep the last odds on screen; the next tick retries */ }
    finally { liveRefreshing = false; }
  }, LIVE_REFRESH_MS);
}

function resetWorkspace() {
  stopLiveRefresh(); openGame = null; sportyAccounts = [];
  ticket.legs = []; ticket.submitKey = null; ticket.submitPayload = null;
  $('#game-results').replaceChildren(); $('#game-search-input').value = ''; $('#markets-section').hidden = true;
  $('#ticket-stake').value = ''; $('#ticket-max-profit').value = '';
  showMessage('game-search-message'); showMessage('ticket-message');
  renderTicket();
}

function renderTicketAccounts() {
  const select = $('#ticket-account'); const previous = select.value;
  select.replaceChildren();
  if (!sportyAccounts.length) { const none = element('option', '', 'No SportyBet account record yet'); none.value = ''; select.append(none); }
  for (const account of sportyAccounts) { const option = element('option', '', account.displayName); option.value = account.id; select.append(option); }
  if (sportyAccounts.some((account) => account.id === previous)) select.value = previous;
  updateTicketSummary();
}

$('#game-search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('#game-search-input').value.trim(); const button = $('#game-search-button');
  if (query.length < 2) return showMessage('game-search-message', 'Type at least 2 characters of the game.', true);
  button.disabled = true; button.textContent = 'Searching…'; showMessage('game-search-message');
  try {
    const data = await request(`/api/sportybet/search?q=${encodeURIComponent(query)}`);
    renderGameResults(data, query);
  } catch (error) { $('#game-results').replaceChildren(); showMessage('game-search-message', error.message, true); }
  finally { button.disabled = false; button.textContent = 'Search'; }
});

function renderGameResults(data, query) {
  const list = $('#game-results'); list.replaceChildren();
  if (!data.fixtures.length) { list.append(element('p', 'empty-state', `No upcoming or live game matches “${query}”${data.scanned ? ` (${data.scanned.toLocaleString('en-NG')} games checked; SportyBet total ${data.diag?.upstreamTotal}, page 1 gave ${data.diag?.firstPage}, failed pages ${data.diag?.failedPages}, live ${data.diag?.live})` : ''}. Check the spelling or try just one team.`)); if (data.liveAvailable === false) list.append(element('p', 'muted small', 'Live games could not be loaded right now.')); return; }
  for (const fixture of data.fixtures) {
    const card = element('article', 'account-card'); const top = element('div', 'account-card-top'); const identity = element('div');
    identity.append(element('strong', '', `${fixture.homeTeam} vs ${fixture.awayTeam}`), element('small', '', [fixture.category, fixture.tournament].filter(Boolean).join(' · ')));
    if (fixture.isLive) identity.append(liveBadge(fixture));
    const open = element('button', '', 'Show odds'); open.type = 'button';
    open.addEventListener('click', async () => { open.disabled = true; try { await openGameMarkets(fixture.eventId); } finally { open.disabled = false; } });
    top.append(identity, open); card.append(top, element('p', 'fixture-meta', fixture.isLive ? 'In play now — odds move quickly.' : `Kick-off ${kickoffText(fixture.startTime)}`)); list.append(card);
  }
  if (data.truncated) list.append(element('p', 'muted small', 'More games match. Add a team name to narrow the search.'));
  if (data.liveAvailable === false) list.append(element('p', 'muted small', 'Live games could not be loaded right now, so only upcoming games are shown.'));
}

async function fetchGame(eventId) { return request(`/api/sportybet/events/${encodeURIComponent(eventId)}/markets`); }

async function openGameMarkets(eventId) {
  showMessage('game-search-message');
  try { openGame = await fetchGame(eventId); }
  catch (error) { return showMessage('game-search-message', error.message, true); }
  $('#market-filter').value = ''; renderMarkets(); startLiveRefresh();
  $('#markets-section').hidden = false; $('#markets-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderMarkets() {
  if (!openGame) return;
  $('#markets-title').textContent = openGame.label;
  $('#markets-eyebrow').textContent = openGame.isLive ? 'LIVE ODDS' : 'ODDS';
  const when = openGame.isLive ? ['In play', openGame.score, openGame.clock].filter(Boolean).join(' · ') : `Kick-off ${kickoffText(openGame.startTime)}`;
  $('#markets-meta').textContent = `${when} · odds fetched ${new Date(openGame.fetchedAt).toLocaleTimeString()}${openGame.isLive ? ` · updates every ${LIVE_REFRESH_MS / 1000} seconds` : ''} · tap an odd to add it to your ticket.`;
  const notices = [];
  if (openGame.complete === false) notices.push('SportyBet only returned its core markets for this game right now, so some markets may be missing.');
  { const counts = {}; for (const m of openGame.markets) counts[m.status] = (counts[m.status] || 0) + 1; notices.push(`[debug] ${openGame.markets.length} markets received, status counts ${JSON.stringify(counts)}, with usable odds: ${openGame.markets.filter((m) => m.outcomes.some(usableOdds)).length}`); }  if (openGame.isLive) notices.push('This game is live. Odds can change or close at any moment. When you save, a lower price is refused and you will be asked to review.');
    { const sample = openGame.markets.filter((m) => m.status === 'unknown').slice(0, 2).map((m) => ({ name: m.marketName, rawStatus: m.rawStatus, outcomes: m.outcomes.slice(0, 3).map((o) => ({ n: o.name, odds: o.odds, rawActive: o.rawActive })) })); notices.push(`[debug2] ${JSON.stringify(sample)}`); }
  $('#markets-notice').hidden = !notices.length; $('#markets-notice').textContent = notices.join(' ');
  const filter = $('#market-filter').value.trim().toLowerCase(); const list = $('#markets-list'); list.replaceChildren();
  const markets = openGame.markets.filter((market) => market.status === 'active' && market.outcomes.some(usableOdds)
    && (!filter || `${marketTitle(market)} ${market.outcomes.map((outcome) => outcome.name).join(' ')}`.toLowerCase().includes(filter)));
  if (!markets.length) { list.append(element('p', 'empty-state', filter ? 'No market matches that filter.' : 'No open markets for this game right now.')); return; }
  for (const market of markets) {
    const card = element('article', 'market-card'); card.append(element('h3', '', marketTitle(market)));
    const grid = element('div', 'odds-grid');
    for (const outcome of market.outcomes) {
      const selected = ticket.legs.some((leg) => sameSelection(leg, openGame, market, outcome));
      const button = element('button', `odd-button${selected ? ' selected' : ''}`); button.type = 'button';
      button.setAttribute('aria-pressed', String(selected)); button.disabled = !usableOdds(outcome);
      button.append(element('span', 'odd-name', outcome.name || 'Outcome'), element('strong', 'odd-value', usableOdds(outcome) ? Number(outcome.odds).toFixed(2) : '—'));
      button.addEventListener('click', () => toggleSelection(market, outcome));
      grid.append(button);
    }
    card.append(grid); list.append(card);
  }
}
$('#market-filter').addEventListener('input', renderMarkets);
$('#markets-refresh').addEventListener('click', async () => {
  if (!openGame) return; const button = $('#markets-refresh'); button.disabled = true;
  try { openGame = await fetchGame(openGame.eventId); renderMarkets(); } catch (error) { showMessage('game-search-message', error.message, true); }
  finally { button.disabled = false; }
});

function toggleSelection(market, outcome) {
  showMessage('ticket-message');
  const existing = ticket.legs.findIndex((leg) => leg.eventId === openGame.eventId);
  if (existing >= 0 && sameSelection(ticket.legs[existing], openGame, market, outcome)) ticket.legs.splice(existing, 1);
  else {
    if (existing < 0 && ticket.legs.length >= MAX_LEGS) return showMessage('ticket-message', `A ticket can have at most ${MAX_LEGS} selections.`, true);
    const leg = { eventId: openGame.eventId, eventLabel: openGame.label, marketId: market.marketId, specifier: market.specifier || '', marketLabel: marketTitle(market), outcomeId: outcome.outcomeId, outcomeName: outcome.name || 'Outcome', oddsDecimal: Number(outcome.odds) };
    if (existing >= 0) ticket.legs[existing] = leg; else ticket.legs.push(leg);
  }
  renderMarkets(); renderTicket();
}

function renderTicket() {
  const box = $('#ticket-legs'); box.replaceChildren();
  $('#ticket-count').textContent = `${ticket.legs.length} selection${ticket.legs.length === 1 ? '' : 's'}`;
  if (!ticket.legs.length) box.append(element('p', 'empty-state', 'No selections yet. Search for a game and tap an odd to add it.'));
  for (const leg of ticket.legs) {
    const row = element('article', 'ticket-leg'); const info = element('div');
    info.append(element('strong', '', leg.eventLabel), element('small', '', `${leg.marketLabel}: ${leg.outcomeName}`));
    const odds = element('span', 'leg-odds', leg.oddsDecimal.toFixed(2));
    const remove = element('button', 'button-secondary', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${leg.eventLabel}`);
    remove.addEventListener('click', () => { ticket.legs = ticket.legs.filter((item) => item !== leg); showMessage('ticket-message'); renderMarkets(); renderTicket(); });
    row.append(info, odds, remove); box.append(row);
  }
  updateTicketSummary();
}

function currentSummary() {
  return summarizeTicket({ oddsList: ticket.legs.map((leg) => leg.oddsDecimal), stakeMinor: nairaToMinor($('#ticket-stake').value), maxNetProfitMinor: nairaToMinor($('#ticket-max-profit').value) });
}

// The stake is not typed. It is the largest stake whose profit stays within the max profit at the current odds.
function syncAutoStake() {
  const stakeBox = $('#ticket-stake');
  const profitMinor = nairaToMinor($('#ticket-max-profit').value);
  const odds = ticket.legs.length ? combinedOdds(ticket.legs.map((leg) => leg.oddsDecimal)) : 0;
  if (profitMinor === null || profitMinor < 100 || !(odds > 1)) { stakeBox.value = ''; return; }
  let stake = Math.floor(profitMinor / (odds - 1));
  while (stake > 0 && Math.floor(stake * (odds - 1)) > profitMinor) stake -= 1;
  stakeBox.value = stake >= 100 ? (stake / 100).toFixed(2) : '';
}

function updateTicketSummary() {
  syncAutoStake();
  const summary = ticket.legs.length ? currentSummary() : null; const list = $('#ticket-summary'); list.replaceChildren();
  const hint = $('#ticket-hint'); hint.classList.remove('form-error');
  const submit = $('#ticket-submit');
  $('#ticket-refresh').disabled = !ticket.legs.length; $('#ticket-clear').disabled = !ticket.legs.length;
  if (!summary) { list.hidden = true; hint.textContent = ''; submit.disabled = true; return; }
  const row = (label, value, className) => { const wrap = element('div', className); wrap.append(element('dt', '', label), element('dd', '', value)); list.append(wrap); };
  if (summary.combinedOdds) row(ticket.legs.length > 1 ? 'Combined odds' : 'Odds', summary.combinedOdds.toFixed(2));
  if (summary.error) {
    list.hidden = !summary.combinedOdds; hint.textContent = /^Enter a stake/.test(summary.error) ? 'Enter your max profit and the stake fills in automatically.' : summary.error; submit.disabled = true;
    if (nairaToMinor($('#ticket-stake').value) !== null && nairaToMinor($('#ticket-max-profit').value) !== null) hint.classList.add('form-error');
    return;
  }
  const enteredMinor = nairaToMinor($('#ticket-stake').value);
  row('Stake (automatic)', minorToNaira(summary.effectiveStakeMinor), summary.stakeAdjusted ? 'adjusted' : '');
  row('Potential profit', minorToNaira(summary.potentialNetProfitMinor)); row('Potential return', minorToNaira(summary.potentialReturnMinor));
  list.hidden = false;
  hint.textContent = summary.stakeAdjusted ? `Stake lowered from ${minorToNaira(enteredMinor)} to ${minorToNaira(summary.effectiveStakeMinor)} so the profit stays within your ${minorToNaira(nairaToMinor($('#ticket-max-profit').value))} cap.` : 'Stake is worked out from your max profit and the current odds. Profit excludes the stake you get back.';
  submit.disabled = !$('#ticket-account').value;
  if (!$('#ticket-account').value) hint.textContent = 'Add a SportyBet account record in Accounts, then pick it here.';
}
for (const id of ['#ticket-stake', '#ticket-max-profit', '#ticket-account']) $(id).addEventListener('input', () => { showMessage('ticket-message'); updateTicketSummary(); });
$('#ticket-clear').addEventListener('click', () => { ticket.legs = []; showMessage('ticket-message'); renderMarkets(); renderTicket(); });

// Re-reads every game on the ticket and updates odds. Selections that closed or whose game started are removed.
async function refreshTicketOdds() {
  const ids = [...new Set(ticket.legs.map((leg) => leg.eventId))]; const notes = { changed: 0, removed: 0 };
  for (const eventId of ids) {
    let game = null;
    try { game = await fetchGame(eventId); } catch { /* an unreadable game is treated as closed below */ }
    if (openGame && openGame.eventId === eventId && game) openGame = game;
    for (const leg of ticket.legs.filter((item) => item.eventId === eventId)) {
      const market = game && (game.matchStatus === 'not_started' || game.isLive) ? activeMarket(game.markets, leg) : null;
      const outcome = market?.outcomes.find((item) => item.outcomeId === leg.outcomeId && usableOdds(item));
      if (!outcome) { ticket.legs = ticket.legs.filter((item) => item !== leg); notes.removed += 1; continue; }
      if (Math.abs(Number(outcome.odds) - leg.oddsDecimal) > 0.000001) { leg.oddsDecimal = Number(outcome.odds); notes.changed += 1; }
    }
  }
  renderMarkets(); renderTicket();
  return notes;
}
$('#ticket-refresh').addEventListener('click', async () => {
  const button = $('#ticket-refresh'); button.disabled = true; showMessage('ticket-message');
  try { const notes = await refreshTicketOdds(); showMessage('ticket-message', `Odds refreshed: ${notes.changed} changed, ${notes.removed} removed.`, notes.removed > 0); }
  finally { updateTicketSummary(); }
});

// Ticket odds follow SportyBet on their own: every 10 s while the ticket is on screen. A closed market drops its selection.
const TICKET_REFRESH_MS = 10000;
let ticketAutoRefreshing = false;
setInterval(async () => {
  if (ticketAutoRefreshing || document.hidden || !ticket.legs.length || $('#ticket-form').offsetParent === null) return;
  if ($('#ticket-submit').textContent === 'Checking odds…' || $('#ticket-refresh').disabled) return; // not while saving or refreshing by hand
  ticketAutoRefreshing = true;
  try {
    const notes = await refreshTicketOdds();
    if (notes.changed || notes.removed) showMessage('ticket-message', `Odds updated: ${notes.changed} changed, ${notes.removed} removed.`, notes.removed > 0);
  } catch { /* keep the current odds; the next tick retries */ }
  finally { ticketAutoRefreshing = false; }
}, TICKET_REFRESH_MS);

$('#ticket-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const summary = ticket.legs.length ? currentSummary() : null;
  if (!summary || summary.error) return showMessage('ticket-message', summary?.error || 'Add a selection first.', true);
  const stakeMinor = nairaToMinor($('#ticket-stake').value); const maxNetProfitMinor = nairaToMinor($('#ticket-max-profit').value);
  const [first] = ticket.legs;
  const base = { accountId: $('#ticket-account').value, stakeMinor, maxNetProfitMinor };
  const payload = ticket.legs.length === 1
    ? { ...base, eventId: first.eventId, marketId: first.marketId, specifier: first.specifier, outcomeId: first.outcomeId, oddsDecimal: first.oddsDecimal, eventLabel: first.eventLabel, selectionLabel: `${first.marketLabel}: ${first.outcomeName}`.slice(0, 160) }
    : { ...base, legs: ticket.legs.map((leg) => ({ eventId: leg.eventId, marketId: leg.marketId, specifier: leg.specifier, outcomeId: leg.outcomeId, oddsDecimal: leg.oddsDecimal })) };
  // The same key is reused only for an identical retry, so a dropped connection cannot create a second ticket.
  const fingerprint = JSON.stringify(payload);
  if (ticket.submitPayload !== fingerprint) { ticket.submitKey = crypto.randomUUID(); ticket.submitPayload = fingerprint; }
  const button = $('#ticket-submit'); button.disabled = true; button.textContent = 'Checking odds…'; showMessage('ticket-message');
  try {
    const result = await mutate('/api/bet-instructions', 'POST', { ...payload, idempotencyKey: ticket.submitKey });
    const saved = result.instruction;
    const reduced = saved.stakeAdjusted ? ` Your stake was lowered to ${minorToNaira(saved.stakeMinor)} at odds ${Number(saved.oddsDecimal).toFixed(2)} to respect your max profit.` : ` Stake ${minorToNaira(saved.stakeMinor)} at odds ${Number(saved.oddsDecimal).toFixed(2)}.`;
    ticket.legs = []; ticket.submitKey = null; ticket.submitPayload = null; $('#ticket-stake').value = ''; $('#ticket-max-profit').value = '';
    renderMarkets(); renderTicket();
    showMessage('ticket-message', `${result.replayed ? 'This ticket was already saved.' : 'Ticket saved and waiting for your approval.'}${reduced} Nothing was sent to SportyBet.`);
  } catch (error) {
    if (['ODDS_CHANGED', 'OUTCOME_UNAVAILABLE', 'EVENT_UNAVAILABLE'].includes(error.code)) {
      const notes = await refreshTicketOdds();
      showMessage('ticket-message', `${error.message} Your ticket now shows the latest odds (${notes.changed} changed, ${notes.removed} removed). Review it and save again.`, true);
    } else showMessage('ticket-message', error.message, true);
  } finally { button.textContent = 'Save ticket for review'; updateTicketSummary(); }
});

renderTicket();
