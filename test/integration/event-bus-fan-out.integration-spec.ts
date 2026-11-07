import { INestApplication, Module, OnModuleInit } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { EventBusModule } from '../../src/shared/events/event-bus.module';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { DomainEventEnvelope } from '../../src/shared/events/domain-events';
import {
  buildTestAppConfig,
  buildTestConfigModule,
} from './support/test-app-config';
import { closeBullmqWorkers } from './support/bullmq-teardown';

jest.setTimeout(120_000);

const FLAKY_QUEUE = 'test-subscriber-flaky';
const STEADY_QUEUE = 'test-subscriber-steady';
const WATCHED_EVENT = 'test_fan_out_watched';
const UNWATCHED_EVENT = 'test_fan_out_unwatched';

const runs = { flaky: 0, steady: 0, flakyEvents: [] as string[] };

@Processor(FLAKY_QUEUE)
class FlakySubscriber extends WorkerHost {
  process(job: Job<DomainEventEnvelope>): Promise<void> {
    runs.flaky += 1;
    runs.flakyEvents.push(job.name);
    if (runs.flaky === 1) {
      return Promise.reject(new Error('flaky subscriber failed'));
    }
    return Promise.resolve();
  }
}

@Processor(STEADY_QUEUE)
class SteadySubscriber extends WorkerHost {
  process(): Promise<void> {
    runs.steady += 1;
    return Promise.resolve();
  }
}

const retryingJobs = {
  attempts: 3,
  backoff: { type: 'fixed' as const, delay: 50 },
};

@Module({
  imports: [
    EventBusModule,
    BullModule.registerQueue(
      { name: FLAKY_QUEUE, defaultJobOptions: retryingJobs },
      { name: STEADY_QUEUE, defaultJobOptions: retryingJobs },
    ),
  ],
  providers: [FlakySubscriber, SteadySubscriber],
})
class TestSubscribersModule implements OnModuleInit {
  constructor(
    private readonly eventBus: EventBusService,
    @InjectQueue(FLAKY_QUEUE) private readonly flakyQueue: Queue,
    @InjectQueue(STEADY_QUEUE) private readonly steadyQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.eventBus.subscribe(this.flakyQueue, [WATCHED_EVENT]);
    this.eventBus.subscribe(this.steadyQueue, [WATCHED_EVENT]);
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('event bus per-subscriber fan-out', () => {
  let redis: StartedTestContainer;
  let moduleRef: TestingModule;
  let app: INestApplication;
  let eventBus: EventBusService;

  beforeAll(async () => {
    redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();
    const config = buildTestAppConfig({
      redis: {
        url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      },
    });
    moduleRef = await Test.createTestingModule({
      imports: [buildTestConfigModule(config), TestSubscribersModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    eventBus = moduleRef.get(EventBusService);
  });

  afterAll(async () => {
    await closeBullmqWorkers(app);
    await app.close();
    await redis.stop();
  });

  beforeEach(() => {
    runs.flaky = 0;
    runs.steady = 0;
    runs.flakyEvents = [];
  });

  function envelope(name: string): DomainEventEnvelope {
    return { name, payload: {}, occurredAt: new Date() };
  }

  it('retries only the failing subscriber, leaving the other subscriber with one run', async () => {
    await eventBus.publish(envelope(WATCHED_EVENT));

    await waitFor(() => runs.flaky >= 2 && runs.steady >= 1);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(runs.flaky).toBe(2);
    expect(runs.steady).toBe(1);
  });

  it('delivers an event only to the queues subscribed to its name', async () => {
    await eventBus.publish(envelope(UNWATCHED_EVENT));
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(runs.flaky).toBe(0);
    expect(runs.steady).toBe(0);
  });
});
