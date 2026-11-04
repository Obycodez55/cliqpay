import { createHmac, randomUUID } from 'crypto';
import { Money } from '../../../src/shared/primitives/money';
import { KycTier } from '../../../src/modules/users/users.service';
import {
  PaymentsTestContext,
  seedUserWithWallet,
} from './payments-test-context';

// Matches FakeAdapter's fixed signing secret.
const FAKE_SECRET_KEY = 'fake-kora-secret-key';

export const TIER1_CAP = 30_000_000n;

let seq = 0;

export async function seedUser(
  ctx: PaymentsTestContext,
  kycTier: KycTier,
): Promise<{ userId: string; walletId: string }> {
  seq += 1;
  return seedUserWithWallet(ctx, {
    email: `completion-${seq}@example.com`,
    phone: `+2348${String(40_000_000 + seq).padStart(8, '0')}`,
    username: `completion_user_${seq}`,
    kycTier,
  });
}

// A pending funding inserted directly, bypassing initiation's cap check, so a
// test can stage the situation initiation would have refused (or that
// arose after it). `ageHours` past 24 takes it out of the pending window.
export async function seedPendingFunding(
  ctx: PaymentsTestContext,
  walletId: string,
  amountMinor: bigint,
  ageHours = 0,
): Promise<string> {
  const reference = `cliqpay-completion-${randomUUID()}`;
  await ctx.ledgerService.createPendingFundingTransaction({
    reference,
    provider: 'kora',
    providerReference: reference,
    amount: Money.of(amountMinor, 'NGN'),
    recipientWalletId: walletId,
    metadata: { checkoutUrl: null, grossAmount: null },
  });
  if (ageHours > 0) {
    await ctx.transactionRepo.query(
      `UPDATE transactions SET created_at = now() - make_interval(hours => $2) WHERE reference = $1`,
      [reference, ageHours],
    );
  }
  return reference;
}

// Puts money in a wallet through the real ledger posting, outside any cap
// check, the way an exempt credit or an earlier funding would.
export async function creditWallet(
  ctx: PaymentsTestContext,
  walletId: string,
  amountMinor: bigint,
): Promise<void> {
  const reference = await seedPendingFunding(ctx, walletId, amountMinor);
  await ctx.ledgerService.postFunding({
    reference,
    netAmount: Money.of(amountMinor, 'NGN'),
    providerFee: Money.zero('NGN'),
    providerStatus: 'success',
  });
}

export function signedChargeSuccess(
  reference: string,
  amountMinor: bigint,
  feeMajor = 50,
): { body: string; signature: string } {
  const data = {
    reference,
    status: 'success',
    amount: Money.of(amountMinor, 'NGN').toDecimalString(),
    fee: feeMajor,
  };
  return {
    body: JSON.stringify({ event: 'charge.success', data }),
    signature: createHmac('sha256', FAKE_SECRET_KEY)
      .update(JSON.stringify(data))
      .digest('hex'),
  };
}

export function deliverChargeSuccess(
  ctx: PaymentsTestContext,
  reference: string,
  amountMinor: bigint,
): Promise<void> {
  const { body, signature } = signedChargeSuccess(reference, amountMinor);
  return ctx.paymentsService.handleKoraWebhook(Buffer.from(body), signature);
}

export async function balanceOf(
  ctx: PaymentsTestContext,
  walletId: string,
): Promise<bigint> {
  return (await ctx.accountRepo.findOneByOrFail({ id: walletId })).balance;
}

export function signedRefundWebhook(
  event: 'refund.success' | 'refund.failed',
  data: Record<string, unknown>,
): { body: string; signature: string } {
  return {
    body: JSON.stringify({ event, data }),
    signature: createHmac('sha256', FAKE_SECRET_KEY)
      .update(JSON.stringify(data))
      .digest('hex'),
  };
}

export function refundWebhookData(
  reference: string,
  amountMinor: bigint,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    amount: Number(Money.of(amountMinor, 'NGN').toDecimalString()),
    status: 'success',
    currency: 'NGN',
    reference,
    payment_reference: 'KPY-CA-test',
    created_at: '2026-10-23T07:37:06.037Z',
    completed_at: '2026-10-23T07:37:06.078Z',
    ...overrides,
  };
}

// A user at the tier-1 cap with a pending funding that breaches it, then
// completed through the real webhook path so it is held and its refund
// initiated. Returns what the refund tests need.
export async function holdAFunding(
  ctx: PaymentsTestContext,
  amountMinor = 1_000_000n,
): Promise<{
  userId: string;
  walletId: string;
  email: string;
  reference: string;
  fundingId: string;
  refundReference: string;
}> {
  const { userId, walletId } = await seedUser(ctx, 'tier1');
  await creditWallet(ctx, walletId, TIER1_CAP);
  const reference = await seedPendingFunding(ctx, walletId, amountMinor);
  await deliverChargeSuccess(ctx, reference, amountMinor);
  const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
  const user = await ctx.userRepo.findOneByOrFail({ id: userId });
  return {
    userId,
    walletId,
    email: user.email,
    reference,
    fundingId: funding.id,
    refundReference: `rfd-${funding.id}-1`,
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
