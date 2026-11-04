import { readFileSync } from 'fs';
import { join } from 'path';
import { AppConfig } from '../../src/config';
import { PremblyKycProvider } from '../../src/modules/kyc/providers/prembly.provider';

const BASE_URL = 'https://api.prembly.com';
const SECRET_KEY = process.env.PREMBLY_SECRET_KEY;
const FIXTURES = join(__dirname, '../fixtures/prembly');

interface Fixture {
  request: { path: string; body: unknown };
  httpStatus: number;
  responseBody: unknown;
}

function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${name}.json`), 'utf8'),
  ) as Fixture;
}

// Every key and every value type must agree; values are not compared because
// the sandbox returns fixed canned data and the fixtures are sanitized.
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(shapeOf);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, shapeOf(inner)]),
    );
  }
  return value === null ? 'null' : typeof value;
}

async function post(path: string, body: unknown, apiKey: string) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as unknown,
  };
}

// Prembly's sandbox returns one canned success for every well-formed request,
// so only shapes are checked here. Not-found (01), blocked BVN (07), service
// unavailable (02), empty wallet (03) and rate limiting (429) cannot be
// triggered in the sandbox; those paths are covered by the synthetic fixtures
// in the unit spec and must be re-confirmed by hand against the live service.
(SECRET_KEY ? describe : describe.skip)('Prembly sandbox contract', () => {
  it.each([
    ['bvn_validation.magic_nines', SECRET_KEY!],
    ['vnin_basic.number_12345678909', SECRET_KEY!],
    ['bvn_validation.malformed_short', SECRET_KEY!],
    ['auth.bad_key', 'invalid-contract-test-key'],
  ])('%s keeps its recorded shape', async (name, apiKey) => {
    const recorded = fixture(name);

    const live = await post(
      recorded.request.path,
      recorded.request.body,
      apiKey,
    );

    expect(live.status).toBe(recorded.httpStatus);
    const liveShape = shapeOf(live.body) as Record<string, unknown>;
    const recordedShape = shapeOf(recorded.responseBody) as Record<
      string,
      unknown
    >;
    expect(liveShape).toEqual(recordedShape);
  });

  describe('PremblyKycProvider against the sandbox', () => {
    const provider = new PremblyKycProvider({
      app: { env: 'test' },
      kyc: { prembly: { secretKey: SECRET_KEY } },
    } as AppConfig);

    it('verifies a BVN into a name and an ISO date of birth', async () => {
      const result = await provider.verifyBvn('54651333604');

      expect(result.status).toBe('verified');
      expect(result.legalName).toBeTruthy();
      expect(result.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('verifies a NIN into a name, an ISO date of birth and an address', async () => {
      const result = await provider.verifyNin('12345678909');

      expect(result.status).toBe('verified');
      expect(result.legalName).toBeTruthy();
      expect(result.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.address?.street).toBeTruthy();
    });
  });
});
