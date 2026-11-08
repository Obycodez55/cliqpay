import { randomUUID } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  createSchedulingHelpers,
  createSchedulingTestContext,
} from './support/scheduling-test-context';
import { dataOf } from './support/api-response';
import { TransfersService } from '../../src/modules/transfers/transfers.service';
import { WithdrawalsService } from '../../src/modules/withdrawals/withdrawals.service';

jest.setTimeout(180_000);

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return controllerFiles(path);
    }
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

describe('Scheduled payment audit tables and the standing-authorisation seam', () => {
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

  describe('append-only tables', () => {
    let scheduleId: string;
    let runId: string;

    beforeAll(async () => {
      const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
      const recipient = await h.seedUser('recipient');
      scheduleId = dataOf<ScheduleBody>(
        await h.createSchedule(sender.userId, recipient.userId).expect(201),
      ).id;
      await h.makeDue(scheduleId);
      await h.engine().sweep();
      runId = (await h.waitForRunEnd(scheduleId)).id;
    });

    it.each([
      [
        'scheduled_payment_attempts',
        () => `WHERE run_id = '${runId}'`,
        `SET outcome = 'failed'`,
      ],
      [
        'scheduled_payment_changes',
        () => `WHERE scheduled_payment_id = '${scheduleId}'`,
        `SET kind = 'cancelled'`,
      ],
    ])('rejects UPDATE and DELETE on %s', async (table, where, set) => {
      await expect(
        ctx.dataSource.query(`UPDATE ${table} ${set} ${where()}`),
      ).rejects.toThrow(/append-only/);
      await expect(
        ctx.dataSource.query(`DELETE FROM ${table} ${where()}`),
      ).rejects.toThrow(/append-only/);
      const rows = await ctx.dataSource.query<{ count: string }[]>(
        `SELECT count(*) FROM ${table} ${where()}`,
      );
      expect(Number(rows[0].count)).toBeGreaterThan(0);
    });

    it('rejects a bulk DELETE', async () => {
      await expect(
        ctx.dataSource.query(`DELETE FROM scheduled_payment_attempts`),
      ).rejects.toThrow(/append-only/);
    });

    it('still allows inserts', async () => {
      await ctx.dataSource.query(
        `INSERT INTO scheduled_payment_changes (scheduled_payment_id, kind, actor)
         VALUES ($1, 'completed', 'system')`,
        [scheduleId],
      );
    });

    it('leaves the mutable tables updatable', async () => {
      await ctx.dataSource.query(
        `UPDATE scheduled_payment_runs SET updated_at = now() WHERE id = $1`,
        [runId],
      );
    });
  });

  describe('executeScheduledTransfer', () => {
    it('is not called by any controller', () => {
      const offenders = controllerFiles(join(__dirname, '../../src')).filter(
        (file) =>
          readFileSync(file, 'utf8').includes('executeScheduledTransfer'),
      );

      expect(offenders).toEqual([]);
    });

    it('is not reached by any request to the money-moving or scheduling routes', async () => {
      const spy = jest.spyOn(
        ctx.app.get(TransfersService),
        'executeScheduledTransfer',
      );
      const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
      const recipient = await h.seedUser('recipient');
      const auth = { Authorization: `Bearer ${h.tokenFor(sender.userId)}` };

      await h
        .http()
        .post('/transfers')
        .set(auth)
        .send({
          recipientUserId: recipient.userId,
          amount: 100_000,
          reference: `live-${randomUUID()}`,
          visibility: 'private',
          pin: '1234',
        })
        .expect(201);
      const schedule = dataOf<ScheduleBody>(
        await h.createSchedule(sender.userId, recipient.userId).expect(201),
      );
      await h.getSchedule(sender.userId, schedule.id).expect(200);
      await h.cancelSchedule(sender.userId, schedule.id).expect(201);
      const request = await h
        .http()
        .post('/money-requests')
        .set({
          Authorization: `Bearer ${h.tokenFor(recipient.userId)}`,
        })
        .send({
          payerUserId: sender.userId,
          amount: 100_000,
        });
      expect(request.status).toBeLessThan(500);

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('executeScheduledWithdrawal', () => {
    it('is not called by any controller', () => {
      const offenders = controllerFiles(join(__dirname, '../../src')).filter(
        (file) =>
          readFileSync(file, 'utf8').includes('executeScheduledWithdrawal'),
      );

      expect(offenders).toEqual([]);
    });

    it('is not reached by any request to the withdrawal or scheduling routes', async () => {
      const spy = jest.spyOn(
        ctx.app.get(WithdrawalsService, { strict: false }),
        'executeScheduledWithdrawal',
      );
      const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
      const bank = await h.seedBank(sender.userId);
      const auth = { Authorization: `Bearer ${h.tokenFor(sender.userId)}` };

      await h
        .http()
        .post('/withdrawals')
        .set(auth)
        .send({
          bankAccountId: bank.id,
          amount: 100_000,
          reference: `live-${randomUUID()}`,
          pin: '1234',
        })
        .expect(201);
      const schedule = dataOf<ScheduleBody>(
        await h.createBankSchedule(sender.userId, bank.id).expect(201),
      );
      await h.getSchedule(sender.userId, schedule.id).expect(200);
      await h.cancelSchedule(sender.userId, schedule.id).expect(201);
      const forged = await h
        .http()
        .post('/withdrawals')
        .set(auth)
        .send({
          bankAccountId: bank.id,
          amount: 100_000,
          reference: `live-${randomUUID()}`,
          scheduleId: schedule.id,
          runNumber: 1,
        });
      expect(forged.status).toBe(400);

      expect(spy).not.toHaveBeenCalled();
    });
  });
});
