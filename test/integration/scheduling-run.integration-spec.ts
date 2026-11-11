import { randomUUID } from 'crypto';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  ScheduleUser,
  createSchedulingHelpers,
  createSchedulingTestContext,
} from './support/scheduling-test-context';
import { dataOf } from './support/api-response';
import { waitFor } from './support/social-blocks-test-helpers';
import { RunEngine } from '../../src/modules/scheduling/internal/run-engine.service';
import { RunProcessor } from '../../src/modules/scheduling/internal/run.processor';
import { ScheduledPaymentAttempt } from '../../src/modules/scheduling/entities/scheduled-payment-attempt.entity';
import { ScheduledPaymentChange } from '../../src/modules/scheduling/entities/scheduled-payment-change.entity';
import { ScheduledPaymentRun } from '../../src/modules/scheduling/entities/scheduled-payment-run.entity';
import { addTestRestriction } from './support/restrictions';

jest.setTimeout(180_000);

describe('Scheduled payment execution', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function seedSchedule(
    options: {
      body?: Record<string, unknown>;
      senderTier?: 'tier1' | 'tier3';
      balanceMinor?: bigint;
      recipientTier?: 'tier1' | 'tier3';
    } = {},
  ) {
    const sender = await h.seedUser('sender', {
      kycTier: options.senderTier,
      balanceMinor: options.balanceMinor ?? 5_000_000n,
    });
    const recipient = await h.seedUser('recipient', {
      kycTier: options.recipientTier,
    });
    const schedule = dataOf<ScheduleBody>(
      await h
        .createSchedule(sender.userId, recipient.userId, options.body)
        .expect(201),
    );
    return { sender, recipient, schedule };
  }

  async function sweepAndWait(scheduleId: string) {
    await h.makeDue(scheduleId);
    await h.engine().sweep();
    const run = await h.waitForRunEnd(scheduleId);
    await h.waitForQueuesDrained();
    return run;
  }

  const attemptsOf = (runId: string) =>
    ctx.dataSource
      .getRepository(ScheduledPaymentAttempt)
      .find({ where: { runId }, order: { attemptNumber: 'ASC' } });

  const changesOf = (scheduleId: string) =>
    ctx.dataSource.getRepository(ScheduledPaymentChange).find({
      where: { scheduledPaymentId: scheduleId },
      order: { createdAt: 'ASC' },
    });

  const balanceOf = async (user: ScheduleUser) =>
    (await ctx.accountRepo.findOneByOrFail({ id: user.walletId })).balance;

  async function insertPendingRun(
    scheduleId: string,
    dueAt: Date = new Date(),
  ) {
    await h.scheduleRepo().update({ id: scheduleId }, { nextRunAt: null });
    const schedule = await h.scheduleRepo().findOneByOrFail({ id: scheduleId });
    return h.runRepo().save(
      h.runRepo().create({
        scheduledPaymentId: schedule.id,
        runNumber: 1,
        dueAt,
        status: 'pending',
        amount: schedule.amount,
        targetType: schedule.targetType,
        recipientUserId: schedule.recipientUserId,
        note: schedule.note,
        visibility: schedule.visibility,
      }),
    );
  }

  describe('a successful run', () => {
    it('posts an ordinary p2p transfer under the attempt reference, tagged with the schedule and run', async () => {
      const { sender, recipient, schedule } = await seedSchedule({
        body: { amount: 150_000, note: 'Rent', visibility: 'public' },
      });

      const run = await sweepAndWait(schedule.id);

      const transaction = await ctx.transactionRepo.findOneByOrFail({
        reference: `sched_${schedule.id}_1_1`,
      });
      expect(transaction).toMatchObject({
        type: 'p2p_transfer',
        status: 'completed',
        amount: 150_000n,
      });
      expect(transaction.metadata).toMatchObject({
        scheduleId: schedule.id,
        runNumber: 1,
        note: 'Rent',
      });
      expect(await balanceOf(sender)).toBe(5_000_000n - 150_000n);
      expect(await balanceOf(recipient)).toBe(150_000n);

      expect(run).toMatchObject({
        status: 'succeeded',
        attemptCount: 1,
        transactionId: transaction.id,
      });
      const [attempt] = await attemptsOf(run.id);
      expect(attempt).toMatchObject({
        kind: 'attempt',
        attemptNumber: 1,
        reference: `sched_${schedule.id}_1_1`,
        outcome: 'succeeded',
        failureCode: null,
        transactionId: transaction.id,
      });
      expect(attempt.startedAt).toBeInstanceOf(Date);

      expect(
        await ctx.socialService.getRequestedVisibility(transaction.id),
      ).toBe('public');
    });

    it('needs no PIN even after the sender is locked out of PIN entry', async () => {
      const { sender, recipient, schedule } = await seedSchedule();
      for (let i = 0; i < 3; i++) {
        await h
          .http()
          .post('/transfers')
          .set('Authorization', `Bearer ${h.tokenFor(sender.userId)}`)
          .send({
            recipientUserId: recipient.userId,
            amount: 100_000,
            reference: `lock-${randomUUID()}`,
            visibility: 'private',
            pin: '0000',
          })
          .expect(401);
      }

      const run = await sweepAndWait(schedule.id);

      expect(run.status).toBe('succeeded');
    });

    it('publishes the usual transfer events and notifications', async () => {
      const { sender, recipient, schedule } = await seedSchedule();

      await sweepAndWait(schedule.id);

      await waitFor(async () => {
        const sent = await ctx.notificationRepo.findOneBy({
          userId: sender.userId,
          type: 'transfer_sent',
        });
        const received = await ctx.notificationRepo.findOneBy({
          userId: recipient.userId,
          type: 'transfer_received',
        });
        return Boolean(sent && received);
      });
    });

    it('completes a one-time schedule with a completed change', async () => {
      const { schedule } = await seedSchedule();

      await sweepAndWait(schedule.id);

      const row = await h.scheduleRepo().findOneByOrFail({ id: schedule.id });
      expect(row.status).toBe('completed');
      expect(row.nextRunAt).toBeNull();
      expect(
        (await changesOf(schedule.id)).map((c) => [c.kind, c.actor]),
      ).toEqual([
        ['created', 'user'],
        ['completed', 'system'],
      ]);
      const view = dataOf<ScheduleBody>(
        await h.getSchedule(row.userId, schedule.id).expect(200),
      );
      expect(view).toMatchObject({
        status: 'completed',
        nextRunDate: null,
        nextRunAt: null,
      });
    });
  });

  describe('a run the transfer permanently refuses', () => {
    async function expectFailed(
      scheduleId: string,
      failureCode: string,
      sender: ScheduleUser,
      senderBalance: bigint,
    ) {
      const run = await sweepAndWait(scheduleId);
      expect(run.status).toBe('failed');
      expect(run.transactionId).toBeNull();
      const [attempt] = await attemptsOf(run.id);
      expect(attempt).toMatchObject({
        attemptNumber: 1,
        outcome: 'failed',
        failureCode,
        transactionId: null,
      });
      expect(await balanceOf(sender)).toBe(senderBalance);
      expect(
        await ctx.transactionRepo.countBy({
          reference: `sched_${scheduleId}_1_1`,
        }),
      ).toBe(0);
      const row = await h.scheduleRepo().findOneByOrFail({ id: scheduleId });
      expect(row.status).toBe('completed');
      expect(run.attemptCount).toBe(1);
    }

    it('blocked: a block placed after creation stops the run', async () => {
      const { sender, recipient, schedule } = await seedSchedule();
      await h
        .http()
        .put(`/social/blocks/${sender.userId}`)
        .set('Authorization', `Bearer ${h.tokenFor(recipient.userId)}`)
        .expect(200);

      await expectFailed(schedule.id, 'blocked', sender, 5_000_000n);
    });

    it('sender_frozen: a freeze after creation stops the run', async () => {
      const { sender, schedule } = await seedSchedule();
      await addTestRestriction(ctx.dataSource, sender.userId);

      await expectFailed(schedule.id, 'sender_frozen', sender, 5_000_000n);
    });

    it('sender_frozen: a self-lock stops the run the same way', async () => {
      const { sender, schedule } = await seedSchedule();
      await addTestRestriction(ctx.dataSource, sender.userId, {
        reason: 'self_lock',
      });

      await expectFailed(schedule.id, 'sender_frozen', sender, 5_000_000n);
    });

    it('recipient_unavailable: a recipient whose wallet is gone', async () => {
      const { sender, recipient, schedule } = await seedSchedule();
      await ctx.dataSource.query(`DELETE FROM accounts WHERE id = $1`, [
        recipient.walletId,
      ]);

      await expectFailed(
        schedule.id,
        'recipient_unavailable',
        sender,
        5_000_000n,
      );
    });
  });

  describe('infrastructure errors', () => {
    it('are retried by the queue, and recorded as a transient infrastructure failure only after its attempts are spent', async () => {
      const { schedule } = await seedSchedule();
      const run = await insertPendingRun(
        schedule.id,
        new Date(Date.now() + 30 * 86_400_000),
      );
      const processor = ctx.app.get(RunProcessor, { strict: false });
      jest
        .spyOn(ctx.app.get(RunEngine, { strict: false }), 'executeRun')
        .mockRejectedValue(new Error('connection reset'));
      const job = (attemptsMade: number) =>
        ({
          data: { runId: run.id },
          opts: { attempts: 5 },
          attemptsMade,
        }) as never;

      await expect(processor.process(job(0))).rejects.toThrow(
        'connection reset',
      );
      await expect(processor.process(job(3))).rejects.toThrow(
        'connection reset',
      );
      expect((await h.runRepo().findOneByOrFail({ id: run.id })).status).toBe(
        'pending',
      );

      await processor.process(job(4));

      const after = await h.runRepo().findOneByOrFail({ id: run.id });
      expect(after).toMatchObject({ status: 'pending', attemptCount: 1 });
      expect(after.nextAttemptAt).not.toBeNull();
      const [attempt] = await attemptsOf(run.id);
      expect(attempt).toMatchObject({
        outcome: 'failed',
        failureCode: 'infrastructure',
        attemptNumber: 1,
      });
    });
  });

  describe('a crash after the transfer posted', () => {
    it('replays the same reference and records the original transaction', async () => {
      const { sender, recipient, schedule } = await seedSchedule({
        body: { amount: 200_000 },
      });
      const run = await insertPendingRun(schedule.id);
      const engine = ctx.app.get(RunEngine, { strict: false });
      const recordResult = jest
        .spyOn(
          engine as unknown as { recordResult: () => Promise<void> },
          'recordResult',
        )
        .mockRejectedValueOnce(new Error('process died after posting'));

      await expect(engine.executeRun(run.id)).rejects.toThrow('process died');

      expect(recordResult).toHaveBeenCalledTimes(1);
      const crashed = await h.runRepo().findOneByOrFail({ id: run.id });
      expect(crashed).toMatchObject({ status: 'pending', attemptCount: 0 });
      expect(await attemptsOf(run.id)).toHaveLength(0);
      const posted = await ctx.transactionRepo.findOneByOrFail({
        reference: `sched_${schedule.id}_1_1`,
      });
      expect(await balanceOf(sender)).toBe(4_800_000n);

      await engine.executeRun(run.id);

      const recovered = await h.runRepo().findOneByOrFail({ id: run.id });
      expect(recovered).toMatchObject({
        status: 'succeeded',
        attemptCount: 1,
        transactionId: posted.id,
      });
      const [attempt] = await attemptsOf(run.id);
      expect(attempt).toMatchObject({
        reference: `sched_${schedule.id}_1_1`,
        attemptNumber: 1,
        outcome: 'succeeded',
        transactionId: posted.id,
      });
      expect(
        await ctx.transactionRepo.countBy({
          reference: `sched_${schedule.id}_1_1`,
        }),
      ).toBe(1);
      expect(await balanceOf(sender)).toBe(4_800_000n);
      expect(await balanceOf(recipient)).toBe(200_000n);
      expect(
        (await h.scheduleRepo().findOneByOrFail({ id: schedule.id })).status,
      ).toBe('completed');
    });

    it('records a posted payment as succeeded when the queue gives up on a persistent post-commit fault', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { amount: 200_000 },
      });
      const run = await insertPendingRun(schedule.id);
      const engine = ctx.app.get(RunEngine, { strict: false });
      const processor = ctx.app.get(RunProcessor, { strict: false });
      const recordResult = jest
        .spyOn(
          engine as unknown as { recordResult: () => Promise<void> },
          'recordResult',
        )
        .mockRejectedValue(new Error('db unavailable'));
      const job = (attemptsMade: number) =>
        ({
          data: { runId: run.id },
          opts: { attempts: 5 },
          attemptsMade,
        }) as never;

      for (const attemptsMade of [0, 1, 2, 3]) {
        await expect(processor.process(job(attemptsMade))).rejects.toThrow(
          'db unavailable',
        );
      }
      recordResult.mockRestore();
      jest
        .spyOn(engine, 'executeRun')
        .mockRejectedValue(new Error('db unavailable'));
      await processor.process(job(4));

      const posted = await ctx.transactionRepo.findOneByOrFail({
        reference: `sched_${schedule.id}_1_1`,
      });
      const after = await h.runRepo().findOneByOrFail({ id: run.id });
      expect(after).toMatchObject({
        status: 'succeeded',
        attemptCount: 1,
        transactionId: posted.id,
      });
      const [attempt] = await attemptsOf(run.id);
      expect(attempt).toMatchObject({
        outcome: 'succeeded',
        failureCode: null,
        transactionId: posted.id,
      });
      expect(
        await ctx.transactionRepo.countBy({
          reference: `sched_${schedule.id}_1_1`,
        }),
      ).toBe(1);
      expect(await balanceOf(sender)).toBe(4_800_000n);
      expect(
        (await h.scheduleRepo().findOneByOrFail({ id: schedule.id })).status,
      ).toBe('completed');
    });

    it('does not pay twice when two workers execute the same run at once', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { amount: 200_000 },
      });
      const run = await insertPendingRun(schedule.id);
      const engine = ctx.app.get(RunEngine, { strict: false });

      await Promise.allSettled([
        engine.executeRun(run.id),
        engine.executeRun(run.id),
      ]);

      expect(await balanceOf(sender)).toBe(4_800_000n);
      expect(
        await ctx.transactionRepo.countBy({
          reference: `sched_${schedule.id}_1_1`,
        }),
      ).toBe(1);
    });
  });

  it('skips a run that is no longer pending', async () => {
    const { sender, schedule } = await seedSchedule();
    const run = await insertPendingRun(schedule.id);
    await ctx.dataSource
      .getRepository(ScheduledPaymentRun)
      .update({ id: run.id }, { status: 'cancelled' });

    await ctx.app.get(RunEngine, { strict: false }).executeRun(run.id);

    expect(await balanceOf(sender)).toBe(5_000_000n);
    expect(await attemptsOf(run.id)).toHaveLength(0);
  });
});
