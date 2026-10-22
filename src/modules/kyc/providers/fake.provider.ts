import { Injectable } from '@nestjs/common';
import {
  KycProvider,
  KycVerificationResult,
  LivenessOutcome,
  LivenessSubmission,
  LivenessSubmissionResult,
} from './kyc-provider.interface';

// BVNs and NINs are digits-only, so sentinels are prefixes: "0000" is not_found, "1111" is mismatch.
// Liveness is driven by the ID number too: prefix "2222" fails liveness, "3333" is
// asynchronous and passes on the first poll, "4444" is asynchronous and stays pending,
// "5555" is asynchronous and fails on the first poll; "6666" throws; anything else passes synchronously.
@Injectable()
export class FakeKycProvider implements KycProvider {
  private readonly asyncOutcomes = new Map<
    string,
    LivenessOutcome | 'pending'
  >();

  verifyBvn(bvn: string): Promise<KycVerificationResult> {
    return this.verify('Bvn Test User', bvn);
  }

  verifyNin(nin: string): Promise<KycVerificationResult> {
    return this.verify('Nin Test User', nin);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async submitLiveness(
    submission: LivenessSubmission,
  ): Promise<LivenessSubmissionResult> {
    const { idNumber } = submission;
    if (idNumber.startsWith('6666')) {
      throw new Error('fake liveness provider failure');
    }
    if (idNumber.startsWith('2222')) {
      return { status: 'failed' };
    }
    const asyncOutcome = idNumber.startsWith('3333')
      ? 'passed'
      : idNumber.startsWith('4444')
        ? 'pending'
        : idNumber.startsWith('5555')
          ? 'failed'
          : null;
    if (!asyncOutcome) {
      return { status: 'passed' };
    }
    const jobId = `fake-job-${this.asyncOutcomes.size + 1}-${idNumber}`;
    this.asyncOutcomes.set(jobId, asyncOutcome);
    return { status: 'pending', jobId };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getLivenessResult(jobId: string): Promise<LivenessOutcome | 'pending'> {
    return this.asyncOutcomes.get(jobId) ?? 'pending';
  }

  parseWebhookJobId(body: unknown): string | null {
    const jobId = (body as { jobId?: unknown } | null)?.jobId;
    return typeof jobId === 'string' ? jobId : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async verify(
    legalName: string,
    idNumber: string,
  ): Promise<KycVerificationResult> {
    if (idNumber.startsWith('0000')) {
      return { status: 'not_found' };
    }
    if (idNumber.startsWith('1111')) {
      return { status: 'mismatch' };
    }
    return {
      status: 'verified',
      legalName,
      address: {
        street: '1 Test Street',
        town: 'Ikeja',
        lga: 'Ikeja',
        state: 'Lagos',
      },
    };
  }
}
