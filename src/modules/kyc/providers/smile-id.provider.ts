import { createHmac } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../../../config';
import { requestJson } from '../../../shared/http/request-json';
import {
  KycProvider,
  KycVerificationResult,
  LivenessOutcome,
  LivenessSubmission,
  LivenessSubmissionResult,
} from './kyc-provider.interface';

const SMILE_ID_TIMEOUT_MS = 15_000;

// Request/response shapes and the signing scheme are unconfirmed against a live
// Smile ID sandbox; a contract test must verify them before real use. The NIN
// lookup is assumed to take id_type "NIN" and return the same response shape as BVN.
// For the v3 liveness path, unconfirmed: the /v3/token header names (partner_id,
// api_key), the multipart encoding of consent and user_details (JSON strings),
// and that the webhook's partner_params.job_id equals the submit response's job_id.
interface SmileIdEnhancedKycResponse {
  ResultCode: string;
  ResultText: string;
  FullName?: string;
  Address?: {
    AddressLine1?: string;
    City?: string;
    LGA?: string;
    State?: string;
  };
}

interface SmileIdJobStatusResponse {
  status:
    | 'clear'
    | 'attention'
    | 'block'
    | 'error'
    | 'processing'
    | 'not_found';
}

const SUBMISSION_INFRASTRUCTURE_STATUSES = new Set([401, 403, 404, 408, 429]);

const RESULT_CODE_MATCH = '1012';
const RESULT_CODE_NOT_FOUND = '1013';

@Injectable()
export class SmileIdKycProvider implements KycProvider {
  private readonly apiKey: string;
  private readonly partnerId: string;
  private readonly baseUrl: string;
  private readonly privacyPolicyUrl: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.apiKey = config.kyc.smileId.apiKey!;
    this.partnerId = config.kyc.smileId.partnerId!;
    this.baseUrl = config.kyc.smileId.baseUrl!;
    this.privacyPolicyUrl = config.kyc.smileId.privacyPolicyUrl!;
  }

  async verifyBvn(bvn: string): Promise<KycVerificationResult> {
    return this.verify('BVN', bvn);
  }

  async verifyNin(nin: string): Promise<KycVerificationResult> {
    return this.verify('NIN', nin);
  }

  private buildSignature(timestamp: string): string {
    return createHmac('sha256', this.apiKey)
      .update(timestamp + this.partnerId + 'sid_request')
      .digest('base64');
  }

  private async verify(
    idType: 'BVN' | 'NIN',
    idNumber: string,
  ): Promise<KycVerificationResult> {
    const timestamp = new Date().toISOString();

    const { ok, body } = await requestJson<SmileIdEnhancedKycResponse>({
      provider: 'SmileIdKycProvider',
      url: `${this.baseUrl}/v1/id_verification`,
      method: 'POST',
      body: {
        partner_id: this.partnerId,
        timestamp,
        signature: this.buildSignature(timestamp),
        country: 'NG',
        id_type: idType,
        id_number: idNumber,
        partner_params: {
          user_id: randomUUID(),
          job_id: randomUUID(),
          job_type: 5,
        },
      },
      timeoutMs: SMILE_ID_TIMEOUT_MS,
    });

    if (body.ResultCode === RESULT_CODE_NOT_FOUND) {
      return { status: 'not_found' };
    }
    if (!ok || body.ResultCode !== RESULT_CODE_MATCH) {
      // Any other result code is an expected lookup outcome, not a system failure.
      return { status: 'mismatch' };
    }

    return {
      status: 'verified',
      legalName: body.FullName,
      address: body.Address
        ? {
            street: body.Address.AddressLine1 ?? '',
            town: body.Address.City ?? '',
            lga: body.Address.LGA ?? '',
            state: body.Address.State ?? '',
          }
        : undefined,
    };
  }

  async submitLiveness(
    submission: LivenessSubmission,
  ): Promise<LivenessSubmissionResult> {
    const form = new FormData();
    form.append('selfie_image', jpegBlob(submission.selfieImage), 'selfie.jpg');
    for (const [index, image] of submission.livenessImages.entries()) {
      form.append('liveness_images', jpegBlob(image), `liveness-${index}.jpg`);
    }
    form.append('country', 'NG');
    form.append('id_type', submission.idType.toUpperCase());
    form.append('id_number', submission.idNumber);
    form.append(
      'user_details',
      JSON.stringify({
        given_names: submission.user.givenNames,
        last_name: submission.user.lastName,
        email: submission.user.email,
        phone_number: submission.user.phone,
      }),
    );
    form.append(
      'consent',
      JSON.stringify({
        granted: true,
        granted_at: submission.consentGrantedAt.toISOString(),
        notice_language: 'EN',
        notice_privacy_policy_url: this.privacyPolicyUrl,
      }),
    );

    const { ok, status, body } = await requestJson<{ job_id?: string }>({
      provider: 'SmileIdKycProvider',
      url: `${this.baseUrl}/v3/biometric_kyc`,
      method: 'POST',
      headers: { 'SmileID-Token': await this.fetchToken() },
      body: form,
      timeoutMs: SMILE_ID_TIMEOUT_MS,
    });
    // Our credentials, token or endpoint being wrong must not read as the
    // user failing liveness.
    if (status >= 500 || SUBMISSION_INFRASTRUCTURE_STATUSES.has(status)) {
      throw new Error(`SmileIdKycProvider: submission unavailable (${status})`);
    }
    if (!ok) {
      return { status: 'failed' };
    }
    if (!body.job_id) {
      throw new Error('SmileIdKycProvider: submission returned no job id');
    }
    return { status: 'pending', jobId: body.job_id };
  }

  // Only a definite verdict settles a job: anything else throws so the poll
  // retries on its next tick rather than recording a provider outage as a
  // failed liveness.
  async getLivenessResult(jobId: string): Promise<LivenessOutcome | 'pending'> {
    const { ok, status, body } = await requestJson<SmileIdJobStatusResponse>({
      provider: 'SmileIdKycProvider',
      url: `${this.baseUrl}/v3/status/${encodeURIComponent(jobId)}`,
      method: 'GET',
      headers: { 'SmileID-Token': await this.fetchToken() },
      timeoutMs: SMILE_ID_TIMEOUT_MS,
    });
    if (!ok) {
      throw new Error(`SmileIdKycProvider: job status unavailable (${status})`);
    }
    switch (body.status) {
      case 'processing':
        return 'pending';
      case 'clear':
        return 'passed';
      case 'block':
      case 'attention':
        return 'failed';
      default:
        throw new Error(
          `SmileIdKycProvider: unsettled job status "${String(body.status)}"`,
        );
    }
  }

  parseWebhookJobId(body: unknown): string | null {
    const jobId = (body as { partner_params?: { job_id?: unknown } } | null)
      ?.partner_params?.job_id;
    return typeof jobId === 'string' ? jobId : null;
  }

  private async fetchToken(): Promise<string> {
    const { body } = await requestJson<{ token?: string }>({
      provider: 'SmileIdKycProvider',
      url: `${this.baseUrl}/v3/token`,
      method: 'POST',
      headers: { partner_id: this.partnerId, api_key: this.apiKey },
      timeoutMs: SMILE_ID_TIMEOUT_MS,
    });
    if (!body.token) {
      throw new Error('SmileIdKycProvider: token request returned no token');
    }
    return body.token;
  }
}

function jpegBlob(base64: string): Blob {
  return new Blob([Buffer.from(base64, 'base64')], { type: 'image/jpeg' });
}
