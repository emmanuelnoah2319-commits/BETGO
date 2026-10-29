# Phase 1 runbook — membership and administration

## What changed
- `src/services/payment-activation.js`: one idempotent activation path used by both the webhook and `/payment/return`. A payment is claimed atomically (`pending` -> `processing` -> `paid`); stale claims from a crash are resumed; subscription grants use optimistic versioning and `appliedPaymentRefs`, so a duplicate or concurrent delivery cannot extend a subscription twice, create two members, rotate a password or send a second email.
- `/payment/return` now handles `status=cancelled` (friendly page), redirects with no `transaction_id` (verified by reference), and logs a structured `payment_return_rejected` reason instead of a generic failure.
- `src/services/application-review.js`: approve/reject/resend. The payment record is written before the application changes state; an email failure no longer strands an approved applicant (link is returned and `POST /api/admin/applications/:id/resend-payment-email` re-sends it).
- `src/services/notifications.js`: sender readiness check. Placeholder domains (`example.com`) and the Resend testing sender are caught before any state changes; provider errors are logged with Resend's own message.
- `POST /api/admin/email/test` sends a test email to the signed-in owner; `GET /api/admin/status` reports email and payment configuration.

## Resend
Either verify a domain you control in Resend (add its DNS records, wait for "Verified") and set `EMAIL_FROM="BETGO <no-reply@yourdomain>"`, or for testing set `EMAIL_FROM=onboarding@resend.dev` plus `EMAIL_TESTING_RECIPIENT=<your own Resend account email>`. In testing mode BETGO refuses to approve/reject anyone else instead of failing half-way.

## Live checks still required (not possible offline)
1. `POST /api/admin/email/test` returns success and the message arrives.
2. Approve a test application: email arrives with the right bookmaker price; pay with a Flutterwave test card.
3. Redirect lands on "Payment confirmed"; one member exists with a 30-day expiry; one login email arrived.
4. In Flutterwave, resend the webhook: nothing changes (no new email, same expiry).
5. Cancel a checkout: friendly page; the original link still works.
6. Reject a test application: the applicant receives the reason.
If step 3 fails, find `payment_return_rejected` or `payment.mismatch` (audit) in the Render logs; the `reason` field says which check failed.

## Phase 2 additions
- New members get a one-time **password setup link** (72 h) instead of an emailed temporary password. Lost or expired links: "Forgot password". Admin "reset password" and forgot-password still use 30-minute links and skip deactivated members.
- Signing in with the right password after every subscription has lapsed returns 403 `SUBSCRIPTION_EXPIRED` with renewal instructions (a wrong password still gets the generic error). One lapsed bookmaker does not block a member with another active one; its accounts are hidden until renewed.
- `DELETE /api/accounts/:id` removes an account record unless instructions or submissions reference it (409 `ACCOUNT_IN_USE`). Each account keeps its own connection status; members may hold any number of accounts per subscribed bookmaker.
- No bookmaker can reach "connected" yet: that needs a verified connector (see docs/CONNECTOR-RELEASE-GATE.md).
