import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { DomainEventEnvelope } from './domain-events';
import { BULLMQ_REDIS_CONNECTION } from './bullmq-connection.module';

export const DOMAIN_EVENTS_QUEUE = 'domain-events';
export const PRIORITY_DISPATCH_QUEUE = 'priority-dispatch';

const DEFAULT_AWAIT_TIMEOUT_MS = 5_000;

/**
 * The only way any module publishes a cross-module side effect — see
 * docs/architecture.md §10. Callers must publish *after* the originating
 * DB transaction commits, never from inside it: publishing mid-transaction
 * lets a downstream consumer react to a write that then rolls back.
 *
 * `dispatchAndAwait` is the one exception to "publish and move on": for a
 * caller that needs a real answer back — today that's OTP-class sends
 * (verification codes, password reset, MFA challenges), but nothing about
 * the mechanism is OTP-specific — a delivery failure must surface as an
 * error instead of failing silently. It runs on its own queue
 * (`PRIORITY_DISPATCH_QUEUE`), not `DOMAIN_EVENTS_QUEUE`: the job is
 * awaited with a caller-supplied timeout, and priority within a queue only
 * orders jobs still waiting — it can't preempt jobs already running, so
 * sharing a queue with bulk fire-and-forget traffic would leave any
 * awaited caller's latency at the mercy of an unrelated backlog. A
 * separate queue means a separate concurrency pool instead. Any future
 * caller with the same "block briefly, get a real error back" need reuses
 * this same queue and method — consumers on it filter by job name the same
 * way DOMAIN_EVENTS_QUEUE's consumers do.
 */
@Injectable()
export class EventBusService implements OnModuleInit, OnModuleDestroy {
  private priorityQueueEvents!: QueueEvents;
  // QueueEvents.close() only tears down its own listeners — BullMQ never
  // quits a connection it didn't create itself, and a duplicated connection
  // we handed it is exactly that case. Held separately so it can be quit
  // explicitly, or it leaks as a dangling open socket after shutdown.
  private priorityQueueEventsConnection!: Redis;

  constructor(
    @InjectQueue(DOMAIN_EVENTS_QUEUE) private readonly queue: Queue,
    @InjectQueue(PRIORITY_DISPATCH_QUEUE)
    private readonly priorityQueue: Queue,
    @Inject(BULLMQ_REDIS_CONNECTION) private readonly connection: Redis,
  ) {}

  onModuleInit(): void {
    this.priorityQueueEventsConnection = this.connection.duplicate();
    this.priorityQueueEvents = new QueueEvents(PRIORITY_DISPATCH_QUEUE, {
      connection: this.priorityQueueEventsConnection,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.priorityQueueEvents.close();
    await this.priorityQueueEventsConnection.quit();
  }

  async publish<TName extends string, TPayload>(
    event: DomainEventEnvelope<TName, TPayload>,
  ): Promise<void> {
    await this.queue.add(event.name, event);
  }

  async dispatchAndAwait<TName extends string, TPayload>(
    event: DomainEventEnvelope<TName, TPayload>,
    timeoutMs: number = DEFAULT_AWAIT_TIMEOUT_MS,
  ): Promise<void> {
    const job = await this.priorityQueue.add(event.name, event, {
      priority: 1,
    });
    await job.waitUntilFinished(this.priorityQueueEvents, timeoutMs);
  }
}
