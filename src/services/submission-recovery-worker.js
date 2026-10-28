import { recoverStaleSubmissions } from './submission-recovery.js';

/**
 * Recovery-only background loop. It never claims queued work or sends provider
 * requests. Status is exposed for authenticated operational monitoring.
 */
export function startSubmissionRecoveryWorker(db, {
  intervalMs = 30_000,
  olderThanMs = 60_000,
  batchSize = 100,
  logger = console,
  now = () => new Date()
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new TypeError('intervalMs must be at least 1000 milliseconds');
  let stopped = false;
  let running = false;
  const health = {
    worker: 'submission-recovery',
    mode: 'recovery-only',
    state: 'starting',
    startedAt: now(),
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    totalRuns: 0,
    totalFailures: 0,
    lastResult: null,
    lastError: null
  };

  async function tick() {
    if (stopped || running) return;
    running = true;
    health.state = 'running';
    health.lastRunStartedAt = now();
    try {
      const result = await recoverStaleSubmissions(db, { olderThanMs, limit: batchSize, now: now() });
      health.totalRuns += 1;
      health.lastSuccessAt = now();
      health.consecutiveFailures = 0;
      health.lastResult = { checked: result.checked, recovered: result.recovered, raced: result.raced };
      health.lastError = null;
      logger.info?.(JSON.stringify({ level: 'info', event: 'submission_recovery_sweep', ...health.lastResult }));
    } catch (error) {
      health.totalRuns += 1;
      health.totalFailures += 1;
      health.consecutiveFailures += 1;
      health.lastFailureAt = now();
      health.lastError = error?.name || 'Error';
      logger.error?.(JSON.stringify({ level: 'error', event: 'submission_recovery_failed', errorName: health.lastError }));
    } finally {
      health.lastRunFinishedAt = now();
      health.state = stopped ? 'stopped' : 'idle';
      running = false;
    }
  }

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  function stop() {
    stopped = true;
    clearInterval(timer);
    if (!running) health.state = 'stopped';
  }
  stop.getStatus = () => ({ ...health, lastResult: health.lastResult ? { ...health.lastResult } : null });
  stop.runNow = tick;
  return stop;
}
