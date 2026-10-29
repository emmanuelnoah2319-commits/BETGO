import { publicSubscriptions } from './subscriptions.js';

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function publicUser(user, now = new Date()) {
  return {
    id: user._id.toString(),
    email: user.email,
    fullName: user.fullName || '',
    role: user.role,
    disabled: Boolean(user.disabledAt),
    disabledReason: user.disabledReason || null,
    mustChangePassword: user.mustChangePassword === true,
    subscriptions: publicSubscriptions(user, now),
    createdAt: user.createdAt || null
  };
}

// Owners are managed outside this workflow, and nobody can lock themselves out.
export function manageBlock(actor, target) {
  if (!target) return { status: 404, code: 'USER_NOT_FOUND', message: 'User not found.' };
  if (target.role === 'owner') return { status: 403, code: 'OWNER_PROTECTED', message: 'Owner accounts cannot be managed here.' };
  if (String(actor._id) === String(target._id)) return { status: 403, code: 'SELF_ACTION_BLOCKED', message: 'You cannot do this to your own account.' };
  return null;
}
