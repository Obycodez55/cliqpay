import { Injectable } from '@nestjs/common';
import {
  KycProvider,
  KycVerificationResult,
  KycVerifyOptions,
} from './kyc-provider.interface';

// BVNs are digits-only, so sentinels are prefixes: "0000" is not_found, "1111" is mismatch.
@Injectable()
export class FakeKycProvider implements KycProvider {
  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyBvn(
    bvn: string,
    options?: KycVerifyOptions,
  ): Promise<KycVerificationResult> {
    if (bvn.startsWith('0000')) {
      return { status: 'not_found' };
    }
    if (bvn.startsWith('1111')) {
      return { status: 'mismatch' };
    }
    return {
      status: 'verified',
      legalName: 'Test User',
      address: {
        street: '1 Test Street',
        town: 'Ikeja',
        lga: 'Ikeja',
        state: 'Lagos',
      },
      livenessPassed: options?.selfie ? true : undefined,
    };
  }

  verifyNin(): Promise<KycVerificationResult> {
    return Promise.reject(
      new Error('FakeKycProvider.verifyNin: not implemented'),
    );
  }
}
