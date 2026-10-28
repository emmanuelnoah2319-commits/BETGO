const CONTROL_ID = 'betgo-global';
const DEFAULT_REASON = 'Default fail-closed state: no bookmaker connector is authorized.';

export async function ensureOperationalControl(db) {
  const now = new Date();
  await db.collection('systemControls').updateOne(
    { _id: CONTROL_ID },
    { $setOnInsert: { emergencyStop: true, reason: DEFAULT_REASON, updatedAt: now, updatedBy: 'system', createdAt: now } },
    { upsert: true }
  );
  return getOperationalControl(db);
}

export async function getOperationalControl(db) {
  const saved = await db.collection('systemControls').findOne({ _id: CONTROL_ID });
  // Fail closed if the control record is missing or malformed.
  if (!saved || typeof saved.emergencyStop !== 'boolean') {
    return { emergencyStop: true, reason: 'Control record missing or invalid; execution blocked.', updatedAt: null, updatedBy: 'fail-closed' };
  }
  return {
    emergencyStop: saved.emergencyStop,
    reason: typeof saved.reason === 'string' ? saved.reason : '',
    updatedAt: saved.updatedAt ?? null,
    updatedBy: saved.updatedBy ?? 'unknown'
  };
}

export async function setEmergencyStop(db, { enabled, reason, actorUserId }) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 300) {
    throw new TypeError('reason must contain between 3 and 300 characters');
  }
  if (!actorUserId) throw new TypeError('actorUserId is required');
  const now = new Date();
  await db.collection('systemControls').updateOne(
    { _id: CONTROL_ID },
    {
      $set: { emergencyStop: enabled, reason: reason.trim(), updatedAt: now, updatedBy: String(actorUserId) },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true }
  );
  return getOperationalControl(db);
}
