import { emailTemplates, inAppTemplates, pushTemplates } from '../templates';

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

describe('post comment and reaction wording', () => {
  const comment = {
    userId: 'u1',
    transactionId: 'p1',
    commentId: 'c1',
    commenterUserId: 'u2',
    commenterUsername: 'tolu',
  };
  const reaction = {
    userId: 'u1',
    transactionId: 'p1',
    reactorUserId: 'u2',
    reactorUsername: 'tolu',
  };

  it('names a transfer post a transaction', () => {
    expect(
      inAppTemplates.post_comment!({ ...comment, postKind: 'transfer' }).body,
    ).toBe('tolu commented on your transaction.');
    expect(
      inAppTemplates.post_reaction!({ ...reaction, postKind: 'transfer' }).body,
    ).toBe('tolu reacted to your transaction.');
  });

  it('names a split post a bill split, in-app and in the push', () => {
    expect(
      inAppTemplates.post_comment!({ ...comment, postKind: 'bill_split' }).body,
    ).toBe('tolu commented on your bill split.');
    expect(
      inAppTemplates.post_reaction!({ ...reaction, postKind: 'bill_split' })
        .body,
    ).toBe('tolu reacted to your bill split.');
    expect(
      pushTemplates.post_comment!({ ...comment, postKind: 'bill_split' }).body,
    ).toBe('tolu commented on your bill split.');
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

describe('plain-text email', () => {
  it("decodes the hex entities Handlebars escapes interpolated ' ` = into", () => {
    const email = emailTemplates.scheduled_payment_paused!({
      userId: 'u1',
      email: 'a@example.com',
      scheduledPaymentId: 's1',
      changeId: 'c1',
      counterpartyLabel: "o'brien `x` a=b",
      amount: '5000.00',
      currency: 'NGN',
      reason: 'recipient_unable_to_receive',
    });

    expect(email.text).toContain("o'brien `x` a=b");
    expect(email.text).toContain("can't");
    expect(email.text).not.toMatch(/&#x[0-9a-f]+;/i);
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

describe('risk_review_overdue', () => {
  const payload = {
    email: 'ops@cliqpay.test',
    overdueFlags: 2,
    overdueWithdrawals: 1,
    oldestHours: 30,
    flagIds: ['flag-1', 'flag-2'],
    withdrawalReferences: ['wd-1'],
    occurredAt: '2026-11-11T10:00:00.000Z',
  };

  it('counts what is overdue and lists the ids to look at', () => {
    const email = emailTemplates.risk_review_overdue!(payload);

    expect(email.subject).toContain('2 flag(s)');
    expect(email.subject).toContain('1 held withdrawal(s)');
    for (const part of [email.html, email.text]) {
      expect(part).toContain('flag-1');
      expect(part).toContain('flag-2');
      expect(part).toContain('wd-1');
      expect(part).toContain('30 hours');
    }
  });

  it('has no in-app template: it is addressed to ops, not a user', () => {
    expect(inAppTemplates.risk_review_overdue).toBeUndefined();
  });
});

describe('reconciliation_mismatch', () => {
  it('shows the suspense balance and the refunds in flight next to the balances', () => {
    const email = emailTemplates.reconciliation_mismatch!({
      email: 'ops@cliqpay.test',
      provider: 'kora',
      currency: 'NGN',
      ledgerBalance: '5000.00',
      suspenseBalance: '1000.00',
      inFlightRefunds: '250.00',
      providerBalance: '3800.00',
      delta: '200.00',
      occurredAt: '2026-10-24T10:00:00.000Z',
    });

    for (const part of [email.html, email.text]) {
      expect(part).toContain('NGN 1000.00');
      expect(part).toContain('NGN 250.00');
    }
    expect(email.html).toContain('Held in suspense');
    expect(email.html).toContain('Refunds in flight');
  });
});

describe('mfa_challenge_otp email', () => {
  const base = {
    userId: 'u1',
    email: 'a@example.com',
    code: '123456',
    expiresInMinutes: 10,
  };

  it('keeps the sign-in wording for a login challenge', () => {
    const email = emailTemplates.mfa_challenge_otp!({
      ...base,
      action: 'sign_in',
    });
    expect(email.subject).toBe('Your Cliqpay sign-in code');
    expect(email.text).toContain('Your Cliqpay sign-in code is: 123456');
  });

  it.each([
    ['set_pin', 'set your transaction PIN'],
    ['change_pin', 'change your transaction PIN'],
    ['reset_pin', 'reset your transaction PIN'],
    ['change_password', 'change your password'],
    ['change_email', 'change your email address'],
    ['change_phone', 'change your phone number'],
    ['enroll_totp', 'set up an authenticator app'],
    ['save_bank_account', 'save a bank account'],
  ] as const)('names the action for a %s step-up', (action, purpose) => {
    const email = emailTemplates.mfa_challenge_otp!({ ...base, action });
    expect(email.subject).toBe(`Your Cliqpay code to ${purpose}`);
    expect(email.text).toContain(`Your Cliqpay code to ${purpose} is: 123456`);
    expect(email.text).not.toContain('sign-in');
  });
});

describe('self-lock alert content', () => {
  const alert = {
    userId: 'u1',
    email: 'a@example.com',
    message: 'A bank account was added.',
    occurredAt: '2026-08-15T10:32:47.123Z',
  };

  it('puts the lock link in the email and the push data when the alert has one', () => {
    const lockUrl = 'https://app.cliqpay.test/lock?token=abc';
    const email = emailTemplates.security_alert!({ ...alert, lockUrl });
    expect(email.text).toContain(`lock my account: ${lockUrl}`);
    expect(pushTemplates.security_alert!({ ...alert, lockUrl }).data).toEqual({
      lockUrl,
    });
  });

  it('leaves the in-app row without the link', () => {
    const content = inAppTemplates.security_alert!({
      ...alert,
      lockUrl: 'https://app.cliqpay.test/lock?token=abc',
    });
    expect(JSON.stringify(content)).not.toContain('token=abc');
  });

  it('renders the lock confirmation for email and push', () => {
    const payload = {
      userId: 'u1',
      email: 'a@example.com',
      occurredAt: alert.occurredAt,
    };
    expect(emailTemplates.account_self_locked!(payload).subject).toBe(
      'Your Cliqpay account is locked',
    );
    expect(pushTemplates.account_self_locked!(payload).title).toBe(
      'Your account is locked',
    );
  });
});
