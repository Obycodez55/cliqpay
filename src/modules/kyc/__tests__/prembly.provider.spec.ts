import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { AppConfig } from '../../../config';
import { identitiesMatch } from '../internal/identity-match';
import { KycLivenessUnavailableException } from '../internal/errors';
import {
  parseBvnDate,
  parseNinDate,
  PremblyKycProvider,
} from '../providers/prembly.provider';

const FIXTURES = join(__dirname, '../../../../test/fixtures/prembly');
const SECRET_KEY = 'prembly-test-secret-key';
const PHOTO_MARKER = 'PHOTO-BYTES-MARKER';
const DETAIL_MARKER = 'FREE-TEXT-DETAIL-MARKER';

interface Fixture {
  httpStatus: number;
  responseBody: Record<string, unknown>;
}

function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${name}.json`), 'utf8'),
  ) as Fixture;
}

function synthetic(name: string): Fixture {
  return fixture(`synthetic/docs-only.${name}`);
}

function buildConfig(env: 'test' | 'production' = 'test'): AppConfig {
  return {
    app: { env },
    kyc: { prembly: { secretKey: SECRET_KEY } },
  } as AppConfig;
}

function respond(httpStatus: number, body: unknown) {
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    json: () => Promise.resolve(body),
  };
}

function respondWith({ httpStatus, responseBody }: Fixture) {
  return respond(httpStatus, responseBody);
}

function withData(source: Fixture, data: Record<string, unknown>): Fixture {
  return {
    ...source,
    responseBody: {
      ...source.responseBody,
      is_sandbox: false,
      data,
    },
  };
}

describe('PremblyKycProvider', () => {
  const fetchMock = jest.fn();
  const logged: unknown[][] = [];
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    logged.length = 0;
    for (const level of ['log', 'debug', 'warn', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => void logged.push(args));
    }
    loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => void logged.push(args));
  });

  afterEach(() => jest.restoreAllMocks());

  const provider = () => new PremblyKycProvider(buildConfig());

  describe('request', () => {
    it('posts the BVN to bvn_validation with the key header and a string body', async () => {
      fetchMock.mockResolvedValue(
        respondWith(fixture('bvn_validation.magic_nines')),
      );

      await provider().verifyBvn('22222222222');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.prembly.com/verification/bvn_validation');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ 'x-api-key': SECRET_KEY });
      expect(JSON.parse(init.body as string)).toEqual({
        number: '22222222222',
      });
    });

    it('posts the NIN to vnin-basic', async () => {
      fetchMock.mockResolvedValue(
        respondWith(fixture('vnin_basic.number_12345678909')),
      );

      await provider().verifyNin('12345678909');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.prembly.com/verification/vnin-basic');
      expect(JSON.parse(init.body as string)).toEqual({
        number: '12345678909',
      });
    });
  });

  describe('normalisation (recorded sandbox responses)', () => {
    it('maps a BVN lookup to name and ISO date of birth, with no address', async () => {
      fetchMock.mockResolvedValue(
        respondWith(fixture('bvn_validation.magic_nines')),
      );

      await expect(provider().verifyBvn('99999999999')).resolves.toEqual({
        status: 'verified',
        legalName: 'John Doe Jane',
        dateOfBirth: '2000-01-01',
        address: undefined,
      });
    });

    it('maps a NIN lookup to name, ISO date of birth and the residence address', async () => {
      fetchMock.mockResolvedValue(
        respondWith(fixture('vnin_basic.number_12345678909')),
      );

      await expect(provider().verifyNin('12345678909')).resolves.toEqual({
        status: 'verified',
        legalName: 'GRACE CHIMAMANDA AMANDA',
        dateOfBirth: '1999-05-23',
        address: {
          street: 'MASKED ADDRESS',
          town: '',
          lga: '',
          state: '',
        },
      });
    });

    it('leaves the date of birth undefined when it cannot be parsed', async () => {
      const source = fixture('bvn_validation.magic_nines');
      fetchMock.mockResolvedValue(
        respondWith(
          withData(source, {
            firstName: 'Ada',
            lastName: 'Obi',
            dateOfBirth: '2000-01-01',
          }),
        ),
      );

      await expect(provider().verifyBvn('22222222222')).resolves.toMatchObject({
        status: 'verified',
        legalName: 'Ada Obi',
        dateOfBirth: undefined,
      });
    });

    it('skips empty name parts', async () => {
      fetchMock.mockResolvedValue(
        respondWith(
          withData(fixture('vnin_basic.number_12345678909'), {
            firstname: 'ADA',
            middlename: '  ',
            surname: 'OBI',
            birthdate: '22-05-1998',
          }),
        ),
      );

      await expect(provider().verifyNin('12345678909')).resolves.toMatchObject({
        legalName: 'ADA OBI',
        address: undefined,
      });
    });
  });

  describe('same-person check across the two lookups', () => {
    async function lookups(bvnData: object, ninData: object) {
      fetchMock
        .mockResolvedValueOnce(
          respondWith(
            withData(
              fixture('bvn_validation.magic_nines'),
              bvnData as Record<string, unknown>,
            ),
          ),
        )
        .mockResolvedValueOnce(
          respondWith(
            withData(
              fixture('vnin_basic.number_12345678909'),
              ninData as Record<string, unknown>,
            ),
          ),
        );
      const prembly = provider();
      return [
        await prembly.verifyBvn('22222222222'),
        await prembly.verifyNin('33333333333'),
      ] as const;
    }

    const bvnPerson = {
      firstName: 'Ada',
      middleName: 'Obi',
      lastName: 'Lovelace',
      dateOfBirth: '11-May-2004',
    };

    it('matches a BVN and a NIN of the same person in their different shapes and date formats', async () => {
      const [bvn, nin] = await lookups(bvnPerson, {
        firstname: 'ADA',
        middlename: '',
        surname: 'LOVELACE',
        birthdate: '11-05-2004',
      });

      expect(bvn.dateOfBirth).toBe('2004-05-11');
      expect(nin.dateOfBirth).toBe('2004-05-11');
      expect(identitiesMatch(bvn, nin)).toBe(true);
    });

    it('does not match when only the date of birth differs', async () => {
      const [bvn, nin] = await lookups(bvnPerson, {
        firstname: 'ADA',
        middlename: 'OBI',
        surname: 'LOVELACE',
        birthdate: '12-05-2004',
      });

      expect(identitiesMatch(bvn, nin)).toBe(false);
    });

    it('does not match different people', async () => {
      const [bvn, nin] = await lookups(bvnPerson, {
        firstname: 'GRACE',
        middlename: 'CHIMAMANDA',
        surname: 'AMANDA',
        birthdate: '11-05-2004',
      });

      expect(identitiesMatch(bvn, nin)).toBe(false);
    });
  });

  describe('result mapping', () => {
    it.each([
      ['01 not found', 'not_found', { status: 'not_found' }],
      ['07 blocked BVN', 'blocked_bvn', { status: 'mismatch' }],
      [
        'an HTTP 404 that carries code 01 (code outranks status)',
        'not_found_http404',
        { status: 'not_found' },
      ],
    ])('%s', async (_label, name, expected) => {
      fetchMock.mockResolvedValue(respondWith(synthetic(name)));

      await expect(provider().verifyBvn('22222222222')).resolves.toEqual(
        expected,
      );
    });

    it('treats 07 as a verdict on NIN lookups as well', async () => {
      fetchMock.mockResolvedValue(respondWith(synthetic('blocked_bvn')));

      await expect(provider().verifyNin('22222222222')).resolves.toEqual({
        status: 'mismatch',
      });
    });

    it.each([
      ['02 service unavailable', respondWith(synthetic('service_unavailable'))],
      ['03 insufficient wallet', respondWith(synthetic('insufficient_wallet'))],
      ['HTTP 429', respondWith(synthetic('rate_limited'))],
      ['HTTP 401 (recorded)', respondWith(fixture('auth.bad_key'))],
      ['HTTP 403', respond(403, { status: false, message: 'Forbidden' })],
      ['HTTP 408', respond(408, { status: false, message: 'Timeout' })],
      ['HTTP 500', respond(500, { status: false, message: 'Error' })],
      ['HTTP 502', respond(502, { detail: 'Bad gateway' })],
      ['HTTP 503', respond(503, {})],
      [
        'an unexpected HTTP 400 (recorded)',
        respondWith(fixture('bvn_validation.malformed_short')),
      ],
      [
        'an unrecognised result code on HTTP 200',
        respond(200, { status: false, response_code: '04', data: {} }),
      ],
      [
        'an unrecognised code on an otherwise successful body',
        respond(200, {
          status: true,
          response_code: '04',
          verification: { status: 'VERIFIED' },
          data: {},
        }),
      ],
      [
        'a success body that arrives with a non-200 status',
        respond(502, {
          status: true,
          response_code: '00',
          verification: { status: 'VERIFIED' },
          data: {},
        }),
      ],
      [
        'response_code 00 without a VERIFIED verification',
        respond(200, {
          status: true,
          response_code: '00',
          verification: { status: 'PENDING' },
          data: {},
        }),
      ],
      [
        'status false with response_code 00',
        respond(200, {
          status: false,
          response_code: '00',
          verification: { status: 'VERIFIED' },
          data: {},
        }),
      ],
    ])('throws on %s, never a user verdict', async (_label, response) => {
      fetchMock.mockResolvedValue(response);

      await expect(provider().verifyBvn('22222222222')).rejects.toThrow(
        'lookup unavailable',
      );
    });

    it('throws on a transport failure', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(provider().verifyNin('12345678909')).rejects.toThrow(
        'network error',
      );
    });

    it('logs a distinct error when the Prembly wallet is empty', async () => {
      fetchMock.mockResolvedValue(
        respondWith(synthetic('insufficient_wallet')),
      );

      await expect(provider().verifyBvn('22222222222')).rejects.toThrow();

      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('wallet is out of funds'),
      );
    });

    it('does not log a wallet error for other infrastructure failures', async () => {
      fetchMock.mockResolvedValue(respondWith(synthetic('rate_limited')));

      await expect(provider().verifyBvn('22222222222')).rejects.toThrow();

      expect(loggerError).not.toHaveBeenCalled();
    });
  });

  describe('sandbox guard', () => {
    it('refuses a sandbox response in production and logs an error', async () => {
      fetchMock.mockResolvedValue(
        respondWith(fixture('bvn_validation.magic_nines')),
      );

      await expect(
        new PremblyKycProvider(buildConfig('production')).verifyBvn(
          '22222222222',
        ),
      ).rejects.toThrow('sandbox response refused in production');
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining('sandbox'),
      );
    });

    it('refuses a sandbox response in production even for a user-level verdict code', async () => {
      const notFound = synthetic('not_found');
      fetchMock.mockResolvedValue(
        respondWith({
          ...notFound,
          responseBody: { ...notFound.responseBody, is_sandbox: true },
        }),
      );

      await expect(
        new PremblyKycProvider(buildConfig('production')).verifyBvn(
          '22222222222',
        ),
      ).rejects.toThrow('sandbox response refused');
    });

    it('accepts a sandbox response outside production', async () => {
      fetchMock.mockResolvedValue(
        respondWith(fixture('bvn_validation.magic_nines')),
      );

      await expect(provider().verifyBvn('22222222222')).resolves.toMatchObject({
        status: 'verified',
      });
    });

    it('accepts a live response in production', async () => {
      fetchMock.mockResolvedValue(
        respondWith(
          withData(fixture('bvn_validation.magic_nines'), {
            firstName: 'Ada',
            lastName: 'Obi',
            dateOfBirth: '11-May-2004',
          }),
        ),
      );

      await expect(
        new PremblyKycProvider(buildConfig('production')).verifyBvn(
          '22222222222',
        ),
      ).resolves.toMatchObject({ status: 'verified', legalName: 'Ada Obi' });
    });
  });

  describe('response bodies never leave the adapter', () => {
    const photo = `data:image/jpeg;base64,${PHOTO_MARKER}${'A'.repeat(200_000)}`;

    function ninWithPhoto(): Fixture {
      const source = fixture('vnin_basic.number_12345678909');
      return {
        ...source,
        responseBody: {
          ...source.responseBody,
          detail: DETAIL_MARKER,
          data: {
            ...(source.responseBody.data as object),
            photo,
          },
        },
      };
    }

    function everythingObservable(): string {
      return JSON.stringify(logged);
    }

    it('discards the photo from a successful NIN result and logs nothing containing it', async () => {
      fetchMock.mockResolvedValue(respondWith(ninWithPhoto()));

      const result = await provider().verifyNin('12345678909');

      expect(JSON.stringify(result)).not.toContain(PHOTO_MARKER);
      expect(Object.keys(result).sort()).toEqual([
        'address',
        'dateOfBirth',
        'legalName',
        'status',
      ]);
      expect(everythingObservable()).not.toContain(PHOTO_MARKER);
      expect(everythingObservable()).not.toContain(DETAIL_MARKER);
    });

    it.each([
      ['an unexpected result code', { response_code: '04', status: false }],
      ['an empty wallet', { response_code: '03', status: false }],
      ['a failed verification', { verification: { status: 'NOT-VERIFIED' } }],
    ])(
      'puts no response body in the error or logs for %s',
      async (_label, override) => {
        const source = ninWithPhoto();
        fetchMock.mockResolvedValue(
          respondWith({
            ...source,
            responseBody: { ...source.responseBody, ...override },
          }),
        );

        const error = await provider()
          .verifyNin('12345678909')
          .then(
            () => new Error('expected a rejection'),
            (e: Error) => e,
          );

        expect(error.message).toContain('lookup unavailable');
        for (const observable of [
          error.message,
          String(error.stack),
          everythingObservable(),
        ]) {
          expect(observable).not.toContain(PHOTO_MARKER);
          expect(observable).not.toContain(DETAIL_MARKER);
        }
      },
    );

    it('keeps the secret key and the ID number out of logs', async () => {
      fetchMock.mockResolvedValue(respondWith(ninWithPhoto()));

      await provider().verifyNin('12345678909');

      expect(everythingObservable()).not.toContain(SECRET_KEY);
      expect(everythingObservable()).not.toContain('12345678909');
    });
  });

  describe('liveness', () => {
    it('is unavailable until a liveness provider exists', async () => {
      const prembly = provider();

      await expect(prembly.submitLiveness()).rejects.toBeInstanceOf(
        KycLivenessUnavailableException,
      );
      await expect(prembly.getLivenessResult()).rejects.toBeInstanceOf(
        KycLivenessUnavailableException,
      );
      expect(() => prembly.parseWebhookJobId()).toThrow(
        KycLivenessUnavailableException,
      );
    });

    it('is a 503 with the LIVENESS_UNAVAILABLE code', () => {
      const error = new KycLivenessUnavailableException();

      expect(error.code).toBe('LIVENESS_UNAVAILABLE');
      expect(error.getStatus()).toBe(503);
    });
  });
});

describe('date of birth parsing', () => {
  it.each([
    ['11-May-2004', '2004-05-11'],
    ['01-Jan-2000', '2000-01-01'],
    ['29-Feb-2004', '2004-02-29'],
    ['05-DEC-1990', '1990-12-05'],
    ['31-dec-1999', '1999-12-31'],
  ])('reads the BVN format %s', (raw, iso) => {
    expect(parseBvnDate(raw)).toBe(iso);
  });

  it.each([
    ['22-05-1998', '1998-05-22'],
    ['23-05-1999', '1999-05-23'],
    ['29-02-2004', '2004-02-29'],
    ['01-01-1990', '1990-01-01'],
  ])('reads the NIN format %s', (raw, iso) => {
    expect(parseNinDate(raw)).toBe(iso);
  });

  it.each([
    '',
    'garbage',
    '2004-05-11',
    '11/05/2004',
    '11-May-04',
    '11-Foo-2004',
    '31-Feb-2004',
    '29-Feb-2001',
    '00-Jan-2000',
    '32-Jan-2000',
    '11-05-2004',
  ])('does not guess a BVN date from %j', (raw) => {
    expect(parseBvnDate(raw)).toBeUndefined();
  });

  it.each([
    '',
    'garbage',
    '1998-05-22',
    '22/05/1998',
    '22-05-98',
    '31-02-2004',
    '29-02-2001',
    '22-13-1998',
    '00-05-1998',
    '22-May-1998',
  ])('does not guess a NIN date from %j', (raw) => {
    expect(parseNinDate(raw)).toBeUndefined();
  });

  it('does not read an ambiguous NIN date in the other order', () => {
    expect(parseNinDate('05-22-1998')).toBeUndefined();
  });
});
