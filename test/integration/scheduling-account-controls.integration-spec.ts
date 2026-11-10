import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  atClock,
  createSchedulingTestContext,
  lagosAt,
} from './support/scheduling-test-context';
import { createFailureHelpers } from './support/scheduling-failure-helpers';
import { User } from '../../src/modules/users/entities/user.entity';
import { UserLimit } from '../../src/modules/kyc/entities/user-limit.entity';
import {
  addDays,
  lagosToday,
} from '../../src/modules/scheduling/internal/run-time';

jest.setTimeout(180_000);

const HOUR = 60 * 60 * 1000;
const OVER_COOLDOWN_CAP = 2_500_000;

describe('Scheduled payments and the account-takeover controls', () => {
  let ctx: TransfersTestContext;
  const { seedSchedule, insertRun, execute, reload, attemptsOf } =
    createFailureHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function setCooldown(
    userId: string,
    startedAt: Date,
    until: Date,
  ): Promise<void> {
    await ctx.dataSource.getRepository(User).update(
      { id: userId },
      {
        securityCooldownStartedAt: startedAt,
        securityCooldownUntil: until,
      },
    );
  }

  async function dueRun(options: { amount: number }) {
    const { sender, schedule } = await seedSchedule({
      balanceMinor: 5_000_000n,
      body: { amount: options.amount },
    });
    const date = addDays(lagosToday(new Date()), 10);
    const run = await insertRun(schedule.id, lagosAt(date, '06:00'));
    return { sender, run, at: lagosAt(date, '08:00') };
  }

  it('lets a schedule created before the cooldown started run past the cap', async () => {
    const { sender, run, at } = await dueRun({ amount: OVER_COOLDOWN_CAP });
    await setCooldown(
      sender.userId,
      new Date(at.getTime() - 2 * HOUR),
      new Date(at.getTime() + 22 * HOUR),
    );

    await atClock(at, () => execute(run.id));

    expect(await reload(run.id)).toMatchObject({ status: 'succeeded' });
    expect((await attemptsOf(run.id))[0]).toMatchObject({
      outcome: 'succeeded',
      failureCode: null,
    });
  });

  it('fails a run of a schedule created during the cooldown as a transient security_cooldown_limit', async () => {
    const { sender, run, at } = await dueRun({ amount: OVER_COOLDOWN_CAP });
    await setCooldown(
      sender.userId,
      new Date(Date.now() - HOUR),
      new Date(at.getTime() + 22 * HOUR),
    );

    await atClock(at, () => execute(run.id));

    expect((await attemptsOf(run.id))[0]).toMatchObject({
      outcome: 'failed',
      failureCode: 'security_cooldown_limit',
    });
    expect(await reload(run.id)).toMatchObject({
      status: 'pending',
      attemptCount: 1,
    });
    expect((await reload(run.id)).nextAttemptAt).toEqual(
      new Date(at.getTime() + 2 * HOUR),
    );
  });

  it('keeps a schedule made during the cooldown capped after the cooldown is extended', async () => {
    const { sender, run, at } = await dueRun({ amount: OVER_COOLDOWN_CAP });
    const startedBeforeSchedule = new Date(Date.now() - 3 * HOUR);
    await setCooldown(
      sender.userId,
      startedBeforeSchedule,
      new Date(at.getTime() + 22 * HOUR),
    );
    await ctx.dataSource.transaction((manager) =>
      ctx.usersService.startSecurityCooldown(
        manager,
        sender.userId,
        'password_changed',
        { type: 'user', id: sender.userId },
      ),
    );

    await atClock(at, () => execute(run.id));

    expect((await attemptsOf(run.id))[0].failureCode).toBe(
      'security_cooldown_limit',
    );
  });

  it('applies the user’s own limit to a scheduled run as a transient daily_limit_exceeded', async () => {
    const { sender, run, at } = await dueRun({ amount: 500_000 });
    await ctx.dataSource.getRepository(UserLimit).save({
      userId: sender.userId,
      dailyOutflowLimitMinor: 300_000n,
      pendingDailyOutflowLimitMinor: null,
      pendingEffectiveAt: null,
    });

    await atClock(at, () => execute(run.id));

    expect((await attemptsOf(run.id))[0]).toMatchObject({
      outcome: 'failed',
      failureCode: 'daily_limit_exceeded',
    });
    expect(await reload(run.id)).toMatchObject({
      status: 'pending',
      attemptCount: 1,
    });
  });
});
