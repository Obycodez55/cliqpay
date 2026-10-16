import { createHmac } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../../../config';
import { requestJson } from '../../../shared/http/request-json';
import {
  KycProvider,
  KycVerificationResult,
  KycVerifyOptions,
} from './kyc-provider.interface';

const SMILE_ID_TIMEOUT_MS = 15_000;

// Request/response shapes and the signing scheme are unconfirmed against a live
// Smile ID sandbox; a contract test must verify them before real use.
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
  Actions?: {
    LivenessCheck?: string; // assumed "Passed" | "Failed" | "Not Applicable"
  };
}

const RESULT_CODE_MATCH = '1012';
const RESULT_CODE_NOT_FOUND = '1013';

@Injectable()
export class SmileIdKycProvider implements KycProvider {
  private readonly apiKey: string;
  private readonly partnerId: string;
  private readonly baseUrl: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.apiKey = config.kyc.smileId.apiKey!;
    this.partnerId = config.kyc.smileId.partnerId!;
    this.baseUrl = config.kyc.smileId.baseUrl!;
  }

  async verifyBvn(
    bvn: string,
    options?: KycVerifyOptions,
  ): Promise<KycVerificationResult> {
    return this.verify('BVN', bvn, options);
  }

  verifyNin(): Promise<KycVerificationResult> {
    return Promise.reject(
      new Error('SmileIdKycProvider.verifyNin: not implemented'),
    );
  }

  private buildSignature(timestamp: string): string {
    return createHmac('sha256', this.apiKey)
      .update(timestamp + this.partnerId + 'sid_request')
      .digest('base64');
  }

  private async verify(
    idType: 'BVN' | 'NIN',
    idNumber: string,
    options?: KycVerifyOptions,
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
        image: options?.selfie,
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
      livenessPassed: options?.selfie
        ? body.Actions?.LivenessCheck === 'Passed'
        : undefined,
    };
  }
}
