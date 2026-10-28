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
    db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
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
