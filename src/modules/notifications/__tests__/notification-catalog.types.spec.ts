import type { NotificationCatalogShape } from '../notification-catalog';

// Compile-time only — this file fails to build (and so fails the test run)
// if NOTIFICATION_CATALOG's in_app eligibility constraint stops holding.
// reconciliation_mismatch has no `userId` (it's addressed to ops, not a
// user — docs/adr/0013-in-app-notifications.md), so routing it to `in_app`
// must be a type error.
describe('NOTIFICATION_CATALOG in_app eligibility (compile-time)', () => {
  it('rejects routing a userId-less payload to in_app', () => {
    const attempt: NotificationCatalogShape['reconciliation_mismatch'] = {
      // @ts-expect-error reconciliation_mismatch has no userId — cannot route to in_app
      channels: ['in_app'],
    };
    expect(attempt).toBeDefined();
  });

  it('allows a userId-carrying payload to route to in_app', () => {
    const allowed: NotificationCatalogShape['funding_completed'] = {
      channels: ['in_app'],
    };
    expect(allowed).toBeDefined();
  });
});
