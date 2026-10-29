import { MongoClient } from 'mongodb';

export async function connectMongo(config) {
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10
  });
  await client.connect();
  const db = client.db(config.mongoDatabase);
  await ensureIndexes(db);
  return { client, db };
}

export async function ensureIndexes(db) {
  await Promise.all([
    db.collection('users').createIndex({ emailNormalized: 1 }, { unique: true }),
    db.collection('applications').createIndex({ emailNormalized: 1, status: 1 }),
    ensureOpenApplicationIndex(db),
    db.collection('applications').createIndex({ createdAt: -1 }),
    db.collection('payments').createIndex({ reference: 1 }, { unique: true }),
    db.collection('payments').createIndex({ applicationId: 1, createdAt: -1 }),
    db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('passwordResets').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('passwordResets').createIndex({ userId: 1, createdAt: -1 }),
    db.collection('passwordResets').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 86400 }),
    db.collection('auditEvents').createIndex({ createdAt: -1 }),
    db.collection('auditEvents').createIndex({ actorUserId: 1, createdAt: -1 }),
    db.collection('bettingAccounts').createIndex({ ownerUserId: 1, createdAt: -1 }),
    db.collection('bettingAccounts').createIndex({ ownerUserId: 1, platform: 1, displayNameNormalized: 1 }, { unique: true }),
    db.collection('betInstructions').createIndex({ ownerUserId: 1, createdAt: -1 }),
    db.collection('betInstructions').createIndex({ reservationReleaseState: 1, status: 1 }),
    db.collection('betInstructions').createIndex({ ownerUserId: 1, idempotencyKey: 1 }, { unique: true }),
    db.collection('betSubmissions').createIndex({ instructionId: 1, accountId: 1 }, { unique: true }),
    db.collection('betSubmissions').createIndex({ ownerUserId: 1, idempotencyKey: 1 }, { unique: true }),
    db.collection('betSubmissions').createIndex({ ownerUserId: 1, status: 1, updatedAt: 1 }),
    db.collection('dailySpend').createIndex({ ownerUserId: 1, day: 1 }, { unique: true }),
    db.collection('safetyPolicies').createIndex({ ownerUserId: 1 }, { unique: true }),
    db.collection('notificationDevices').createIndex({ ownerUserId: 1, tokenHash: 1 }, { unique: true }),
    db.collection('systemHealth').createIndex({ checkedAt: -1 })
  ]);
}

// One open application per email per bookmaker. Needs MongoDB 6.0+ for $in in a partial index; older servers
// fall back to a plain index, and the application routes still enforce the rule in code.
async function ensureOpenApplicationIndex(db) {
  const keys = { emailNormalized: 1, bookmaker: 1 };
  try {
    await db.collection('applications').createIndex(keys, { name: 'open_application_per_email_bookmaker', unique: true, partialFilterExpression: { status: { $in: ['pending', 'approved_awaiting_payment'] } } });
  } catch (error) {
    if (error?.code === 85 || error?.code === 86) throw error; // index exists with different options: needs a manual look
    console.warn(JSON.stringify({ level: 'warn', event: 'open_application_unique_index_unavailable', errorCode: error?.code || null }));
    await db.collection('applications').createIndex(keys, { name: 'application_email_bookmaker' });
  }
}
