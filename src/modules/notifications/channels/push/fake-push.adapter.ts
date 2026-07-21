import { Injectable, Logger } from '@nestjs/common';
import { PushMessage, PushSender } from './push-sender.interface';
import { maybeThrowSentinelFailure } from '../../internal/errors';

@Injectable()
export class FakePushAdapter implements PushSender {
  private readonly logger = new Logger(FakePushAdapter.name);
  readonly sent: PushMessage[] = [];

  send(message: PushMessage): Promise<void> {
    maybeThrowSentinelFailure(message.token, 'FakePushAdapter');
    this.sent.push(message);
    this.logger.log(`[fake push] token=${message.token} "${message.title}"`);
    return Promise.resolve();
  }
}
