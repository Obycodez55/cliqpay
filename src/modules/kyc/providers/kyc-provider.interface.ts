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
  livenessPassed?: boolean;
}

export interface KycVerifyOptions {
  selfie?: string; // base64, never persisted
}

export interface KycProvider {
  verifyBvn(
    bvn: string,
    options?: KycVerifyOptions,
  ): Promise<KycVerificationResult>;

  verifyNin(
    nin: string,
    options?: KycVerifyOptions,
  ): Promise<KycVerificationResult>;
}

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');
