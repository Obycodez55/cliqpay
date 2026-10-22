import { stripRequestBody } from '../sentry.service';

describe('stripRequestBody', () => {
  it('drops the request body but keeps the rest of the event', () => {
    const event = {
      request: { url: '/v1/kyc/verify-bvn', data: { liveness: 'selfie' } },
    };

    const scrubbed = stripRequestBody(event);

    expect(scrubbed.request).toEqual({ url: '/v1/kyc/verify-bvn' });
  });

  it('passes events without a request through unchanged', () => {
    expect(stripRequestBody({})).toEqual({});
  });
});
