import { Repository } from 'typeorm';
import { NotificationService } from '../notification.service';
import { FakeEmailAdapter } from '../channels/email/fake-email.adapter';
import { FakeSmsAdapter } from '../channels/sms/fake-sms.adapter';
import { FakePushAdapter } from '../channels/push/fake-push.adapter';
import { PushToken } from '../entities/push-token.entity';

describe('NotificationService', () => {
  let emailAdapter: FakeEmailAdapter;
  let smsAdapter: FakeSmsAdapter;
  let pushAdapter: FakePushAdapter;
  let pushTokens: jest.Mocked<Pick<Repository<PushToken>, 'find' | 'upsert'>>;
  let service: NotificationService;

  beforeEach(() => {
    emailAdapter = new FakeEmailAdapter();
    smsAdapter = new FakeSmsAdapter();
    pushAdapter = new FakePushAdapter();
    pushTokens = {
      find: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
    };
    service = new NotificationService(
      emailAdapter,
      smsAdapter,
      pushAdapter,
      pushTokens as unknown as Repository<PushToken>,
    );
  });

  it('dispatches an email-only OTP type to the email adapter only', async () => {
    await service.send('email_verification_otp', {
      userId: 'u1',
      email: 'a@example.com',
      verificationUrl: 'https://app.cliqpay.example/verify-email?token=abc',
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
      }),
    ).rejects.toThrow();
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
});
