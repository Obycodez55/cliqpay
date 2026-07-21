import { Injectable, Logger } from '@nestjs/common';
import { SmsMessage, SmsSender } from './sms-sender.interface';
import { maybeThrowSentinelFailure } from '../../internal/errors';

@Injectable()
export class FakeSmsAdapter implements SmsSender {
  private readonly logger = new Logger(FakeSmsAdapter.name);
  readonly sent: SmsMessage[] = [];

  send(message: SmsMessage): Promise<void> {
    maybeThrowSentinelFailure(message.to, 'FakeSmsAdapter');
    this.sent.push(message);
    this.logger.log(`[fake sms] to=${message.to} "${message.body}"`);
    return Promise.resolve();
  }
}
