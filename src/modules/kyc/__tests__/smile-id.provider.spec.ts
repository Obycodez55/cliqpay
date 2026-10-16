import { SmileIdKycProvider } from '../providers/smile-id.provider';
import { AppConfig } from '../../../config';

function buildConfig(): AppConfig {
  return {
    kyc: {
      smileId: {
        apiKey: 'test-api-key',
        partnerId: 'partner-1',
        baseUrl: 'https://smile.example.test',
      },
    },
  } as AppConfig;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

describe('SmileIdKycProvider', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it('maps a match response to a verified result', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ResultCode: '1012',
        ResultText: 'Exact Match',
        FullName: 'Jane Doe',
        Address: {
          AddressLine1: '1 Main St',
          City: 'Ikeja',
          LGA: 'Ikeja',
          State: 'Lagos',
        },
      }),
    );
    const provider = new SmileIdKycProvider(buildConfig());

    await expect(provider.verifyBvn('22222222222')).resolves.toEqual({
      status: 'verified',
      legalName: 'Jane Doe',
      address: {
        street: '1 Main St',
        town: 'Ikeja',
        lga: 'Ikeja',
        state: 'Lagos',
      },
      livenessPassed: undefined,
    });
  });

  it('maps result code 1013 to not_found', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ResultCode: '1013', ResultText: 'No Match' }),
    );
    const provider = new SmileIdKycProvider(buildConfig());

    await expect(provider.verifyBvn('22222222222')).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('maps any other result code to a mismatch, not a thrown error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ResultCode: '1014', ResultText: 'Mismatch' }),
    );
    const provider = new SmileIdKycProvider(buildConfig());

    await expect(provider.verifyBvn('22222222222')).resolves.toEqual({
      status: 'mismatch',
    });
  });

  it('maps a non-ok response with a parseable body to a mismatch', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { ResultCode: '1012', ResultText: 'bad request' }),
    );
    const provider = new SmileIdKycProvider(buildConfig());

    await expect(provider.verifyBvn('22222222222')).resolves.toEqual({
      status: 'mismatch',
    });
  });

  it('posts the signed request to the id_verification endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ResultCode: '1013' }));
    const provider = new SmileIdKycProvider(buildConfig());

    await provider.verifyBvn('22222222222');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://smile.example.test/v1/id_verification');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      partner_id: 'partner-1',
      country: 'NG',
      id_type: 'BVN',
      id_number: '22222222222',
    });
    expect(typeof sent.signature).toBe('string');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws a descriptive error on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const provider = new SmileIdKycProvider(buildConfig());

    await expect(provider.verifyBvn('22222222222')).rejects.toThrow(
      /SmileIdKycProvider: network error \(ECONNRESET\)/,
    );
  });

  it('throws, rather than reporting a mismatch, when the body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    });
    const provider = new SmileIdKycProvider(buildConfig());

    await expect(provider.verifyBvn('22222222222')).rejects.toThrow(
      /SmileIdKycProvider/,
    );
  });

  it('posts the NIN lookup with id_type NIN and maps a match to verified', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ResultCode: '1012',
        FullName: 'Jane Doe',
        Address: { AddressLine1: '1 Main St', City: 'Ikeja' },
      }),
    );
    const provider = new SmileIdKycProvider(buildConfig());

    await expect(provider.verifyNin('33333333333')).resolves.toMatchObject({
      status: 'verified',
      legalName: 'Jane Doe',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      id_type: 'NIN',
      id_number: '33333333333',
    });
  });
});
