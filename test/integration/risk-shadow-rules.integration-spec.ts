import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TrustedDevice } from '../../src/modules/auth/entities/trusted-device.entity';
import { RISK_EVENTS_QUEUE } from '../../src/modules/risk/internal/queues';
import {
  DEVICE_REGISTERED_EVENT,
  DeviceRegisteredEventPayload,
} from '../../src/shared/events/domain-events';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { waitFor } from './support/social-blocks-test-helpers';
import {
  RiskTestContext,
  RiskUser,
  createRiskTestContext,
  destroyRiskTestContext,
  payoutsFor,
  seedRiskUser,
  sendP2p,
  withdraw,
} from './support/risk-test-context';

jest.setTimeout(180_000);

describe('shadow rules raised after commit', () => {
  let ctx: RiskTestContext;

  beforeAll(async () => {
    ctx = await createRiskTestContext();
  });

  afterAll(async () => {
    await destroyRiskTestContext(ctx);
  });

  const flagsOf = (userId: string, ruleCode: string) =>
    ctx.flagRepo.findBy({ userId, ruleCode });

  async function eventsSettled(): Promise<void> {
    const queue = ctx.app.get<Queue>(getQueueToken(RISK_EVENTS_QUEUE));
    await waitFor(async () => {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'prioritized',
      );
      return Object.values(counts).every((n) => n === 0);
    }, 20_000);
  }

  async function bindDevice(userId: string, deviceId: string) {
    await ctx.trustedDeviceRepo.save(
      ctx.trustedDeviceRepo.create({
        userId,
        tokenHash: randomUUID(),
        deviceId,
        publicKey: null,
        attestationResult: 'passed',
        device: {} as TrustedDevice['device'],
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        lastUsedAt: new Date(),
      }),
    );
  }

  const registered = (
    userId: string,
    deviceId: string,
    attestationResult: DeviceRegisteredEventPayload['attestationResult'] = 'passed',
  ): DeviceRegisteredEventPayload => ({ userId, deviceId, attestationResult });

  describe('send_burst', () => {
    async function sendMany(
      sender: RiskUser,
      recipients: RiskUser[],
      n: number,
    ) {
      for (let i = 0; i < n; i++) {
        await sendP2p(ctx, sender, recipients[i % recipients.length], 100_000);
      }
    }

    it('flags 10 sends in 10 minutes through the transfer_sent event, as a shadow flag', async () => {
      const sender = await seedRiskUser(ctx, {
        balanceMinor: 5_000_000n,
        ageDays: 30,
      });
      const friend = await seedRiskUser(ctx, { ageDays: 30 });

      await sendMany(sender, [friend], 10);
      await eventsSettled();

      const [flag] = await flagsOf(sender.userId, 'send_burst');
      expect(flag).toMatchObject({ enforced: false, kind: 'fraud' });
      expect(flag.evidence[0]).toMatchObject({ sends: 10 });
    });

    it('flags 5 first-time recipients in an hour', async () => {
      const sender = await seedRiskUser(ctx, {
        balanceMinor: 5_000_000n,
        ageDays: 30,
      });
      const recipients: RiskUser[] = [];
      for (let i = 0; i < 5; i++) {
        recipients.push(await seedRiskUser(ctx, { ageDays: 30 }));
      }

      await sendMany(sender, recipients, 5);
      await eventsSettled();

      const [flag] = await flagsOf(sender.userId, 'send_burst');
      expect(flag.evidence[0]).toMatchObject({ firstTimeRecipients: 5 });
    });

    it('does not flag 9 sends to one person', async () => {
      const sender = await seedRiskUser(ctx, {
        balanceMinor: 5_000_000n,
        ageDays: 30,
      });
      const friend = await seedRiskUser(ctx, { ageDays: 30 });

      await sendMany(sender, [friend], 9);
      await eventsSettled();

      expect(await flagsOf(sender.userId, 'send_burst')).toHaveLength(0);
    });

    it('does not count a long-standing recipient as first-time', async () => {
      const sender = await seedRiskUser(ctx, {
        balanceMinor: 5_000_000n,
        ageDays: 30,
      });
      const friends: RiskUser[] = [];
      for (let i = 0; i < 5; i++) {
        friends.push(await seedRiskUser(ctx, { ageDays: 30 }));
      }
      await sendMany(sender, friends, 5);
      await eventsSettled();
      await ctx.flagRepo.delete({ userId: sender.userId });
      await ctx.dataSource.query(
        `UPDATE transactions SET created_at = created_at - interval '3 hours'
          WHERE sender_wallet_id = $1`,
        [sender.walletId],
      );

      await sendMany(sender, friends, 5);
      await eventsSettled();

      expect(await flagsOf(sender.userId, 'send_burst')).toHaveLength(0);
    });

    it('counts a repeat hit on the same open flag', async () => {
      const sender = await seedRiskUser(ctx, {
        balanceMinor: 5_000_000n,
        ageDays: 30,
      });
      const friend = await seedRiskUser(ctx, { ageDays: 30 });
      await sendMany(sender, [friend], 10);
      await eventsSettled();

      await ctx.riskService.handleTransferSent({
        userId: sender.userId,
        email: sender.email,
        counterpartyUsername: 'x',
        amount: '1.00',
        currency: 'NGN',
        reference: 'again',
      });

      const flags = await flagsOf(sender.userId, 'send_burst');
      expect(flags).toHaveLength(1);
      expect(flags[0].hitCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('shared_device', () => {
    it('flags the third user bound to one device within 30 days', async () => {
      const deviceId = `shared-${randomUUID()}`;
      const users = [
        await seedRiskUser(ctx),
        await seedRiskUser(ctx),
        await seedRiskUser(ctx),
      ];
      for (const user of users) {
        await bindDevice(user.userId, deviceId);
      }

      await ctx.riskService.handleDeviceRegistered(
        registered(users[2].userId, deviceId),
      );

      const [flag] = await flagsOf(users[2].userId, 'shared_device');
      expect(flag).toMatchObject({ enforced: false });
      expect(flag.evidence[0]).toMatchObject({ deviceId, usersOnDevice: 3 });
    });

    it('does not flag two users on one device', async () => {
      const deviceId = `pair-${randomUUID()}`;
      const users = [await seedRiskUser(ctx), await seedRiskUser(ctx)];
      for (const user of users) {
        await bindDevice(user.userId, deviceId);
      }

      await ctx.riskService.handleDeviceRegistered(
        registered(users[1].userId, deviceId),
      );

      expect(await flagsOf(users[1].userId, 'shared_device')).toHaveLength(0);
    });

    it('does not count a binding older than 30 days', async () => {
      const deviceId = `old-${randomUUID()}`;
      const users = [
        await seedRiskUser(ctx),
        await seedRiskUser(ctx),
        await seedRiskUser(ctx),
      ];
      for (const user of users) {
        await bindDevice(user.userId, deviceId);
      }
      await ctx.trustedDeviceRepo.update(
        { userId: users[0].userId },
        { createdAt: new Date(Date.now() - 31 * 86_400_000) },
      );

      await ctx.riskService.handleDeviceRegistered(
        registered(users[2].userId, deviceId),
      );

      expect(await flagsOf(users[2].userId, 'shared_device')).toHaveLength(0);
    });
  });

  describe('device_integrity', () => {
    it('flags a failed attestation, delivered through the device_registered event', async () => {
      const user = await seedRiskUser(ctx);
      const deviceId = `fail-${randomUUID()}`;
      await bindDevice(user.userId, deviceId);

      await ctx.app.get(EventBusService).publish({
        name: DEVICE_REGISTERED_EVENT,
        payload: registered(user.userId, deviceId, 'failed'),
        occurredAt: new Date(),
      });

      await waitFor(
        async () =>
          (await flagsOf(user.userId, 'device_integrity')).length === 1,
        20_000,
      );
      const [flag] = await flagsOf(user.userId, 'device_integrity');
      expect(flag).toMatchObject({ enforced: false, status: 'open' });
    });

    it.each(['passed', 'unavailable'] as const)(
      'does not flag a %s attestation',
      async (result) => {
        const user = await seedRiskUser(ctx);
        const deviceId = `ok-${randomUUID()}`;
        await bindDevice(user.userId, deviceId);

        await ctx.riskService.handleDeviceRegistered(
          registered(user.userId, deviceId, result),
        );

        expect(await flagsOf(user.userId, 'device_integrity')).toHaveLength(0);
      },
    );
  });

  describe('what a shadow flag does', () => {
    it('holds nothing: the withdrawal goes to Kora', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 2_000_000n,
        ageDays: 30,
      });
      const deviceId = `hold-${randomUUID()}`;
      await bindDevice(user.userId, deviceId);
      await ctx.riskService.handleDeviceRegistered(
        registered(user.userId, deviceId, 'failed'),
      );
      expect(await flagsOf(user.userId, 'device_integrity')).toHaveLength(1);

      const { reference, response } = await withdraw(ctx, user, 100_000);

      expect(response.status).toBe('pending');
      expect(payoutsFor(ctx, reference)).toHaveLength(1);
    });
  });
  describe('a repeat hit on an open flag', () => {
    const hit = (enforced: boolean) => ({
      ruleCode: 'mule_fan_in' as const,
      enforced,
      evidence: { n: 1 },
    });
    const record = (userId: string, enforced: boolean) =>
      ctx.dataSource.transaction((manager) =>
        ctx.riskService.recordHit(manager, userId, hit(enforced)),
      );

    it('upgrades a shadow flag to enforced once the rule enforces', async () => {
      const user = await seedRiskUser(ctx, { ageDays: 30 });
      await record(user.userId, false);
      await record(user.userId, true);

      const [flag] = await flagsOf(user.userId, 'mule_fan_in');
      expect(flag.enforced).toBe(true);
      expect(flag.hitCount).toBe(2);
    });

    it('never downgrades an enforced flag', async () => {
      const user = await seedRiskUser(ctx, { ageDays: 30 });
      await record(user.userId, true);
      await record(user.userId, false);

      const [flag] = await flagsOf(user.userId, 'mule_fan_in');
      expect(flag.enforced).toBe(true);
    });
  });
});
