import { Repository } from 'typeorm';
import { UnrecoverableError } from 'bullmq';
import { NotificationService } from '../notification.service';
import { FakeEmailAdapter } from '../channels/email/fake-email.adapter';
import { FakeSmsAdapter } from '../channels/sms/fake-sms.adapter';
import { FakePushAdapter } from '../channels/push/fake-push.adapter';
import { PushToken } from '../entities/push-token.entity';
import { Notification } from '../entities/notification.entity';

const OCCURRED_AT = '2026-08-15T10:32:00.000Z';

describe('NotificationService', () => {
  let emailAdapter: FakeEmailAdapter;
  let smsAdapter: FakeSmsAdapter;
  let pushAdapter: FakePushAdapter;
  let pushTokens: jest.Mocked<Pick<Repository<PushToken>, 'find' | 'upsert'>>;
  let notifications: jest.Mocked<
    Pick<Repository<Notification>, 'create' | 'save'>
  >;
  let service: NotificationService;

  beforeEach(() => {
    emailAdapter = new FakeEmailAdapter();
    smsAdapter = new FakeSmsAdapter();
    pushAdapter = new FakePushAdapter();
    pushTokens = {
      find: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
    };
    notifications = {
      create: jest.fn(
        (entity: unknown) => entity as Notification,
      ) as unknown as jest.Mocked<Repository<Notification>>['create'],
      save: jest.fn(),
    };
    service = new NotificationService(
      emailAdapter,
      smsAdapter,
      pushAdapter,
      pushTokens as unknown as Repository<PushToken>,
      notifications as unknown as Repository<Notification>,
    );
  });

  it('dispatches an email-only OTP type to the email adapter only', async () => {
    await service.send('email_verification_otp', {
      userId: 'u1',
      email: 'a@example.com',
      code: '123456',
      expiresInMinutes: 10,
    });
    expect(emailAdapter.sent).toHaveLength(1);
    expect(emailAdapter.sent[0].to).toBe('a@example.com');
    expect(smsAdapter.sent).toHaveLength(0);
    expect(pushAdapter.sent).toHaveLength(0);
  });

  it('dispatches an sms-only OTP type to the sms adapter only', async () => {
    await service.send('phone_verification_otp', {
      userId: 'u1',
      phone: '+2348012345678',
      code: '123456',
      expiresInMinutes: 10,
    });
    expect(smsAdapter.sent).toHaveLength(1);
    expect(smsAdapter.sent[0].to).toBe('+2348012345678');
    expect(emailAdapter.sent).toHaveLength(0);
  });

  it('fans a multi-channel type out to email and every registered push device', async () => {
    pushTokens.find.mockResolvedValue([
      { token: 'device-1' } as PushToken,
      { token: 'device-2' } as PushToken,
    ]);
    await service.send('security_alert', {
      userId: 'u1',
      email: 'a@example.com',
      message: 'New device login',
      occurredAt: OCCURRED_AT,
    });
    expect(emailAdapter.sent).toHaveLength(1);
    expect(pushAdapter.sent.map((m) => m.token).sort()).toEqual([
      'device-1',
      'device-2',
    ]);
  });

  it('is a no-op on push when the user has no registered tokens', async () => {
    await service.send('security_alert', {
      userId: 'u1',
      email: 'a@example.com',
      message: 'x',
      occurredAt: OCCURRED_AT,
    });
    expect(pushAdapter.sent).toHaveLength(0);
  });

  it('skips a dead push token without failing delivery to the user’s other devices', async () => {
    pushTokens.find.mockResolvedValue([
      { token: 'device-fail-permanent' } as PushToken,
      { token: 'device-ok' } as PushToken,
    ]);
    await service.send('security_alert', {
      userId: 'u1',
      email: 'a@example.com',
      message: 'x',
      occurredAt: OCCURRED_AT,
    });
    expect(pushAdapter.sent.map((m) => m.token)).toEqual(['device-ok']);
  });

  it('propagates a transient push failure so BullMQ can retry', async () => {
    pushTokens.find.mockResolvedValue([
      { token: 'device-fail-transient' } as PushToken,
    ]);
    await expect(
      service.send('security_alert', {
        userId: 'u1',
        email: 'a@example.com',
        message: 'x',
        occurredAt: OCCURRED_AT,
      }),
    ).rejects.toThrow();
  });

  it('sendToChannel delivers to exactly the requested channel, not the others', async () => {
    await service.sendToChannel('email', 'security_alert', {
      userId: 'u1',
      email: 'a@example.com',
      message: 'New device login',
      occurredAt: OCCURRED_AT,
    });
    expect(emailAdapter.sent).toHaveLength(1);
    expect(pushAdapter.sent).toHaveLength(0);
  });

  it('sendToChannel throws UnrecoverableError for a channel with no template, without retrying', async () => {
    await expect(
      service.sendToChannel('push', 'funding_completed', {
        userId: 'u1',
        email: 'a@example.com',
        amount: '5000.00',
        currency: 'NGN',
        reference: 'cliqpay-ref-1',
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('upserts on push token registration, keyed on token', async () => {
    await service.registerPushToken('u1', 'ios', 'tok-1');
    expect(pushTokens.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        platform: 'ios',
        token: 'tok-1',
      }),
      ['token'],
    );
  });

  describe('in-app channel', () => {
    it('writes a row derived from the payload and the in-app template', async () => {
      await service.sendToChannel('in_app', 'funding_completed', {
        userId: 'u1',
        email: 'a@example.com',
        amount: '5000.00',
        currency: 'NGN',
        reference: 'cliqpay-ref-1',
      });
      expect(notifications.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          type: 'funding_completed',
          dedupeKey: 'cliqpay-ref-1',
          title: 'Wallet funded',
        }),
      );
    });

    it('treats a (user_id, type, dedupe_key) unique violation as a no-op, not an error', async () => {
      notifications.save.mockRejectedValueOnce({
        code: '23505',
        constraint: 'UQ_notifications_user_id_type_dedupe_key',
      });
      await expect(
        service.sendToChannel('in_app', 'funding_completed', {
          userId: 'u1',
          email: 'a@example.com',
          amount: '5000.00',
          currency: 'NGN',
          reference: 'cliqpay-ref-1',
        }),
      ).resolves.toBeUndefined();
    });

    it('rethrows a unique violation on a different constraint', async () => {
      notifications.save.mockRejectedValueOnce({
        code: '23505',
        constraint: 'some_other_constraint',
      });
      await expect(
        service.sendToChannel('in_app', 'funding_completed', {
          userId: 'u1',
          email: 'a@example.com',
          amount: '5000.00',
          currency: 'NGN',
          reference: 'cliqpay-ref-1',
        }),
      ).rejects.toBeDefined();
    });

    it('throws UnrecoverableError for a type with no in-app template', async () => {
      await expect(
        service.sendToChannel('in_app', 'reconciliation_mismatch', {
          email: 'ops@cliqpay.test',
          provider: 'kora',
          currency: 'NGN',
          ledgerBalance: '0',
          providerBalance: '0',
          delta: '0',
          occurredAt: OCCURRED_AT,
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });
  });

  describe('markRead', () => {
    it('scopes the update by userId in the WHERE clause and guards on read_at IS NULL', async () => {
      const execute = jest.fn().mockResolvedValue({ affected: 1 });
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute,
      };
      (
        notifications as unknown as { createQueryBuilder: jest.Mock }
      ).createQueryBuilder = jest.fn().mockReturnValue(qb);

      await service.markRead('u1', { ids: ['n1', 'n2'] });

      expect(qb.where).toHaveBeenCalledWith('user_id = :userId', {
        userId: 'u1',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('id IN (:...ids)', {
        ids: ['n1', 'n2'],
      });
      expect(qb.andWhere).toHaveBeenCalledWith('read_at IS NULL');
      expect(execute).toHaveBeenCalled();
    });

    it('is a no-op when neither ids nor all is supplied', async () => {
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn(),
      };
      (
        notifications as unknown as { createQueryBuilder: jest.Mock }
      ).createQueryBuilder = jest.fn().mockReturnValue(qb);

      await service.markRead('u1', {});

      expect(qb.execute).not.toHaveBeenCalled();
    });
  });
});
