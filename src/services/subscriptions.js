export const SUBSCRIPTION_DAYS = 30;
export const OPEN_APPLICATION_STATUSES = Object.freeze(['pending', 'approved_awaiting_payment']);

const DAY_MS = 24 * 60 * 60 * 1000;

// Returns [{ bookmaker, startedAt, expiresAt }]. Users created before multi-bookmaker support only have
// `bookmaker` + `subscriptionExpiresAt`, so those are mapped to a single subscription (a missing expiry is NOT treated as unlimited; see backfillLegacyExpiry).
export function subscriptionsOf(user) {
  if (!user) return [];
  if (Array.isArray(user.subscriptions)) return user.subscriptions.filter((item) => item?.bookmaker);
  if (user.bookmaker) return [{ bookmaker: user.bookmaker, startedAt: user.subscriptionStartedAt || null, expiresAt: user.subscriptionExpiresAt || null }];
  return [];
}

export function isActive(subscription, now = new Date()) {
  // A subscription without an expiry date is inactive: every paid period is exactly 30 days, so none is open-ended.
  return Boolean(subscription.expiresAt) && new Date(subscription.expiresAt) > now;
}

export function activeBookmakers(user, now = new Date()) {
  return subscriptionsOf(user).filter((item) => isActive(item, now)).map((item) => item.bookmaker);
}

export function hasActiveSubscription(user, bookmaker, now = new Date()) {
  return activeBookmakers(user, now).includes(bookmaker);
}

export function hasSubscriptionRecord(user, bookmaker) {
  return subscriptionsOf(user).some((item) => item.bookmaker === bookmaker);
}

// Owners are never gated. Members are expired only when they have subscriptions and none is still active.
export function isSubscriptionExpired(user, now = new Date()) {
  if (!user || user.role === 'owner') return false;
  const subs = subscriptionsOf(user);
  return subs.length > 0 && !subs.some((item) => isActive(item, now));
}

export function canUseBookmaker(user, bookmaker, now = new Date()) {
  if (user?.role === 'owner') return true;
  return hasActiveSubscription(user, bookmaker, now);
}

export function allowedBookmakers(user, now = new Date()) {
  return activeBookmakers(user, now);
}

// Latest expiry across all subscriptions (what the legacy `subscriptionExpiresAt` field now mirrors).
export function latestExpiry(user) {
  const subs = subscriptionsOf(user);
  if (!subs.length || subs.some((item) => !item.expiresAt)) return null;
  return new Date(Math.max(...subs.map((item) => new Date(item.expiresAt).getTime())));
}

// Adds or renews one bookmaker. A renewal while still active extends from the current expiry, so no paid time is lost.
export function grantSubscription(user, bookmaker, now = new Date(), days = SUBSCRIPTION_DAYS) {
  const subs = subscriptionsOf(user).map((item) => ({ ...item }));
  const existing = subs.find((item) => item.bookmaker === bookmaker);
  const base = existing && existing.expiresAt && new Date(existing.expiresAt) > now ? new Date(existing.expiresAt) : now;
  const expiresAt = new Date(base.getTime() + days * DAY_MS);
  if (existing) { existing.expiresAt = expiresAt; existing.reminders = {}; } // a new period starts a fresh reminder cycle
  else subs.push({ bookmaker, startedAt: now, expiresAt });
  const next = { ...user, subscriptions: subs };
  return { subscriptions: subs, bookmakerExpiresAt: expiresAt, subscriptionExpiresAt: latestExpiry(next) };
}

export function publicSubscriptions(user, now = new Date()) {
  return subscriptionsOf(user).map((item) => ({ bookmaker: item.bookmaker, startedAt: item.startedAt || null, expiresAt: item.expiresAt || null, active: isActive(item, now) }));
}

// One application per email per bookmaker. Returns { code, message } when the application must be refused.
export function applicationBlock({ user, pending, bookmaker, now = new Date() }) {
  if (user?.role === 'owner') return { code: 'ACCOUNT_EXISTS', message: 'An account already exists for this email.' };
  if (pending) return { code: 'APPLICATION_EXISTS', message: 'An application for this email and bookmaker is already being processed.' };
  if (user && hasActiveSubscription(user, bookmaker, now)) return { code: 'RENEWAL_REQUIRED', message: 'You already have an active subscription for this bookmaker. Sign in and renew it from your dashboard.' };
  return null;
}

const REMINDER_STAGES = Object.freeze([{ key: 'd7', ms: 7 * DAY_MS }, { key: 'd3', ms: 3 * DAY_MS }, { key: 'd1', ms: DAY_MS }]);
const EXPIRED_NOTICE_WINDOW_MS = 3 * DAY_MS;

// Which reminder (if any) is due for each subscription. Only the most urgent stage is returned, and the less urgent
// ones it supersedes are listed in `covers`, so someone who joins late is not sent a backlog of emails.
export function dueReminders(user, now = new Date()) {
  if (!user || user.role === 'owner') return [];
  const due = [];
  for (const item of subscriptionsOf(user)) {
    if (!item.expiresAt) continue;
    const expiresAt = new Date(item.expiresAt);
    const remaining = expiresAt.getTime() - now.getTime();
    const sent = item.reminders || {};
    if (remaining <= 0) {
      if (-remaining <= EXPIRED_NOTICE_WINDOW_MS && !sent.expired) due.push({ bookmaker: item.bookmaker, key: 'expired', covers: ['d7', 'd3', 'd1', 'expired'], expiresAt });
      continue;
    }
    const reached = REMINDER_STAGES.filter((stage) => remaining <= stage.ms);
    if (!reached.length) continue;
    const current = reached[reached.length - 1];
    if (sent[current.key]) continue;
    due.push({ bookmaker: item.bookmaker, key: current.key, covers: reached.map((stage) => stage.key), expiresAt });
  }
  return due;
}
