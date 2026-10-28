const $ = (selector) => document.querySelector(selector);
$('#year').textContent = String(new Date().getFullYear());

const nairaToKobo = (value) => Math.round(Number(value) * 100);
const koboToNaira = (value) => (Number(value) / 100).toFixed(2);

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || 'Request failed');
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
  top.append(identity, element('span', 'pill', account.connectionStatus === 'connected' ? 'Connected' : 'Not connected'));
  card.append(top, element('p', 'account-notes', account.notes || 'No notes added.'));
  const details = element('div', 'account-details');
  details.append(element('span', '', `Activity: ${account.enabledForNewActivity ? 'enabled' : 'disabled'}`), element('span', '', 'Balance: not available'));
  const actions = element('div', 'account-actions'); const edit = element('button', 'button-secondary', 'Edit details');
  edit.type = 'button'; edit.addEventListener('click', () => openEditForm(account, card)); actions.append(edit); card.append(details, actions); return card;
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
  const selector = $('#instruction-account'); const selected = selector.value;
  selector.replaceChildren(element('option', '', accounts.length ? 'Choose an account' : 'Add an account record first')); selector.options[0].value = '';
  for (const account of accounts) { const option = element('option', '', `${account.displayName} — ${account.platform}`); option.value = account.id; selector.append(option); }
  if (accounts.some((account) => account.id === selected)) selector.value = selected;
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
async function loadSafetyPolicy() {
  const { policy } = await request('/api/safety-policy');
  $('#max-stake').value = koboToNaira(policy.maxStakeMinor); $('#daily-stake').value = koboToNaira(policy.dailyStakeLimitMinor);
  $('#daily-loss').value = koboToNaira(policy.dailyLossLimitMinor); $('#account-daily-stake').value = koboToNaira(policy.perAccountDailyStakeLimitMinor);
  $('#max-open').value = String(policy.maxOpenInstructions);
}
function renderInstruction(item) {
  const card = element('article', 'account-card'); const top = element('div', 'account-card-top'); const identity = element('div');
  identity.append(element('strong', '', item.eventLabel), element('small', '', `${item.selectionLabel} · ${item.accountLabel}`));
  top.append(identity, element('span', 'pill', item.status.replaceAll('_', ' ')));
  card.append(top, element('p', 'account-notes', `Stake: ₦${koboToNaira(item.stakeMinor)} · ${item.platform}`));
  if (item.notes) card.append(element('p', 'account-notes', item.notes));
  card.append(element('p', 'muted small', 'Recorded for review only. No bookmaker submission has occurred.'));
  const actions = element('div', 'instruction-actions');
  if (item.status === 'awaiting_approval') {
    const approve = element('button', '', 'Approve for next stage'); approve.type = 'button';
    approve.addEventListener('click', async () => { approve.disabled = true; approve.textContent = 'Approving…'; try { await mutate(`/api/bet-instructions/${encodeURIComponent(item.id)}/approve`, 'POST'); showMessage('instruction-message', 'Approved for the next workflow stage. No bet was submitted.'); await loadInstructions(); } catch (error) { showMessage('instruction-message', error.message, true); approve.disabled = false; approve.textContent = 'Approve for next stage'; } });
    actions.append(approve);
  }
  if (['awaiting_approval', 'approved_not_submitted'].includes(item.status)) {
    const reject = element('button', 'button-secondary', 'Reject instruction'); reject.type = 'button';
    reject.addEventListener('click', async () => { reject.disabled = true; reject.textContent = 'Rejecting…'; try { await mutate(`/api/bet-instructions/${encodeURIComponent(item.id)}/reject`, 'POST'); showMessage('instruction-message', 'Instruction rejected. Reserved exposure released.'); await loadInstructions(); } catch (error) { showMessage('instruction-message', error.message, true); reject.disabled = false; reject.textContent = 'Reject instruction'; } });
    actions.append(reject);
  }
  if (['prepared', 'awaiting_approval', 'approved_not_submitted'].includes(item.status)) {
    const cancel = element('button', 'button-secondary', 'Cancel instruction'); cancel.type = 'button';
    cancel.addEventListener('click', async () => { cancel.disabled = true; cancel.textContent = 'Cancelling…'; try { await mutate(`/api/bet-instructions/${encodeURIComponent(item.id)}/cancel`, 'POST'); showMessage('instruction-message', 'Instruction cancelled. Reserved exposure released.'); await loadInstructions(); } catch (error) { showMessage('instruction-message', error.message, true); cancel.disabled = false; cancel.textContent = 'Cancel instruction'; } });
    actions.append(cancel);
  }
  if (actions.childElementCount) card.append(actions);
  return card;
}
async function loadInstructions() {
  const { instructions } = await request('/api/bet-instructions'); const list = $('#instruction-list'); list.replaceChildren();
  if (!instructions.length) list.append(element('p', 'empty-state', 'No instructions yet. Creating one records your plan; it does not place a bet.'));
  else list.append(...instructions.map(renderInstruction));
}
async function loadDashboard() {
  try {
    const { user } = await request('/api/me'); $('#welcome').textContent = `Signed in as ${user.email}`;
    $('#login-panel').hidden = true; $('#dashboard').hidden = false; $('#dashboard-error').hidden = true;
    $('#admin-applications-section').hidden = user.role !== 'owner';
    $('#member-subscription-panel').hidden = user.role === 'owner';
    if (user.role !== 'owner') {
      $('#member-bookmaker').textContent = user.bookmaker || 'Not assigned';
      const expiry = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt) : null;
      $('#member-expiry').textContent = expiry && !Number.isNaN(expiry.getTime()) ? expiry.toLocaleDateString() : 'Not available';
      const days = expiry ? Math.max(0, Math.ceil((expiry.getTime() - Date.now()) / 86400000)) : null;
      $('#member-days-left').textContent = days === null ? 'Contact support if this looks incorrect.' : days === 0 ? 'Subscription expired' : `${days} day${days === 1 ? '' : 's'} remaining`;
      for (const option of $('#account-platform').options) option.disabled = option.value !== user.bookmaker;
      if (user.bookmaker) $('#account-platform').value = user.bookmaker;
    } else { for (const option of $('#account-platform').options) option.disabled = false; }
    $('#password-change-panel').hidden = !user.mustChangePassword;
    if (user.mustChangePassword) return;
    await Promise.all([loadAccounts(), loadIntegrations(), loadSafetyPolicy(), loadInstructions(), ...(user.role === 'owner' ? [loadApplications()] : [])]);
  } catch (error) {
    if (error.message === 'Login required' || error.message.includes('Session')) return showLogin();
    $('#dashboard-error').hidden = false; $('#dashboard-error').textContent = error.message;
  }
}
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#login-button'); button.disabled = true; button.textContent = 'Signing in…'; $('#login-error').hidden = true;
  try { await mutate('/api/auth/login', 'POST', { email: $('#email').value, password: $('#password').value }); $('#password').value = ''; await async function loadPlans() { try { const { plans } = await request('/api/plans'); const select = $('#application-bookmaker'); for (const option of select.options) { const plan = plans.find((item) => item.bookmaker === option.value); if (plan) option.textContent = `${plan.bookmaker} — ₦${Number(plan.priceNgn).toLocaleString('en-NG')} / ${plan.durationDays} days`; } } catch { /* Keep the visible defaults if the plans endpoint is temporarily unavailable. */ } }
loadPlans();
loadDashboard(); }
  catch (error) { showLogin(error.message); }
  finally { button.disabled = false; button.innerHTML = 'Sign in <span aria-hidden="true">→</span>'; }
});
$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#create-account-button'); button.disabled = true; button.textContent = 'Adding…'; showDashboardMessage();
  try { await mutate('/api/accounts', 'POST', { displayName: $('#account-name').value.trim(), platform: $('#account-platform').value, notes: $('#account-notes').value.trim() }); $('#account-form').reset(); showDashboardMessage('Account record added. It is not connected to the bookmaker.'); await loadAccounts(); }
  catch (error) { showDashboardMessage(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Add account record'; }
});
$('#load-sportybet-fixtures').addEventListener('click', async () => {
  const button = $('#load-sportybet-fixtures'); const list = $('#sportybet-fixtures-list');
  button.disabled = true; button.textContent = 'Loading…'; showMessage('sportybet-fixtures-message');
  try {
    const result = await request('/api/sportybet/fixtures?limit=30&timeline=168');
    list.replaceChildren();
    if (!result.fixtures.length) list.append(element('p', 'empty-state', 'SportyBet returned no upcoming fixtures for this window.'));
    for (const fixture of result.fixtures) {
      const card = element('article', 'fixture-card');
      card.append(element('strong', '', `${fixture.homeTeam} vs ${fixture.awayTeam}`));
      card.append(element('p', 'fixture-meta', `${fixture.tournament || 'Football'} · ${fixture.startTime ? new Date(fixture.startTime).toLocaleString() : 'Start time unavailable'}`));
      const odds = element('div', 'fixture-odds');
      const market = fixture.markets.find((item) => item.marketId === '1' && Array.isArray(item.outcomes));
      if (market) {
        for (const outcome of market.outcomes) {
          const label = outcome.name || `Outcome ${outcome.outcomeId}`;
          const price = Number(outcome.odds);
          const hasPrice = Number.isFinite(price) && price > 1;
          const priceText = hasPrice ? price.toFixed(2) : '—';
          const row = element('div', 'fixture-outcome');
          row.append(element('span', '', `${label}: ${priceText}`));
          const use = element('button', 'button-secondary fixture-use-selection', 'Use selection');
          use.type = 'button';
          use.disabled = !hasPrice || outcome.active !== true || fixture.matchStatus !== 'not_started';
          use.title = use.disabled ? 'This outcome is inactive or its price is unavailable.' : 'Copy this event and price snapshot into the review form.';
          use.addEventListener('click', () => {
            const account = [...$('#instruction-account').options].find((option) => option.value && option.textContent.includes('SportyBet'));
            if (account) $('#instruction-account').value = account.value;
            $('#instruction-event').value = `${fixture.homeTeam} vs ${fixture.awayTeam}`.slice(0, 160);
            const marketName = market.marketName || '1X2';
            const snapshotTime = result.fetchedAt ? new Date(result.fetchedAt).toLocaleString() : 'time unavailable';
            $('#instruction-selection').value = `${marketName}: ${label} @ ${priceText} (snapshot)` .slice(0, 160);
            const note = `SportyBet odds snapshot: ${priceText}; fetched ${snapshotTime}. Recheck odds before any manual bet. BETGO has not placed a bet.`;
            $('#instruction-notes').value = note.slice(0, 500);
            $('#instruction-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
            $('#instruction-stake').focus();
            showMessage('instruction-message', account ? 'Selection copied with a timestamped odds snapshot. Enter your stake and review before creating an instruction.' : 'Selection copied. Add a SportyBet account record, then choose it before creating the instruction.');
          });
          row.append(use);
          odds.append(row);
        }
      }
      if (odds.childElementCount) card.append(odds);
      else card.append(element('p', 'muted small', 'No 1X2 odds included in this response.'));
      list.append(card);
    }
    const time = result.fetchedAt ? new Date(result.fetchedAt).toLocaleTimeString() : 'unknown time';
    showMessage('sportybet-fixtures-message', `Received ${result.fixtures.length} fixtures · data timestamp ${time}${result.cached ? ' · cached response' : ''}. Odds are not guaranteed current.`);
  } catch (error) {
    list.replaceChildren(element('p', 'empty-state', 'No fixture data was loaded.'));
    showMessage('sportybet-fixtures-message', error.message, true);
  } finally { button.disabled = false; button.textContent = 'Load live fixtures'; }
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
  for (const item of applications) { const card = element('article', 'account-card'); card.append(element('strong', '', item.fullName), element('p', '', item.email), element('p', 'fixture-meta', `${item.bookmaker} · ₦${Number(item.priceNgn).toLocaleString('en-NG')} / 30 days · ${item.status}`));
    if (item.status === 'pending') { const actions = element('div', 'account-actions'); const approve = element('button', '', 'Approve & send payment link'); approve.type = 'button'; approve.addEventListener('click', async () => { approve.disabled = true; try { const result = await mutate(`/api/admin/applications/${encodeURIComponent(item.id)}/approve`, 'POST', {}); showMessage('applications-message', result.message); await loadApplications(); } catch (error) { showMessage('applications-message', error.message, true); approve.disabled = false; } }); const reject = element('button', 'button-secondary', 'Reject'); reject.type = 'button'; reject.addEventListener('click', async () => { const reason = window.prompt('Enter the reason for rejecting this application:'); if (!reason || reason.trim().length < 3) return; reject.disabled = true; try { const result = await mutate(`/api/admin/applications/${encodeURIComponent(item.id)}/reject`, 'POST', { reason: reason.trim() }); showMessage('applications-message', result.message); await loadApplications(); } catch (error) { showMessage('applications-message', error.message, true); reject.disabled = false; } }); actions.append(approve, reject); card.append(actions); }
    list.append(card);
  }
}
$('#refresh-applications').addEventListener('click', async () => { try { await loadApplications(); showMessage('applications-message', 'Applications refreshed.'); } catch (error) { showMessage('applications-message', error.message, true); } });
$('#password-change-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await mutate('/api/me/password', 'POST', { currentPassword: $('#temporary-password').value, newPassword: $('#new-password').value }); showMessage('password-change-message', result.message); await mutate('/api/auth/logout', 'POST'); showLogin('Password changed. Sign in with your new password.'); } catch (error) { showMessage('password-change-message', error.message, true); } });

$('#logout-button').addEventListener('click', async () => {
  try { await mutate('/api/auth/logout', 'POST'); showLogin(); }
  catch (error) { $('#dashboard-error').hidden = false; $('#dashboard-error').textContent = error.message; }
});
$('#limits-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#save-limits-button'); button.disabled = true; button.textContent = 'Saving…';
  try { await mutate('/api/safety-policy', 'PATCH', { maxStakeMinor: nairaToKobo($('#max-stake').value), dailyStakeLimitMinor: nairaToKobo($('#daily-stake').value), dailyLossLimitMinor: nairaToKobo($('#daily-loss').value), perAccountDailyStakeLimitMinor: nairaToKobo($('#account-daily-stake').value), maxOpenInstructions: Number($('#max-open').value) }); showMessage('limits-message', 'Safety limits saved. Existing reservations are not automatically released.'); await loadSafetyPolicy(); }
  catch (error) { showMessage('limits-message', error.message, true); }
  finally { button.disabled = false; button.textContent = 'Save safety limits'; }
});
$('#instruction-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#create-instruction-button'); button.disabled = true; button.textContent = 'Creating…';
  try { await mutate('/api/bet-instructions', 'POST', { accountId: $('#instruction-account').value, stakeMinor: nairaToKobo($('#instruction-stake').value), eventLabel: $('#instruction-event').value.trim(), selectionLabel: $('#instruction-selection').value.trim(), notes: $('#instruction-notes').value.trim(), idempotencyKey: crypto.randomUUID() }); $('#instruction-form').reset(); showMessage('instruction-message', 'Instruction created for review. No bet was submitted.'); await loadInstructions(); }
  catch (error) { showMessage('instruction-message', error.message, true); }
  finally { button.disabled = false; button.textContent = 'Create review instruction'; }
});
async function loadPlans() { try { const { plans } = await request('/api/plans'); const select = $('#application-bookmaker'); for (const option of select.options) { const plan = plans.find((item) => item.bookmaker === option.value); if (plan) option.textContent = `${plan.bookmaker} — ₦${Number(plan.priceNgn).toLocaleString('en-NG')} / ${plan.durationDays} days`; } } catch { /* Keep the visible defaults if the plans endpoint is temporarily unavailable. */ } }
loadPlans();
loadDashboard();
