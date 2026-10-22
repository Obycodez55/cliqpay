import { SmileIdKycProvider } from '../providers/smile-id.provider';
import { AppConfig } from '../../../config';

function buildConfig(): AppConfig {
  return {
    kyc: {
      smileId: {
        apiKey: 'test-api-key',
        partnerId: 'partner-1',
        baseUrl: 'https://smile.example.test',
        privacyPolicyUrl: 'https://cliqpay.example.test/privacy',
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

  it.each([400, 422])(
    'maps a %s rejection of the lookup itself to a mismatch',
    async (code) => {
      fetchMock.mockResolvedValue(
        jsonResponse(code, { ResultCode: '1012', ResultText: 'rejected' }),
      );
      const provider = new SmileIdKycProvider(buildConfig());

      await expect(provider.verifyBvn('22222222222')).resolves.toEqual({
        status: 'mismatch',
      });
    },
  );

  it('treats a 404 carrying result code 1013 as not_found, not an outage', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { ResultCode: '1013', ResultText: 'No Match' }),
    );
    const provider = new SmileIdKycProvider(buildConfig());

    await expect(provider.verifyBvn('22222222222')).resolves.toEqual({
      status: 'not_found',
    });
  });

  it.each([{}, { ResultCode: '9999' }])(
    'throws on a 404 without a recognised result code (%j)',
    async (body) => {
      fetchMock.mockResolvedValue(jsonResponse(404, body));
      const provider = new SmileIdKycProvider(buildConfig());

      await expect(provider.verifyBvn('22222222222')).rejects.toThrow(
        /lookup unavailable/,
      );
    },
  );

  it('never reads a 5xx as a verdict, even with result code 1013', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { ResultCode: '1013' }));
    const provider = new SmileIdKycProvider(buildConfig());

    await expect(provider.verifyBvn('22222222222')).rejects.toThrow(
      /lookup unavailable/,
    );
  });

  it.each([401, 403, 404, 408, 429, 500, 503])(
    'throws, rather than reporting a mismatch, on a %s response',
    async (code) => {
      fetchMock.mockResolvedValue(
        jsonResponse(code, { ResultCode: '1012', ResultText: 'whatever' }),
      );
      const provider = new SmileIdKycProvider(buildConfig());

      await expect(provider.verifyBvn('22222222222')).rejects.toThrow(
        /lookup unavailable/,
      );
    },
  );

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

  describe('liveness (Biometric KYC v3)', () => {
    const submission = {
      idType: 'bvn' as const,
      idNumber: '22222222222',
      selfieImage: '/9j/AA==',
      livenessImages: Array<string>(6).fill('/9j/AA=='),
      user: {
        givenNames: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        phone: '+2348000000000',
      },
      consentGrantedAt: new Date('2026-01-01T00:00:00Z'),
    };

    it('fetches a token then posts the images as multipart and returns the pending job id', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { token: 'jwt-1' }))
        .mockResolvedValueOnce(
          jsonResponse(202, { status: 'accepted', job_id: 'job_abc' }),
        );
      const provider = new SmileIdKycProvider(buildConfig());

      await expect(provider.submitLiveness(submission)).resolves.toEqual({
        status: 'pending',
        jobId: 'job_abc',
      });

      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(tokenUrl).toBe('https://smile.example.test/v3/token');
      expect(tokenInit.headers).toEqual({
        partner_id: 'partner-1',
        api_key: 'test-api-key',
      });
      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(url).toBe('https://smile.example.test/v3/biometric_kyc');
      expect(init.headers).toEqual({ 'SmileID-Token': 'jwt-1' });
      const form = init.body as FormData;
      expect(form.getAll('liveness_images')).toHaveLength(6);
      expect(form.get('selfie_image')).toBeInstanceOf(Blob);
      expect(form.get('id_type')).toBe('BVN');
      expect(form.get('country')).toBe('NG');
      expect(JSON.parse(form.get('consent') as string)).toMatchObject({
        granted: true,
        notice_privacy_policy_url: 'https://cliqpay.example.test/privacy',
      });
    });

    it('reports a failed liveness when the job is rejected at submission', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { token: 'jwt-1' }))
        .mockResolvedValueOnce(jsonResponse(400, { message: 'bad' }));
      const provider = new SmileIdKycProvider(buildConfig());

      await expect(provider.submitLiveness(submission)).resolves.toEqual({
        status: 'failed',
      });
    });

    it('throws when the token response carries no token', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
      const provider = new SmileIdKycProvider(buildConfig());

      await expect(provider.submitLiveness(submission)).rejects.toThrow(
        /token/,
      );
    });

    it.each([
      ['processing', 'pending'],
      ['clear', 'passed'],
      ['block', 'failed'],
      ['attention', 'failed'],
    ])('maps a %s job status to %s', async (status, expected) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { token: 'jwt-1' }))
        .mockResolvedValueOnce(jsonResponse(200, { status }));
      const provider = new SmileIdKycProvider(buildConfig());

      await expect(provider.getLivenessResult('job_abc')).resolves.toBe(
        expected,
      );
      expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
        'https://smile.example.test/v3/status/job_abc',
      );
    });

    it.each(['error', 'not_found', 'something_new'])(
      'rejects, rather than failing the job, on a %s job status',
      async (status) => {
        fetchMock
          .mockResolvedValueOnce(jsonResponse(200, { token: 'jwt-1' }))
          .mockResolvedValueOnce(jsonResponse(200, { status }));
        const provider = new SmileIdKycProvider(buildConfig());

        await expect(provider.getLivenessResult('job_abc')).rejects.toThrow(
          /unsettled job status/,
        );
      },
    );

    it('rejects when the status request is not OK, even with a JSON body', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { token: 'jwt-1' }))
        .mockResolvedValueOnce(jsonResponse(503, { status: 'clear' }));
      const provider = new SmileIdKycProvider(buildConfig());

      await expect(provider.getLivenessResult('job_abc')).rejects.toThrow(
        /unavailable \(503\)/,
      );
    });

    it.each([500, 503, 429, 401, 403, 404, 408])(
      'rejects on a %s response to the submission',
      async (code) => {
        fetchMock
          .mockResolvedValueOnce(jsonResponse(200, { token: 'jwt-1' }))
          .mockResolvedValueOnce(jsonResponse(code, { message: 'busy' }));
        const provider = new SmileIdKycProvider(buildConfig());

        await expect(provider.submitLiveness(submission)).rejects.toThrow(
          /unavailable/,
        );
      },
    );

    it.each([400, 422])(
      'reports a failed liveness when the submission is rejected with %s',
      async (code) => {
        fetchMock
          .mockResolvedValueOnce(jsonResponse(200, { token: 'jwt-1' }))
          .mockResolvedValueOnce(jsonResponse(code, { message: 'bad' }));
        const provider = new SmileIdKycProvider(buildConfig());

        await expect(provider.submitLiveness(submission)).resolves.toEqual({
          status: 'failed',
        });
      },
    );

    it('rejects when an accepted submission carries no job id', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { token: 'jwt-1' }))
        .mockResolvedValueOnce(jsonResponse(202, { status: 'accepted' }));
      const provider = new SmileIdKycProvider(buildConfig());

      await expect(provider.submitLiveness(submission)).rejects.toThrow(
        /no job id/,
      );
    });

    it('reads the job id from a webhook body and ignores anything else', () => {
      const provider = new SmileIdKycProvider(buildConfig());

      expect(
        provider.parseWebhookJobId({ partner_params: { job_id: 'job_abc' } }),
      ).toBe('job_abc');
      expect(provider.parseWebhookJobId({ partner_params: {} })).toBeNull();
      expect(provider.parseWebhookJobId(null)).toBeNull();
    });
  });
});
