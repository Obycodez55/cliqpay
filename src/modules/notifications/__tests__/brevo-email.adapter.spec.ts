import { UnrecoverableError } from 'bullmq';

const sendTransacEmail = jest.fn();

jest.mock('@getbrevo/brevo', () => {
  const actual =
    jest.requireActual<typeof import('@getbrevo/brevo')>('@getbrevo/brevo');
  return {
    ...actual,
    BrevoClient: jest.fn().mockImplementation(() => ({
      transactionalEmails: { sendTransacEmail },
    })),
  };
});

import { BrevoEmailAdapter } from '../channels/email/brevo-email.adapter';
import { BrevoError, BrevoTimeoutError } from '@getbrevo/brevo';
import { AppConfig } from '../../../config';

function buildConfig(): AppConfig {
  return {
    notifications: {
      brevo: {
        apiKey: 'test-key',
        senderEmail: 'noreply@cliqpay.africa',
        senderName: 'Cliqpay',
      },
    },
  } as AppConfig;
}

const message = {
  to: 'user@example.com',
  subject: 'Hello',
  html: '<p>hi</p>',
  text: 'hi',
};

describe('BrevoEmailAdapter', () => {
  beforeEach(() => {
    sendTransacEmail.mockReset();
  });

  it('sends without error on success', async () => {
    sendTransacEmail.mockResolvedValue({ messageId: '1' });
    const adapter = new BrevoEmailAdapter(buildConfig());
    await expect(adapter.send(message)).resolves.toBeUndefined();
    expect(sendTransacEmail).toHaveBeenCalled();
  });

  it('throws a plain (retryable) Error for a 5xx response', async () => {
    sendTransacEmail.mockRejectedValue(
      new BrevoError({ message: 'server error', statusCode: 503 }),
    );
    const adapter = new BrevoEmailAdapter(buildConfig());
    let caught: unknown;
    try {
      await adapter.send(message);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError for a 400 response (malformed recipient)', async () => {
    sendTransacEmail.mockRejectedValue(
      new BrevoError({ message: 'invalid recipient', statusCode: 400 }),
    );
    const adapter = new BrevoEmailAdapter(buildConfig());
    await expect(adapter.send(message)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('throws a plain (retryable) Error on timeout', async () => {
    sendTransacEmail.mockRejectedValue(new BrevoTimeoutError('timed out'));
    const adapter = new BrevoEmailAdapter(buildConfig());
    let caught: unknown;
    try {
      await adapter.send(message);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnrecoverableError);
  });
});
