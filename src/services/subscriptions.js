export const SUBSCRIPTION_DAYS = 30;
export const OPEN_APPLICATION_STATUSES = Object.freeze(['pending', 'approved_awaiting_payment']);

const DAY_MS = 24 * 60 * 60 * 1000;

// Returns [{ bookmaker, startedAt, expiresAt }]. Users created before multi-bookmaker support only have
// `bookmaker` + `subscriptionExpiresAt`, so those are mapped to a single subscription (null expiry = no expiry).
export function subscriptionsOf(user) {
  if (!user) return [];
  if (Array.isArray(user.subscriptions)) return user.subscriptions.filter((item) => item?.bookmaker);
  if (user.bookmaker) return [{ bookmaker: user.bookmaker, startedAt: user.subscriptionStartedAt || null, expiresAt: user.subscriptionExpiresAt || null }];
  return [];
}

export function isActive(subscription, now = new Date()) {
  return !subscription.expiresAt || new Date(subscription.expiresAt) > now;
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
  if (existing) existing.expiresAt = expiresAt;
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
