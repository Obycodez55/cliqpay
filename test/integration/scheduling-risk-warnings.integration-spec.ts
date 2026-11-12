import { randomUUID } from 'crypto';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  createSchedulingHelpers,
  createSchedulingTestContext,
} from './support/scheduling-test-context';
import { dataOf, errorOf } from './support/api-response';
import { ScheduledPayment } from '../../src/modules/scheduling/entities/scheduled-payment.entity';
import { FraudFlag } from '../../src/modules/risk/entities/fraud-flag.entity';

jest.setTimeout(180_000);

const DAY_MS = 24 * 60 * 60 * 1000;

describe('recipient risk warnings on schedule creation', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function seedPair(options: { recipientAgeMs?: number } = {}) {
    const sender = await h.seedUser('sender', { balanceMinor: 50_000_000n });
    const recipient = await h.seedUser('recipient');
    await ctx.userRepo.update(
      { id: sender.userId },
      { createdAt: new Date(Date.now() - 30 * DAY_MS) },
    );
    await ctx.userRepo.update(
      { id: recipient.userId },
      {
        createdAt: new Date(
          Date.now() - (options.recipientAgeMs ?? 30 * DAY_MS),
        ),
      },
    );
    return { sender, recipient };
  }

  it('returns 422 with the warnings, creating nothing, then creates the schedule when acknowledged with the same reference', async () => {
    const { sender, recipient } = await seedPair({ recipientAgeMs: DAY_MS });
    const reference = `sched-ref-${randomUUID()}`;

    const blocked = await h
      .createSchedule(sender.userId, recipient.userId, { reference })
      .expect(422);

    expect(errorOf(blocked).code).toBe('RISK_ACKNOWLEDGEMENT_REQUIRED');
    expect(errorOf(blocked).details).toEqual({
      warnings: ['RECIPIENT_NEW_ACCOUNT'],
    });
    const repo = ctx.dataSource.getRepository(ScheduledPayment);
    expect(await repo.findOneBy({ reference })).toBeNull();

    const created = dataOf<ScheduleBody>(
      await h
        .createSchedule(sender.userId, recipient.userId, {
          reference,
          riskAcknowledged: true,
        })
        .expect(201),
    );

    const stored = await repo.findOneByOrFail({ id: created.id });
    expect(stored.riskAcknowledgement?.codes).toEqual([
      'RECIPIENT_NEW_ACCOUNT',
    ]);
  });

  it('warns on a first payment at the threshold and not just under it', async () => {
    const { sender, recipient } = await seedPair();

    await h
      .createSchedule(sender.userId, recipient.userId, { amount: 1_999_999 })
      .expect(201);
    const blocked = await h
      .createSchedule(sender.userId, recipient.userId, { amount: 2_000_000 })
      .expect(422);

    expect(errorOf(blocked).details).toEqual({
      warnings: ['FIRST_PAYMENT_LARGE_AMOUNT'],
    });
  });

  it('returns the original schedule for a repeated reference without warnings', async () => {
    const { sender, recipient } = await seedPair({ recipientAgeMs: DAY_MS });
    const reference = `sched-ref-${randomUUID()}`;
    const first = dataOf<ScheduleBody>(
      await h
        .createSchedule(sender.userId, recipient.userId, {
          reference,
          riskAcknowledged: true,
        })
        .expect(201),
    );

    const repeat = dataOf<ScheduleBody>(
      await h
        .createSchedule(sender.userId, recipient.userId, { reference })
        .expect(201),
    );

    expect(repeat.id).toBe(first.id);
  });

  it('does not re-check on a run, even when the recipient has since been flagged', async () => {
    const { sender, recipient } = await seedPair({ recipientAgeMs: DAY_MS });
    const created = dataOf<ScheduleBody>(
      await h
        .createSchedule(sender.userId, recipient.userId, {
          amount: 2_000_000,
          riskAcknowledged: true,
        })
        .expect(201),
    );
    const flags = ctx.dataSource.getRepository(FraudFlag);
    await flags.save(
      flags.create({
        userId: recipient.userId,
        kind: 'fraud',
        ruleCode: 'mule_fan_in',
        evidence: [{ seeded: true }],
        enforced: true,
        status: 'open',
      }),
    );

    await h.makeDue(created.id);
    await h.engine().sweep();
    await h.waitForRunEnd(created.id);
    await h.waitForQueuesDrained();

    const run = await ctx.transactionRepo.find({
      where: { type: 'p2p_transfer' },
    });
    expect(run.some((t) => t.metadata?.['scheduleId'] === created.id)).toBe(
      true,
    );
  });
});
