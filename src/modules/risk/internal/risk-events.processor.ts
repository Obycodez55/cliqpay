import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  DEVICE_REGISTERED_EVENT,
  DeviceRegisteredEventPayload,
  DomainEventEnvelope,
  TRANSFER_SENT_EVENT,
  TransferSentEventPayload,
} from '../../../shared/events/domain-events';
import { RiskService } from '../risk.service';
import { RISK_EVENTS_QUEUE } from './queues';

@Processor(RISK_EVENTS_QUEUE)
export class RiskEventsProcessor extends WorkerHost {
  constructor(private readonly riskService: RiskService) {
    super();
  }

  async process(job: Job<DomainEventEnvelope>): Promise<void> {
    switch (job.data.name) {
      case TRANSFER_SENT_EVENT:
        await this.riskService.handleTransferSent(
          job.data.payload as TransferSentEventPayload,
        );
        return;
      case DEVICE_REGISTERED_EVENT:
        await this.riskService.handleDeviceRegistered(
          job.data.payload as DeviceRegisteredEventPayload,
        );
        return;
    }
  }
}
