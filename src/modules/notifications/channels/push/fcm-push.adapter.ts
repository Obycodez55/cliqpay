import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnrecoverableError } from 'bullmq';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { APP_CONFIG, AppConfig } from '../../../../config';
import { PushToken } from '../../entities/push-token.entity';
import { PushMessage, PushSender } from './push-sender.interface';

// FCM error codes that mean the token itself is dead — the row is deleted
// so a dead token is never retried, per issue #1's push-token lifecycle.
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

// Everything else FCM can throw that's actually transient.
const TRANSIENT_CODES = new Set([
  'messaging/internal-error',
  'messaging/server-unavailable',
]);

@Injectable()
export class FcmPushAdapter implements PushSender {
  private readonly app: App;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @InjectRepository(PushToken)
    private readonly pushTokens: Repository<PushToken>,
  ) {
    const { projectId, clientEmail, privateKey } =
      config.notifications.firebase;
    this.app =
      getApps()[0] ??
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey: privateKey?.replace(/\\n/g, '\n'),
        }),
      });
  }

  async send(message: PushMessage): Promise<void> {
    try {
      await getMessaging(this.app).send({
        token: message.token,
        notification: { title: message.title, body: message.body },
        data: message.data,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;

      if (code && INVALID_TOKEN_CODES.has(code)) {
        await this.pushTokens.delete({ token: message.token });
        throw new UnrecoverableError(`FcmPushAdapter: invalid token (${code})`);
      }
      if (code && TRANSIENT_CODES.has(code)) {
        throw new Error(`FcmPushAdapter: ${code}`);
      }
      throw new UnrecoverableError(
        `FcmPushAdapter: ${code ?? (error as Error).message}`,
      );
    }
  }
}
