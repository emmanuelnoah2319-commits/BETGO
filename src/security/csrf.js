import { randomBytes, timingSafeEqual } from 'node:crypto';

export function createCsrfToken() {
  return randomBytes(32).toString('base64url');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookieToken = req.cookies?.betgo_csrf;
  const headerToken = req.get('x-csrf-token');
  if (!safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ error: { code: 'CSRF_INVALID', message: 'CSRF token missing or invalid' } });
  }
  next();
}
