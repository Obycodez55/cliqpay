export interface KycAddress {
  street: string;
  town: string;
  lga: string;
  state: string;
}

// not_found/mismatch are expected lookup outcomes, not thrown errors.
export interface KycVerificationResult {
  status: 'verified' | 'not_found' | 'mismatch';
  legalName?: string;
  address?: KycAddress;
  dateOfBirth?: string; // ISO YYYY-MM-DD
}

export interface LivenessSubmission {
  idType: 'bvn' | 'nin';
  idNumber: string;
  selfieImage: string; // base64 JPEG, never persisted
  livenessImages: string[]; // base64 JPEGs, never persisted
  user: {
    givenNames: string;
    lastName: string;
    email: string;
    phone: string;
  };
  consentGrantedAt: Date;
}

export type LivenessOutcome = 'passed' | 'failed';

// A synchronous provider answers with an outcome straight away; an
// asynchronous one returns a job id that getLivenessResult resolves later.
export type LivenessSubmissionResult =
  | { status: LivenessOutcome }
  | { status: 'pending'; jobId: string };

export interface KycProvider {
  // Lets the service refuse a liveness capture before paying for the lookup.
  readonly supportsLiveness: boolean;

  verifyBvn(bvn: string): Promise<KycVerificationResult>;

  verifyNin(nin: string): Promise<KycVerificationResult>;

  submitLiveness(
    submission: LivenessSubmission,
  ): Promise<LivenessSubmissionResult>;

  getLivenessResult(jobId: string): Promise<LivenessOutcome | 'pending'>;

  // The webhook body is untrusted: it only ever names a job to re-poll.
  parseWebhookJobId(body: unknown): string | null;
}

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');
