import { Job, Queue } from 'bullmq';
import { NotificationEventsProcessor } from '../internal/notification-events.processor';
import { ChannelDispatchJobData } from '../internal/channel-dispatch.queue';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';

describe('NotificationEventsProcessor', () => {
  let queue: jest.Mocked<Pick<Queue<ChannelDispatchJobData>, 'add'>>;
  let processor: NotificationEventsProcessor;

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    processor = new NotificationEventsProcessor(
      queue as unknown as Queue<ChannelDispatchJobData>,
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
    expect(queue.add).toHaveBeenCalledWith('security_alert', {
      channel: 'email',
      type: 'security_alert',
      payload,
    });
    expect(queue.add).toHaveBeenCalledWith('security_alert', {
      channel: 'push',
      type: 'security_alert',
      payload,
    });
    expect(queue.add).toHaveBeenCalledWith('security_alert', {
      channel: 'in_app',
      type: 'security_alert',
      payload,
    });
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
