import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../config';
import { requestJson } from '../../../shared/http/request-json';
import { KycLivenessUnavailableException } from '../internal/errors';
import {
  KycProvider,
  KycVerificationResult,
  LivenessOutcome,
  LivenessSubmissionResult,
} from './kyc-provider.interface';

const PREMBLY_BASE_URL = 'https://api.prembly.com';
const PREMBLY_TIMEOUT_MS = 15_000;

const RESULT_OK = '00';
const RESULT_NOT_FOUND = '01';
const RESULT_BLOCKED = '07';
const RESULT_WALLET_EMPTY = '03';

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

interface PremblyEnvelope {
  status?: unknown;
  response_code?: unknown;
  verification?: { status?: unknown };
  is_sandbox?: unknown;
  data?: unknown;
}

type IdentityData = Record<string, unknown>;

interface LookupSpec {
  path: string;
  names: [first: string, middle: string, last: string];
  dateOfBirth: string;
  parseDate: (raw: string) => string | undefined;
  address?: string;
}

const BVN_SPEC: LookupSpec = {
  path: '/verification/bvn_validation',
  names: ['firstName', 'middleName', 'lastName'],
  dateOfBirth: 'dateOfBirth',
  parseDate: parseBvnDate,
};

const NIN_SPEC: LookupSpec = {
  path: '/verification/vnin-basic',
  names: ['firstname', 'middlename', 'surname'],
  dateOfBirth: 'birthdate',
  parseDate: parseNinDate,
  address: 'residence_address',
};

@Injectable()
export class PremblyKycProvider implements KycProvider {
  private readonly logger = new Logger(PremblyKycProvider.name);
  private readonly secretKey: string;
  private readonly production: boolean;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.secretKey = config.kyc.prembly.secretKey!;
    this.production = config.app.env === 'production';
  }

  verifyBvn(bvn: string): Promise<KycVerificationResult> {
    return this.lookup(BVN_SPEC, bvn);
  }

  readonly supportsLiveness = false;

  verifyNin(nin: string): Promise<KycVerificationResult> {
    return this.lookup(NIN_SPEC, nin);
  }

  submitLiveness(): Promise<LivenessSubmissionResult> {
    return Promise.reject(new KycLivenessUnavailableException());
  }

  getLivenessResult(): Promise<LivenessOutcome | 'pending'> {
    return Promise.reject(new KycLivenessUnavailableException());
  }

  parseWebhookJobId(): string | null {
    throw new KycLivenessUnavailableException();
  }

  // Neither the response body nor Prembly's free-text message is ever logged
  // or put in an error: a NIN response carries the person's photo.
  private async lookup(
    spec: LookupSpec,
    idNumber: string,
  ): Promise<KycVerificationResult> {
    const { status: httpStatus, body } = await requestJson<PremblyEnvelope>({
      provider: PremblyKycProvider.name,
      url: `${PREMBLY_BASE_URL}${spec.path}`,
      method: 'POST',
      headers: { 'x-api-key': this.secretKey },
      body: { number: idNumber },
      timeoutMs: PREMBLY_TIMEOUT_MS,
    });

    if (this.production && body.is_sandbox === true) {
      this.logger.error(
        'Prembly answered from its sandbox while NODE_ENV=production; the key in use is a sandbox key',
      );
      throw new Error(
        'PremblyKycProvider: sandbox response refused in production',
      );
    }

    const code =
      typeof body.response_code === 'string' ? body.response_code : undefined;

    // A recognised result code outranks the HTTP status.
    if (code === RESULT_NOT_FOUND) {
      return { status: 'not_found' };
    }
    if (code === RESULT_BLOCKED) {
      return { status: 'mismatch' };
    }
    if (code === RESULT_WALLET_EMPTY) {
      this.logger.error(
        'Prembly wallet is out of funds (response_code 03): every BVN/NIN verification is failing until it is topped up',
      );
    }

    const data = body.data;
    if (
      httpStatus !== 200 ||
      body.status !== true ||
      code !== RESULT_OK ||
      body.verification?.status !== 'VERIFIED' ||
      data === null ||
      typeof data !== 'object'
    ) {
      throw new Error(
        `PremblyKycProvider: lookup unavailable (http ${httpStatus}, code ${code !== undefined && /^\d{1,3}$/.test(code) ? code : 'none'})`,
      );
    }

    return toResult(spec, data as IdentityData);
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toResult(spec: LookupSpec, data: IdentityData): KycVerificationResult {
  const legalName =
    spec.names
      .map((key) => text(data[key]))
      .filter((part) => part.length > 0)
      .join(' ') || undefined;
  const street = spec.address ? text(data[spec.address]) : '';

  return {
    status: 'verified',
    legalName,
    dateOfBirth: spec.parseDate(text(data[spec.dateOfBirth])),
    address: street ? { street, town: '', lga: '', state: '' } : undefined,
  };
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

// DD-Mon-YYYY, e.g. 11-May-2004.
export function parseBvnDate(raw: string): string | undefined {
  const parts = raw.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  const month = parts ? MONTHS.indexOf(parts[2].toLowerCase()) + 1 : 0;
  return parts && month > 0
    ? isoDate(Number(parts[3]), month, Number(parts[1]))
    : undefined;
}

// DD-MM-YYYY, e.g. 22-05-1998.
export function parseNinDate(raw: string): string | undefined {
  const parts = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return parts
    ? isoDate(Number(parts[3]), Number(parts[2]), Number(parts[1]))
    : undefined;
}
