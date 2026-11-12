import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { FraudFlag } from '../../../src/modules/risk/entities/fraud-flag.entity';
import {
  FraudRule,
  FraudRuleCode,
  FraudRuleMode,
} from '../../../src/modules/risk/entities/fraud-rule.entity';
import { RiskService } from '../../../src/modules/risk/risk.service';
import { AuditEvent } from '../../../src/shared/audit/entities/audit-event.entity';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  fundWallet,
  seedBankAccount,
  seedWithdrawalUser,
} from './withdrawals-test-context';

export interface RiskTestContext extends WithdrawalsTestContext {
  riskService: RiskService;
  flagRepo: Repository<FraudFlag>;
  ruleRepo: Repository<FraudRule>;
  auditRepo: Repository<AuditEvent>;
}

export async function createRiskTestContext(
  extraImports: Parameters<typeof createWithdrawalsTestContext>[1] = [],
): Promise<RiskTestContext> {
  const base = await createWithdrawalsTestContext(
    { providerFee: 3_000 },
    extraImports,
  );
  return {
    ...base,
    riskService: base.app.get(RiskService),
    flagRepo: base.dataSource.getRepository(FraudFlag),
    ruleRepo: base.dataSource.getRepository(FraudRule),
    auditRepo: base.dataSource.getRepository(AuditEvent),
  };
}

export const destroyRiskTestContext = destroyWithdrawalsTestContext;

export interface RiskUser {
  userId: string;
  walletId: string;
  email: string;
  bankAccountId: string;
}

let seq = 0;

export async function seedRiskUser(
  ctx: RiskTestContext,
  options: { balanceMinor?: bigint; ageDays?: number } = {},
): Promise<RiskUser> {
  seq += 1;
  const email = `risk-${seq}-${randomUUID().slice(0, 6)}@example.com`;
  const { userId, walletId } = await seedWithdrawalUser(ctx, {
    email,
    phone: `+2348077${String(100_000 + seq).padStart(6, '0')}`,
    username: `risk_user_${seq}_${randomUUID().slice(0, 4)}`,
  });
  if (options.balanceMinor) {
    await fundWallet(ctx, {
      reference: `fund-${userId}`,
      walletId,
      netAmountMinor: options.balanceMinor,
    });
  }
  if (options.ageDays !== undefined) {
    await ageAccount(ctx, userId, options.ageDays);
  }
  const bank = await seedBankAccount(ctx, { userId });
  return { userId, walletId, email, bankAccountId: bank.id };
}

export async function ageAccount(
  ctx: RiskTestContext,
  userId: string,
  days: number,
): Promise<void> {
  await ctx.userRepo.update(
    { id: userId },
    { createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
  );
}

export async function setRule(
  ctx: RiskTestContext,
  code: FraudRuleCode,
  change: { mode?: FraudRuleMode; params?: Record<string, number> },
): Promise<void> {
  const rule = await ctx.ruleRepo.findOneByOrFail({ code });
  await ctx.ruleRepo.update(
    { code },
    {
      mode: change.mode ?? rule.mode,
      params: change.params
        ? { ...rule.params, ...change.params }
        : rule.params,
    },
  );
}

export async function sendP2p(
  ctx: RiskTestContext,
  from: RiskUser,
  to: RiskUser,
  amountMinor: number,
): Promise<void> {
  await ctx.transfersService.sendMoney(from.userId, {
    recipientUserId: to.userId,
    amount: amountMinor,
    reference: `p2p-${randomUUID()}`,
    pin: '1234',
    visibility: 'private',
    riskAcknowledged: true,
  });
}

export async function withdraw(
  ctx: RiskTestContext,
  user: RiskUser,
  amountMinor: number,
  reference = `wd-${randomUUID()}`,
) {
  const response = await ctx.withdrawalsService.initiateWithdrawal(
    user.userId,
    {
      bankAccountId: user.bankAccountId,
      amount: amountMinor,
      reference,
      pin: '1234',
    },
  );
  return { reference, response };
}

export async function insertFlag(
  ctx: RiskTestContext,
  userId: string,
  options: {
    ruleCode?: string;
    enforced?: boolean;
    status?: FraudFlag['status'];
  } = {},
): Promise<FraudFlag> {
  return ctx.flagRepo.save(
    ctx.flagRepo.create({
      userId,
      kind: 'fraud',
      ruleCode: options.ruleCode ?? 'mule_fan_in',
      evidence: [{ seeded: true }],
      enforced: options.enforced ?? true,
      status: options.status ?? 'open',
    }),
  );
}

export const payoutsFor = (ctx: RiskTestContext, reference: string) =>
  ctx.fakeAdapter.payoutsInitiated.filter((p) => p.reference === reference);

export const statusOf = async (ctx: RiskTestContext, reference: string) =>
  (await ctx.transactionRepo.findOneByOrFail({ reference })).status;
