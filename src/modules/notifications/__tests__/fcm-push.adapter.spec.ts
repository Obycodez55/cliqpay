import { UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';

const sendMock = jest.fn();

jest.mock('firebase-admin/app', () => ({
  getApps: jest.fn(() => [{}]),
  initializeApp: jest.fn(() => ({})),
  cert: jest.fn(),
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: sendMock })),
}));

import { FcmPushAdapter } from '../channels/push/fcm-push.adapter';
import { AppConfig } from '../../../config';
import { PushToken } from '../entities/push-token.entity';

function buildConfig(): AppConfig {
  return {
    notifications: {
      firebase: {
        projectId: 'test-project',
        clientEmail: 'sdk@test-project.iam.gserviceaccount.com',
        privateKey: 'fake-key',
      },
    },
  } as AppConfig;
}

const message = { token: 'device-token', title: 'Hi', body: 'there' };

describe('FcmPushAdapter', () => {
  let pushTokens: jest.Mocked<Pick<Repository<PushToken>, 'delete'>>;

  beforeEach(() => {
    sendMock.mockReset();
    pushTokens = { delete: jest.fn() };
  });

  it('sends without error on success', async () => {
    sendMock.mockResolvedValue('message-id');
    const adapter = new FcmPushAdapter(
      buildConfig(),
      pushTokens as unknown as Repository<PushToken>,
    );
    await expect(adapter.send(message)).resolves.toBeUndefined();
  });

  it('deletes the push_tokens row and throws UnrecoverableError when FCM reports the token unregistered', async () => {
    sendMock.mockRejectedValue({
      code: 'messaging/registration-token-not-registered',
    });
    const adapter = new FcmPushAdapter(
      buildConfig(),
      pushTokens as unknown as Repository<PushToken>,
    );
    await expect(adapter.send(message)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(pushTokens.delete).toHaveBeenCalledWith({
      token: message.token,
    });
  });

  it('throws a plain (retryable) Error for a transient FCM error without deleting the token', async () => {
    sendMock.mockRejectedValue({ code: 'messaging/internal-error' });
    const adapter = new FcmPushAdapter(
      buildConfig(),
      pushTokens as unknown as Repository<PushToken>,
    );
    let caught: unknown;
    try {
      await adapter.send(message);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnrecoverableError);
    expect(pushTokens.delete).not.toHaveBeenCalled();
  });
});
