import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../../config';
import { SmsMessage, SmsSender } from './sms-sender.interface';
import { classifyHttpFailure } from '../../internal/errors';

const TERMII_SEND_URL = 'https://api.ns.termii.com/api/sms/send';

@Injectable()
export class TermiiSmsAdapter implements SmsSender {
  private readonly apiKey: string;
  private readonly senderId: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.apiKey = config.notifications.termii.apiKey!;
    this.senderId = config.notifications.termii.senderId!;
  }

  async send(message: SmsMessage): Promise<void> {
    let response: Response;
    try {
      response = await fetch(TERMII_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          to: message.to,
          from: this.senderId,
          sms: message.body,
          type: 'plain',
          channel: 'generic',
        }),
      });
    } catch (error) {
      throw new Error(
        `TermiiSmsAdapter: network error (${(error as Error).message})`,
      );
    }

    if (!response.ok) {
      const body = await response.text();
      classifyHttpFailure(
        response.status,
        `TermiiSmsAdapter: ${response.status} ${body}`,
      );
    }
  }
}
