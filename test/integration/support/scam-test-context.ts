import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { IsNull } from 'typeorm';
import { RateLimitModule } from '../../../src/rate-limit/rate-limit.module';
import { Account } from '../../../src/modules/ledger/entities/account.entity';
import { ScamCase } from '../../../src/modules/risk/entities/scam-case.entity';
import { ScamCasesService } from '../../../src/modules/risk/internal/scam-cases.service';
import { AccountRestriction } from '../../../src/modules/users/entities/account-restriction.entity';
import { dataOf } from './api-response';
import {
  RiskTestContext,
  RiskUser,
  createRiskTestContext,
  seedRiskUser,
} from './risk-test-context';
import { TEST_INTERNAL_API_SECRET } from './test-app-config';

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
export const REVIEWER = 'reviewer-scam-1';

export async function createScamTestContext(): Promise<RiskTestContext> {
  return createRiskTestContext([RateLimitModule]);
}

export function createScamHelpers(getCtx: () => RiskTestContext) {
  const jwt = new JwtService({ secret: JWT_SECRET });
  const http = () => request(getCtx().app.getHttpServer());
  const bearer = (user: RiskUser) => ({
    Authorization: `Bearer ${jwt.sign({ sub: user.userId, sid: 'test-session' })}`,
  });
  const reviewer = (req: request.Test) =>
    req
      .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
      .set('X-Reviewer-Id', REVIEWER);

  async function send(
    from: RiskUser,
    to: RiskUser,
    amountMinor: number,
  ): Promise<string> {
    const response = await getCtx().transfersService.sendMoney(from.userId, {
      recipientUserId: to.userId,
      amount: amountMinor,
      reference: `p2p-${randomUUID()}`,
      pin: '1234',
      visibility: 'private',
    });
    return response.transactionId;
  }

  const report = (
    reporter: RiskUser,
    transactionId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    http()
      .post('/scam-reports')
      .set(bearer(reporter))
      .send({
        transactionId,
        category: 'impersonation',
        description: 'They pretended to be my landlord and asked for rent.',
        ...overrides,
      });

  async function fileReport(reporter: RiskUser, transactionId: string) {
    const res = await report(reporter, transactionId).expect(201);
    return dataOf<{ reference: string; dueAt: string; late: boolean }>(res);
  }

  const resolve = (
    reference: string,
    outcome: 'upheld' | 'rejected',
    reason = 'Reviewed the evidence.',
  ) =>
    reviewer(
      http().post(`/internal/risk/scam-cases/${reference}/resolve`),
    ).send({ outcome, reason });

  const withdraw = (reporter: RiskUser, reference: string) =>
    http().post(`/scam-reports/${reference}/withdraw`).set(bearer(reporter));

  const caseOf = (reference: string) =>
    getCtx().dataSource.getRepository(ScamCase).findOneByOrFail({ reference });

  const balanceOf = async (user: RiskUser) =>
    (await getCtx().accountRepo.findOneByOrFail({ id: user.walletId })).balance;

  const fraudHoldBalance = async () =>
    (
      await getCtx().dataSource.getRepository(Account).findOneByOrFail({
        role: 'fraud_hold',
        provider: IsNull(),
        currency: 'NGN',
      })
    ).balance;

  const openRestrictions = (user: RiskUser) =>
    getCtx()
      .dataSource.getRepository(AccountRestriction)
      .findBy({ userId: user.userId, reason: 'fraud', liftedAt: IsNull() });

  const openScamFlags = (user: RiskUser) =>
    getCtx().flagRepo.find({
      where: { userId: user.userId, ruleCode: 'scam_report' },
      order: { createdAt: 'ASC' },
    });

  const ageTransfer = (transactionId: string, hours: number) =>
    getCtx().transactionRepo.update(
      { id: transactionId },
      { createdAt: new Date(Date.now() - hours * 60 * 60 * 1000) },
    );

  const seed = (balanceMinor?: bigint) =>
    seedRiskUser(getCtx(), { balanceMinor, ageDays: 30 });

  return {
    http,
    bearer,
    reviewer,
    send,
    report,
    fileReport,
    resolve,
    withdraw,
    caseOf,
    balanceOf,
    fraudHoldBalance,
    openRestrictions,
    openScamFlags,
    ageTransfer,
    seed,
    scamCases: () => getCtx().app.get(ScamCasesService),
  };
}
