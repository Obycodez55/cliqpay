import { Job, Queue } from 'bullmq';
import { NotificationEventsProcessor } from '../internal/notification-events.processor';
import { ChannelDispatchJobData } from '../internal/channel-dispatch.queue';
import { AppConfig } from '../../../config';
import { verifySelfLockToken } from '../../../shared/crypto/self-lock-token.util';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';

const SELF_LOCK_KEY_HEX = 'f'.repeat(64);
const SELF_LOCK_LINK_URL = 'https://app.cliqpay.test/lock';

describe('NotificationEventsProcessor', () => {
  let queue: jest.Mocked<Pick<Queue<ChannelDispatchJobData>, 'add'>>;
  let processor: NotificationEventsProcessor;

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    processor = new NotificationEventsProcessor(
      queue as unknown as Queue<ChannelDispatchJobData>,
      {
        selfLock: { tokenKey: SELF_LOCK_KEY_HEX, linkUrl: SELF_LOCK_LINK_URL },
      } as AppConfig,
    );
  });

  function jobFor(name: string, payload: unknown): Job<DomainEventEnvelope> {
    return {
      name,
      data: { name, payload, occurredAt: new Date() },
    } as unknown as Job<DomainEventEnvelope>;
  }

  it('enqueues one channel-dispatch job per channel a multi-channel type routes to', async () => {
    const payload = {
      userId: 'u1',
      email: 'a@example.com',
      message: 'New device login',
      occurredAt: '2026-08-15T10:32:00.000Z',
    };
    await processor.process(jobFor('security_alert', payload));

    expect(queue.add).toHaveBeenCalledTimes(3);
    for (const channel of ['email', 'push', 'in_app']) {
      expect(queue.add).toHaveBeenCalledWith('security_alert', {
        channel,
        type: 'security_alert',
        payload: { ...payload, lockUrl: expect.any(String) as string },
      });
    }
  });

  it('adds a lock link to every security alert whose token locks that user', async () => {
    await processor.process(
      jobFor('security_alert', {
        userId: '6f1c2f1e-9a3b-4c55-8d0e-2b7c9e1a4d10',
        email: 'a@example.com',
        message: 'Bank account added',
        occurredAt: '2026-08-15T10:32:00.000Z',
      }),
    );

    const { payload } = queue.add.mock.calls[0][1] as {
      payload: { lockUrl: string };
    };
    const url = new URL(payload.lockUrl);
    expect(url.origin + url.pathname).toBe(SELF_LOCK_LINK_URL);
    expect(
      verifySelfLockToken(
        Buffer.from(SELF_LOCK_KEY_HEX, 'hex'),
        url.searchParams.get('token')!,
      ),
    ).toEqual({ userId: '6f1c2f1e-9a3b-4c55-8d0e-2b7c9e1a4d10' });
  });

  it('adds no lock link to other notification types', async () => {
    await processor.process(
      jobFor('account_self_locked', {
        userId: 'u1',
        email: 'a@example.com',
        occurredAt: '2026-08-15T10:32:00.000Z',
      }),
    );

    for (const [, data] of queue.add.mock.calls) {
      expect(data.payload).not.toHaveProperty('lockUrl');
    }
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('enqueues a single channel-dispatch job for a single-channel type', async () => {
    const payload = {
      userId: 'u1',
      phone: '+2348012345678',
      code: '123456',
      expiresInMinutes: 10,
    };
    await processor.process(jobFor('phone_verification_otp', payload));

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith('phone_verification_otp', {
      channel: 'sms',
      type: 'phone_verification_otp',
      payload,
    });
  });

  describe('money_request_created', () => {
    const basePayload = {
      userId: 'payer',
      email: 'payer@example.com',
      counterpartyUsername: 'requester',
      amount: '100.00',
      currency: 'NGN',
      note: null,
      moneyRequestId: 'mr1',
    };

    function enqueuedChannels(): string[] {
      return queue.add.mock.calls.map(([, data]) => data.channel);
    }

    it('uses every catalog channel when the payer follows the requester', async () => {
      await processor.process(
        jobFor('money_request_created', { ...basePayload, fromFollowed: true }),
      );
      expect(enqueuedChannels().sort()).toEqual(['email', 'in_app', 'push']);
    });

    it('routes to in-app only when the payer does not follow the requester', async () => {
      await processor.process(
        jobFor('money_request_created', {
          ...basePayload,
          fromFollowed: false,
        }),
      );
      expect(enqueuedChannels()).toEqual(['in_app']);
    });

    it('keeps every catalog channel for an event published without fromFollowed', async () => {
      await processor.process(jobFor('money_request_created', basePayload));
      expect(enqueuedChannels().sort()).toEqual(['email', 'in_app', 'push']);
    });
  });

  it('skips job names it does not own without enqueueing anything', async () => {
    await processor.process(jobFor('some_other_domain_event', { foo: 'bar' }));
    expect(queue.add).not.toHaveBeenCalled();
  });
});
