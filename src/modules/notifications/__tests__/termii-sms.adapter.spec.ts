import { UnrecoverableError } from 'bullmq';
import { TermiiSmsAdapter } from '../channels/sms/termii-sms.adapter';
import { AppConfig } from '../../../config';

function buildConfig(): AppConfig {
  return {
    notifications: {
      termii: { apiKey: 'test-key', senderId: 'Cliqpay' },
    },
  } as AppConfig;
}

const message = { to: '+2348012345678', body: 'Your code is 123456' };

describe('TermiiSmsAdapter', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it('sends without error on a 200 response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    const adapter = new TermiiSmsAdapter(buildConfig());
    await expect(adapter.send(message)).resolves.toBeUndefined();
  });

  it('throws a plain (retryable) Error for a 5xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('service unavailable'),
    });
    const adapter = new TermiiSmsAdapter(buildConfig());
    let caught: unknown;
    try {
      await adapter.send(message);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError for a 400 response (invalid phone number)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('invalid phone number'),
    });
    const adapter = new TermiiSmsAdapter(buildConfig());
    await expect(adapter.send(message)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('throws a plain (retryable) Error on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const adapter = new TermiiSmsAdapter(buildConfig());
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
