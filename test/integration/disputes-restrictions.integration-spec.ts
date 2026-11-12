import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { IsNull } from 'typeorm';
import {
  DisputesTestContext,
  createDisputesTestContext,
  destroyDisputesTestContext,
  fundWallet,
  seedDisputesUser,
} from './support/disputes-test-context';
import { trackSettled, waitBriefly } from './support/user-lock';
import { TEST_INTERNAL_API_SECRET } from './support/test-app-config';
import { AccountRestriction } from '../../src/modules/users/entities/account-restriction.entity';

jest.setTimeout(180_000);

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  action: string;
  subject_id: string;
  metadata: Record<string, unknown>;
}

describe('account restrictions and audit trail', () => {
  let ctx: DisputesTestContext;
  let idSeq = 0;

  beforeAll(async () => {
    ctx = await createDisputesTestContext();
  });

  afterAll(async () => {
    await destroyDisputesTestContext(ctx);
  });

  async function seedLowBalanceUser() {
    idSeq += 1;
    const { userId, walletId } = await seedDisputesUser(ctx, {
      email: `restriction-${idSeq}@example.com`,
      phone: `+2348066${String(500_000 + idSeq).padStart(6, '0')}`,
      username: `restriction_user_${idSeq}`,
    });
    const fundingReference = `cliqpay-fund-${userId}`;
    await fundWallet(ctx, {
      reference: fundingReference,
      walletId,
      netAmountMinor: 100_000n,
    });
    await ctx.accountRepo.update({ id: walletId }, { balance: 20_000n });
    return { userId, walletId, fundingReference };
  }

  async function seedFrozenByChargeback() {
    const { userId, walletId, fundingReference } = await seedLowBalanceUser();
    const disputeReference = `dispute-${fundingReference}-restriction`;
    const res = await request(ctx.app.getHttpServer())
      .post('/disputes/chargebacks')
      .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
      .set('X-Reviewer-Id', 'reviewer-7')
      .send({
        originalTransactionReference: fundingReference,
        amount: 100_000,
        disputeReference,
      });
    expect(res.status).toBe(201);
    return { userId, walletId, disputeReference };
  }

  function resolveInFavour(disputeReference: string) {
    return request(ctx.app.getHttpServer())
      .post('/disputes/resolve')
      .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
      .set('X-Reviewer-Id', 'reviewer-8')
      .send({ disputeReference, outcome: 'resolved', amount: 100_000 });
  }

  function openRestrictions(userId: string) {
    return ctx.dataSource
      .getRepository(AccountRestriction)
      .find({ where: { userId, liftedAt: IsNull() } });
  }

  function auditRows(userId: string): Promise<AuditRow[]> {
    return ctx.dataSource.query(
      `SELECT actor_type, actor_id, action, subject_id, metadata
       FROM audit_events WHERE subject_id = $1 ORDER BY occurred_at, id`,
      [userId],
    );
  }

  it('lets dispute resolution lift only its own dispute row, leaving a fraud restriction in place', async () => {
    const { userId, disputeReference } = await seedFrozenByChargeback();
    await ctx.dataSource.transaction((manager) =>
      ctx.usersService.addRestriction(manager, {
        userId,
        reason: 'fraud',
        scope: 'outbound',
        sourceId: randomUUID(),
        actor: { type: 'reviewer', id: 'reviewer-7' },
      }),
    );

    const res = await resolveInFavour(disputeReference);

    expect(res.status).toBe(201);
    const stillOpen = await openRestrictions(userId);
    expect(stillOpen.map((row) => row.reason)).toEqual(['fraud']);
    const lifted = await ctx.dataSource
      .getRepository(AccountRestriction)
      .findOneByOrFail({ userId, reason: 'dispute' });
    expect(lifted.liftedAt).not.toBeNull();
    expect(lifted.liftedBy).toBe('reviewer-8');
  });

  it('takes the user lock before the wallet row, so a racing money path cannot deadlock with a chargeback', async () => {
    const { userId, walletId, fundingReference } = await seedLowBalanceUser();
    const queryRunner = ctx.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await queryRunner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      userId,
    ]);

    const chargeback = trackSettled(
      request(ctx.app.getHttpServer())
        .post('/disputes/chargebacks')
        .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
        .set('X-Reviewer-Id', 'reviewer-7')
        .send({
          originalTransactionReference: fundingReference,
          amount: 100_000,
          disputeReference: `dispute-${fundingReference}-deadlock`,
        }),
    );
    await waitBriefly();
    expect(chargeback.isSettled()).toBe(false);

    await queryRunner.query(
      'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
      [walletId],
    );
    await queryRunner.commitTransaction();
    await queryRunner.release();

    const res = await chargeback.promise;
    expect(res.status).toBe(201);
    expect(await openRestrictions(userId)).toHaveLength(1);
  });

  it('records restriction add and lift with the reviewer as actor', async () => {
    const { userId, disputeReference } = await seedFrozenByChargeback();
    await resolveInFavour(disputeReference).expect(201);

    const rows = await auditRows(userId);

    expect(rows.map((row) => row.action)).toEqual([
      'restriction_added',
      'restriction_lifted',
    ]);
    expect(rows[0]).toMatchObject({
      actor_type: 'reviewer',
      actor_id: 'reviewer-7',
      metadata: { reason: 'dispute', scope: 'outbound' },
    });
    expect(rows[1]).toMatchObject({
      actor_type: 'reviewer',
      actor_id: 'reviewer-8',
    });
  });

  it('adding the same open restriction twice keeps one row and one audit event', async () => {
    const { userId } = await seedFrozenByChargeback();
    const sourceId = randomUUID();
    const add = () =>
      ctx.dataSource.transaction((manager) =>
        ctx.usersService.addRestriction(manager, {
          userId,
          reason: 'fraud',
          scope: 'outbound',
          sourceId,
          actor: { type: 'system', id: null },
        }),
      );

    expect(await add()).toBe(true);
    expect(await add()).toBe(false);

    const fraud = (await openRestrictions(userId)).filter(
      (row) => row.reason === 'fraud',
    );
    expect(fraud).toHaveLength(1);
    const added = (await auditRows(userId)).filter(
      (row) => row.metadata.reason === 'fraud',
    );
    expect(added).toHaveLength(1);
  });

  it('reports blocksInbound only for an all-scope restriction', async () => {
    const { userId } = await seedFrozenByChargeback();
    expect(
      await ctx.usersService.getRestrictionState(
        ctx.dataSource.manager,
        userId,
      ),
    ).toEqual({ blocksOutbound: true, blocksInbound: false });

    await ctx.dataSource.transaction((manager) =>
      ctx.usersService.addRestriction(manager, {
        userId,
        reason: 'sanctions',
        scope: 'all',
        sourceId: randomUUID(),
        actor: { type: 'system', id: null },
      }),
    );

    expect(
      await ctx.usersService.getRestrictionState(
        ctx.dataSource.manager,
        userId,
      ),
    ).toEqual({ blocksOutbound: true, blocksInbound: true });
  });

  it('refuses to update or delete an audit event', async () => {
    const { userId } = await seedFrozenByChargeback();

    await expect(
      ctx.dataSource.query(
        `UPDATE audit_events SET action = 'x' WHERE subject_id = $1`,
        [userId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.dataSource.query(`DELETE FROM audit_events WHERE subject_id = $1`, [
        userId,
      ]),
    ).rejects.toThrow(/append-only/);
    expect(await auditRows(userId)).toHaveLength(1);
  });

  describe('X-Reviewer-Id', () => {
    it.each([
      ['POST', '/disputes/chargebacks'],
      ['POST', '/disputes/resolve'],
      ['GET', '/disputes/collections'],
    ])('rejects %s %s without the header', async (method, path) => {
      const http = ctx.app.getHttpServer();
      const req =
        method === 'GET' ? request(http).get(path) : request(http).post(path);

      const res = await req.set('X-Internal-Secret', TEST_INTERNAL_API_SECRET);

      expect(res.status).toBe(401);
    });

    it('rejects a blank header', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/disputes/collections')
        .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
        .set('X-Reviewer-Id', '   ');

      expect(res.status).toBe(401);
    });
  });
});
