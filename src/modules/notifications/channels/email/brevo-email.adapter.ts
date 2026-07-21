import { Inject, Injectable } from '@nestjs/common';
import { BrevoClient, BrevoError, BrevoTimeoutError } from '@getbrevo/brevo';
import { APP_CONFIG, AppConfig } from '../../../../config';
import { EmailMessage, EmailSender } from './email-sender.interface';
import { classifyHttpFailure } from '../../internal/errors';

@Injectable()
export class BrevoEmailAdapter implements EmailSender {
  private readonly client: BrevoClient;
  private readonly senderEmail: string;
  private readonly senderName?: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new BrevoClient({
      apiKey: config.notifications.brevo.apiKey!,
    });
    this.senderEmail = config.notifications.brevo.senderEmail!;
    this.senderName = config.notifications.brevo.senderName;
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.client.transactionalEmails.sendTransacEmail({
        sender: { email: this.senderEmail, name: this.senderName },
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
      });
    } catch (error) {
      if (error instanceof BrevoTimeoutError) {
        throw new Error(`BrevoEmailAdapter: ${error.message}`);
      }
      if (error instanceof BrevoError) {
        classifyHttpFailure(
          error.statusCode,
          `BrevoEmailAdapter: ${error.message}`,
        );
      }
      throw error;
    }
  }
}
