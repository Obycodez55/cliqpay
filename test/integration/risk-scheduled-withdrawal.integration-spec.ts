import { WithdrawalsService } from '../../src/modules/withdrawals/withdrawals.service';
import { FraudFlag } from '../../src/modules/risk/entities/fraud-flag.entity';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import { createSchedulingTestContext } from './support/scheduling-test-context';
import {
  createBankRunHelpers,
  AMOUNT,
  FEE,
} from './support/scheduling-bank-run-helpers';

jest.setTimeout(180_000);

describe('A scheduled bank run whose withdrawal goes under review', () => {
  let ctx: TransfersTestContext;
  const {
    h,
    seedSchedule,
    daily,
    insertRun,
    execute,
    reload,
    scheduleOf,
    balanceOf,
    refOf,
    waitForStatus,
  } = createBankRunHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function heldRun() {
    const { sender, schedule } = await seedSchedule({ body: daily });
    await ctx.dataSource.getRepository(FraudFlag).save({
      userId: sender.userId,
      kind: 'fraud',
      ruleCode: 'mule_fan_in',
      evidence: [{ seeded: true }],
      enforced: true,
    });
    const run = await insertRun(schedule.id, 1, { keepNextRun: true });
    await execute(run);
    return { sender, schedule, run, reference: refOf(schedule.id, 1, 1) };
  }

  const payoutsFor = (reference: string) =>
    h.fakeAdapter().payoutsInitiated.filter((p) => p.reference === reference);
  const withdrawals = () => ctx.app.get(WithdrawalsService);

  it('holds the payout and leaves the run settling, with the money reserved', async () => {
    const { sender, run, reference } = await heldRun();

    expect((await reload(run.id)).status).toBe('settling');
    const tx = await ctx.transactionRepo.findOneByOrFail({ reference });
    expect(tx.status).toBe('under_review');
    expect(payoutsFor(reference)).toHaveLength(0);
    expect(await balanceOf(sender)).toBe(5_000_000n - AMOUNT - FEE);
  });

  it('is still read as pending by the scheduler, and a stuck-run sweep leaves it settling', async () => {
    const { sender, run, reference } = await heldRun();

    expect(
      await withdrawals().findScheduledWithdrawal(sender.userId, reference),
    ).toMatchObject({ status: 'pending' });
    await ctx.dataSource.query(
      `UPDATE scheduled_payment_runs SET updated_at = now() - interval '1 day' WHERE id = $1`,
      [run.id],
    );
    await h.engine().sweep();

    expect((await reload(run.id)).status).toBe('settling');
  });

  it('reverses the run when the review rejects the withdrawal', async () => {
    const { sender, schedule, run, reference } = await heldRun();

    await withdrawals().rejectHeldWithdrawal(reference, 'reviewer-sched');
    await waitForStatus(run.id, 'reversed');

    expect(await balanceOf(sender)).toBe(5_000_000n);
    expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(1);
    expect(payoutsFor(reference)).toHaveLength(0);
  });

  it('succeeds the run once the withdrawal is released and the payout lands', async () => {
    const { run, reference } = await heldRun();

    await withdrawals().releaseHeldWithdrawal(reference, 'reviewer-sched');
    expect((await reload(run.id)).status).toBe('settling');
    expect(payoutsFor(reference)).toHaveLength(1);
    await h.settlePayout(reference, 'success', AMOUNT);
    await waitForStatus(run.id, 'succeeded');
  });
});
