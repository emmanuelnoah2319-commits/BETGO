import { hashToken } from '../security/sessions.js';

export function requireAuth(db) {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.[req.app.locals.config.cookieName];
      if (!token) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Login required' } });
      const session = await db.collection('sessions').findOne({
        tokenHash: hashToken(token),
        revokedAt: null,
        expiresAt: { $gt: new Date() }
      });
      if (!session) return res.status(401).json({ error: { code: 'SESSION_INVALID', message: 'Session expired or revoked' } });
      const user = await db.collection('users').findOne(
        { _id: session.userId, disabledAt: null },
        { projection: { passwordHash: 0 } }
      );
      if (!user) return res.status(401).json({ error: { code: 'USER_UNAVAILABLE', message: 'User unavailable' } });
      if (user.role !== 'owner' && user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) <= new Date()) return res.status(403).json({ error: { code: 'SUBSCRIPTION_EXPIRED', message: 'Your 30-day subscription has expired.' } });
      if (user.mustChangePassword === true && req.path !== '/api/me/password' && req.path !== '/api/me') return res.status(403).json({ error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Change your temporary password before using BETGO.' } });
      req.user = user;
      req.sessionId = session._id;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Owner access required' } });
  next();
}
