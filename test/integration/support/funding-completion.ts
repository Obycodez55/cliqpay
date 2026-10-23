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
