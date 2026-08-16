import { inAppTemplates } from '../templates';

describe('inAppTemplates', () => {
  it('derives funding_completed dedupe_key from the transaction reference', () => {
    const content = inAppTemplates.funding_completed!({
      userId: 'u1',
      email: 'a@example.com',
      amount: '5000.00',
      currency: 'NGN',
      reference: 'cliqpay-ref-1',
    });
    expect(content.dedupeKey).toBe('cliqpay-ref-1');
    expect(content.title).toBeTruthy();
    expect(content.body).toContain('5000.00');
    expect(content.data).not.toHaveProperty('reference');
  });

  it('derives security_alert dedupe_key from a minute-bucketed occurredAt plus the message', () => {
    const content = inAppTemplates.security_alert!({
      userId: 'u1',
      email: 'a@example.com',
      message: 'New device login',
      occurredAt: '2026-08-15T10:32:47.123Z',
    });
    expect(content.dedupeKey).toBe('2026-08-15T10:32:New device login');
  });

  it('buckets two publishes within the same minute to the same dedupe_key (retry dedupe)', () => {
    const a = inAppTemplates.security_alert!({
      userId: 'u1',
      email: 'a@example.com',
      message: 'New device login',
      occurredAt: '2026-08-15T10:32:01.000Z',
    });
    const b = inAppTemplates.security_alert!({
      userId: 'u1',
      email: 'a@example.com',
      message: 'New device login',
      occurredAt: '2026-08-15T10:32:59.999Z',
    });
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });

  it('gives two distinct alerts in different minutes distinct dedupe_keys', () => {
    const a = inAppTemplates.security_alert!({
      userId: 'u1',
      email: 'a@example.com',
      message: 'New device login',
      occurredAt: '2026-08-15T10:32:59.999Z',
    });
    const b = inAppTemplates.security_alert!({
      userId: 'u1',
      email: 'a@example.com',
      message: 'New device login',
      occurredAt: '2026-08-15T10:33:00.001Z',
    });
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('has no template for reconciliation_mismatch (ops-only, stays email-only)', () => {
    expect(inAppTemplates.reconciliation_mismatch).toBeUndefined();
  });

  it('has no template for OTP/reset-link types (data must never carry secrets)', () => {
    expect(inAppTemplates.email_verification_otp).toBeUndefined();
    expect(inAppTemplates.phone_verification_otp).toBeUndefined();
    expect(inAppTemplates.password_reset_otp).toBeUndefined();
    expect(inAppTemplates.mfa_challenge_otp).toBeUndefined();
  });
});
