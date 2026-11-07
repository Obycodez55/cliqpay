import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { EventBusService } from '../event-bus.service';

function fakeQueue() {
  const add = jest.fn().mockResolvedValue(undefined);
  return { queue: { add } as unknown as Queue, add };
}

describe('EventBusService.publish', () => {
  const event = {
    name: 'thing_happened',
    payload: { a: 1 },
    occurredAt: new Date(),
  };

  function build() {
    const domain = fakeQueue();
    const priority = fakeQueue();
    const bus = new EventBusService(domain.queue, priority.queue, {} as Redis);
    return { bus, domain };
  }

  it('adds to domain-events alone when nothing subscribes', async () => {
    const { bus, domain } = build();

    await bus.publish(event);

    expect(domain.add).toHaveBeenCalledWith('thing_happened', event);
  });

  it('also adds to each queue subscribed to the event name, once', async () => {
    const { bus, domain } = build();
    const first = fakeQueue();
    const second = fakeQueue();
    const other = fakeQueue();
    bus.subscribe(first.queue, ['thing_happened', 'thing_happened']);
    bus.subscribe(second.queue, ['thing_happened', 'something_else']);
    bus.subscribe(other.queue, ['something_else']);

    await bus.publish(event);

    expect(domain.add).toHaveBeenCalledTimes(1);
    expect(first.add).toHaveBeenCalledTimes(1);
    expect(first.add).toHaveBeenCalledWith('thing_happened', event);
    expect(second.add).toHaveBeenCalledTimes(1);
    expect(other.add).not.toHaveBeenCalled();
  });
});
