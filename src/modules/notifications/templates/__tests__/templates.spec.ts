import { emailTemplates, inAppTemplates } from '../templates';

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

  it('derives funding_held and funding_refunded dedupe keys from the funding reference', () => {
    const base = {
      userId: 'u1',
      email: 'a@example.com',
      amount: '5000.00',
      currency: 'NGN',
      reference: 'cliqpay-ref-1',
    };

    expect(
      inAppTemplates.funding_held!({ ...base, cap: '300000.00' }).dedupeKey,
    ).toBe('cliqpay-ref-1');
    expect(inAppTemplates.funding_refunded!(base).dedupeKey).toBe(
      'cliqpay-ref-1',
    );
  });
});

describe('funding refund emails', () => {
  const base = {
    userId: 'u1',
    email: 'a@example.com',
    amount: '5000.00',
    currency: 'NGN',
    reference: 'cliqpay-ref-1',
  };

  it('funding_held states the amount and cap, that the provider fee is not refunded, and how to raise the limit', () => {
    const email = emailTemplates.funding_held!({ ...base, cap: '300000.00' });

    expect(email.subject).toContain('NGN 5000.00');
    for (const part of [email.html, email.text]) {
      expect(part).toContain('NGN 5000.00');
      expect(part).toContain('NGN 300000.00');
      expect(part).toContain("provider's fee is not refunded");
      expect(part).toContain('verify your identity');
    }
  });

  it('funding_refunded states the amount and that the provider fee was not refunded', () => {
    const email = emailTemplates.funding_refunded!(base);

    expect(email.html).toContain('NGN 5000.00');
    expect(email.text).toContain("provider's fee is not refunded");
  });
});

describe('refund_attention_required', () => {
  const payload = {
    email: 'ops@cliqpay.test',
    reason: 'retries_exhausted',
    fundingReference: 'cliqpay-ref-1',
    refundReference: null,
    amount: '5000.00',
    currency: 'NGN',
    heldSince: '2026-10-23T10:00:00.000Z',
    attempts: 5,
    lastFailure: 'Insufficient balance',
    occurredAt: '2026-10-24T10:00:00.000Z',
  };

  it('names the reason, the funding, the attempts and the last failure', () => {
    const email = emailTemplates.refund_attention_required!(payload);

    expect(email.subject).toContain('retries_exhausted');
    for (const part of [email.html, email.text]) {
      expect(part).toContain('cliqpay-ref-1');
      expect(part).toContain('NGN 5000.00');
      expect(part).toContain('Insufficient balance');
    }
  });

  it('omits the fields an alert does not have', () => {
    const email = emailTemplates.refund_attention_required!({
      ...payload,
      reason: 'late_success_after_refunded',
      refundReference: 'rfd-1',
      heldSince: null,
      attempts: null,
      lastFailure: null,
    });

    expect(email.html).toContain('rfd-1');
    expect(email.html).not.toContain('Held since');
    expect(email.html).not.toContain('Attempts');
    expect(email.html).not.toContain('Last failure');
  });

  it('has no in-app template: it is addressed to ops, not a user', () => {
    expect(inAppTemplates.refund_attention_required).toBeUndefined();
  });
});
