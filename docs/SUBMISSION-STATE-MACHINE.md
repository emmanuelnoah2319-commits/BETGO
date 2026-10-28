# BETGO submission state-machine groundwork

This is a pure, testable state-transition contract for a future provider-authorized submission worker. It does not send HTTP requests, connect bookmaker accounts, or place bets.

## States

- `queued`: a submission request is durably prepared but has not started.
- `submitting`: a worker has begun one attempt.
- `accepted`: the provider has confirmed acceptance with a verifiable provider reference.
- `rejected`: the provider has explicitly rejected the request.
- `unknown`: a timeout or transport failure means the outcome is uncertain.
- `cancelled`: a queued request was cancelled before execution.

## Safety rules

1. A timeout is **not** a rejection. It transitions to `unknown`.
2. `unknown` cannot transition directly to `submitting`; the provider must first be queried/reconciled.
3. An accepted or rejected submission is terminal. A new wager must use a new instruction and a new idempotency key.
4. A submission record must include an instruction ID and an idempotency key of at least 16 characters. A submitting record needs a positive attempt number.
5. This module defines transitions only. It does not persist records, create a worker, retry requests, or prove a provider's idempotency support.

## Required before production

- Implement atomic MongoDB state transitions and unique indexes for idempotency keys.
- Scope records to the owning user/business and link them to a previously approved instruction.
- Use a provider-authorized adapter with documented acceptance/rejection semantics.
- Persist provider references and reconcile uncertain outcomes before retrying.
- Test crash/restart behavior and concurrent workers against an isolated MongoDB instance.
- Keep the global emergency stop and all bookmaker connectors disabled until separate release approval.

## Phase 4 persistence increment

`src/services/submission-records.js` adds MongoDB-backed primitives for creating a queued record from an owner-scoped instruction in `approved_not_submitted`, and performing compare-and-set transitions using the prior status in the update filter. Each record is owner-scoped, records a transition history, uses a stable idempotency key, and requires a provider reference before accepting an `accepted` result. MongoDB indexes enforce uniqueness for `(ownerUserId, idempotencyKey)` and `(instructionId, accountId)`.

These are service primitives only: no public submission route or worker invokes them, no bookmaker network call is made, and `submissionEnabled` remains false. Provider-specific reconciliation, real MongoDB concurrency/crash tests, transactions around instruction/account lifecycle, and connector authorization remain required before release.

## Phase 4 recovery worker increment

`src/services/submission-recovery.js` scans only stale `submitting` records and uses owner-scoped compare-and-set transitions to mark abandoned attempts `unknown`, with `reconciliationRequired: true` and `WORKER_LEASE_EXPIRED`. It does not reset them to `queued`, retry a wager, or contact a bookmaker. `src/services/submission-recovery-worker.js` runs this recovery sweep at startup and periodically, prevents overlapping sweeps in one process, logs failures without exposing secrets, and is stopped during graceful shutdown. Multiple instances are safe to race because the state transition filters on the previously observed status; a losing worker records a race rather than overwriting the newer state.

This is a recovery-only worker, not a submission executor. `queued` records are deliberately left untouched. Provider-specific reconciliation and real MongoDB multi-process crash tests are still required before a future retry can be considered.
