import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DomainEventEnvelope } from './domain-events';

export const DOMAIN_EVENTS_QUEUE = 'domain-events';

/**
 * The only way any module publishes a cross-module side effect — see
 * docs/architecture.md §10. Callers must publish *after* the originating
 * DB transaction commits, never from inside it: publishing mid-transaction
 * lets a downstream consumer react to a write that then rolls back.
 */
@Injectable()
export class EventBusService {
  constructor(
    @InjectQueue(DOMAIN_EVENTS_QUEUE) private readonly queue: Queue,
  ) {}

  async publish<TName extends string, TPayload>(
    event: DomainEventEnvelope<TName, TPayload>,
  ): Promise<void> {
    await this.queue.add(event.name, event);
  }
}
