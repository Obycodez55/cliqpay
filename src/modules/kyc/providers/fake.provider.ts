import { Injectable } from '@nestjs/common';
import {
  KycProvider,
  KycVerificationResult,
  LivenessOutcome,
  LivenessSubmission,
  LivenessSubmissionResult,
} from './kyc-provider.interface';

// BVNs and NINs are digits-only, so sentinels are prefixes: "0000" is not_found, "1111" is mismatch.
// The same fake person comes back from a BVN and a NIN (named differently in form, same date of birth);
// the 5th digit "9" is a different person, "8" the same name with a different date of birth.
// Liveness is driven by the ID number too: prefix "2222" fails liveness, "3333" is
// asynchronous and passes on the first poll, "4444" is asynchronous and stays pending,
// "5555" is asynchronous and fails on the first poll; "6666" throws; anything else passes synchronously.
@Injectable()
export class FakeKycProvider implements KycProvider {
  readonly supportsLiveness = true;

  private readonly asyncOutcomes = new Map<
    string,
    LivenessOutcome | 'pending'
  >();

  verifyBvn(bvn: string): Promise<KycVerificationResult> {
    return this.verify('Ada Obi Lovelace', bvn);
  }

  verifyNin(nin: string): Promise<KycVerificationResult> {
    return this.verify('Lovelace Ada', nin);
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
    const otherPerson = idNumber[4] === '9';
    return {
      status: 'verified',
      legalName: otherPerson ? 'Grace Hopper' : legalName,
      dateOfBirth: otherPerson
        ? '1985-12-09'
        : idNumber[4] === '8'
          ? '1991-02-03'
          : '1990-01-02',
      address: {
        street: '1 Test Street',
        town: 'Ikeja',
        lga: 'Ikeja',
        state: 'Lagos',
      },
    };
  }
}
