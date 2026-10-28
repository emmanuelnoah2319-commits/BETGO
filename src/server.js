import { loadConfig } from './config/env.js';
import { connectMongo } from './db/mongo.js';
import { bootstrapOwner } from './services/auth.js';
import { recoverPendingReservationReleases } from './services/instruction-reservations.js';
import { startSubmissionRecoveryWorker } from './services/submission-recovery-worker.js';
import { ensureOperationalControl } from './services/operational-control.js';
import app from './app.js';

const config = loadConfig();
const { client, db } = await connectMongo(config);
app.locals.config = config;
app.locals.db = db;
await bootstrapOwner(db, config);
await ensureOperationalControl(db);
const reservationRecovery = await recoverPendingReservationReleases(db);
if (reservationRecovery.checked > 0) console.info(JSON.stringify({ level: 'info', event: 'reservation_recovery', ...reservationRecovery }));
const stopSubmissionRecoveryWorker = startSubmissionRecoveryWorker(db, { logger: console });
app.locals.getSubmissionRecoveryWorkerStatus = stopSubmissionRecoveryWorker.getStatus;

const server = app.listen(config.port, () => {
  console.info(JSON.stringify({ level: 'info', event: 'server_started', port: config.port, env: config.nodeEnv }));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
  stopSubmissionRecoveryWorker();
  server.close(async (error) => {
    try { await client.close(); } finally {
      if (error) {
        console.error(JSON.stringify({ level: 'error', event: 'http_shutdown_error', message: error.message }));
        process.exitCode = 1;
      }
    }
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
