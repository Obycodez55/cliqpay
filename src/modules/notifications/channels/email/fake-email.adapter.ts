import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailSender } from './email-sender.interface';
import { maybeThrowSentinelFailure } from '../../internal/errors';

@Injectable()
export class FakeEmailAdapter implements EmailSender {
  private readonly logger = new Logger(FakeEmailAdapter.name);
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    maybeThrowSentinelFailure(message.to, 'FakeEmailAdapter');
    this.sent.push(message);
    this.logger.log(
      `[fake email] to=${message.to} subject="${message.subject}"\n${message.text}`,
    );
    return Promise.resolve();
  }
}
