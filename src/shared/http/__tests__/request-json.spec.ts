import { Logger } from '@nestjs/common';
import { ProviderHttpError, requestJson } from '../request-json';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const baseOptions = {
  provider: 'TestAdapter',
  url: 'https://api.example.test/v1/things?secret=abc',
  method: 'POST' as const,
  timeoutMs: 1000,
};

describe('requestJson', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  async function capture(
    promise: Promise<unknown>,
  ): Promise<ProviderHttpError> {
    try {
      await promise;
    } catch (error) {
      return error as ProviderHttpError;
    }
    throw new Error('expected requestJson to reject');
  }

  it('sends FormData as multipart without forcing a JSON content type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, { job_id: 'job_1' }));
    const form = new FormData();
    form.append('selfie_image', new Blob(['x']), 'selfie.jpg');

    await requestJson({ ...baseOptions, body: form });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(form);
    expect(init.headers).toBeUndefined();
  });

  it('returns status, ok and the parsed body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: true }));

    await expect(requestJson(baseOptions)).resolves.toEqual({
      status: 200,
      ok: true,
      body: { status: true },
    });
  });

  it('returns a non-2xx response instead of throwing', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { message: 'conflict' }));

    await expect(requestJson(baseOptions)).resolves.toEqual({
      status: 409,
      ok: false,
      body: { message: 'conflict' },
    });
  });

  it('sends a JSON body with a Content-Type header and a timeout signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await requestJson({
      ...baseOptions,
      headers: { Authorization: 'Bearer x' },
      body: { a: 1 },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(baseOptions.url);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer x',
      'Content-Type': 'application/json',
    });
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits body and Content-Type when no body is given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));

    await requestJson({
      ...baseOptions,
      method: 'GET',
      headers: { Authorization: 'Bearer x' },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: 'Bearer x' });
  });

  it('wraps a fetch rejection as a network error with the adapter-style message', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const error = await capture(requestJson(baseOptions));

    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error.kind).toBe('network');
    expect(error.message).toBe('TestAdapter: network error (ECONNRESET)');
  });

  it('classifies a TimeoutError as a timeout', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    const error = await capture(requestJson(baseOptions));

    expect(error.kind).toBe('timeout');
    expect(error.message).toMatch(/^TestAdapter: network error \(/);
  });

  it('classifies a non-JSON body as invalid_body and keeps the status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    });

    const error = await capture(requestJson(baseOptions));

    expect(error.kind).toBe('invalid_body');
    expect(error.status).toBe(502);
    expect(error.message).toBe('TestAdapter: invalid response body (502)');
  });

  it('classifies a failure while reading the body as a network error', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new TypeError('terminated')),
    });

    const error = await capture(requestJson(baseOptions));

    expect(error.kind).toBe('network');
    expect(error.status).toBe(200);
  });

  it.each([null, 'text', 42, true])(
    'rejects a JSON body that is not an object (%p)',
    async (body) => {
      fetchMock.mockResolvedValue(jsonResponse(200, body));

      const error = await capture(requestJson(baseOptions));

      expect(error.kind).toBe('invalid_body');
    },
  );

  describe('logging', () => {
    it('logs host and path only — never the query, headers or bodies', async () => {
      const debug = jest
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => undefined);
      fetchMock.mockResolvedValue(
        jsonResponse(200, { account_number: '0123456789' }),
      );

      await requestJson({
        ...baseOptions,
        headers: { Authorization: 'Bearer sk_live_secret' },
        body: { bvn: '22222222222' },
      });

      const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('api.example.test/v1/things');
      expect(logged).not.toMatch(/secret|sk_live|22222222222|0123456789/);
      debug.mockRestore();
    });

    it('does not log the error cause message on failure', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      fetchMock.mockRejectedValue(new Error('boom sk_live_secret'));

      await capture(requestJson(baseOptions));

      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('network');
      expect(logged).not.toContain('sk_live_secret');
      warn.mockRestore();
    });
  });
});
