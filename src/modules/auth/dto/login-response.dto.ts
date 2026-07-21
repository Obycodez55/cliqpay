import { TokenPairResponseDto } from './token-pair-response.dto';

export type MfaMethodKind = 'email' | 'totp';

// A discriminated union, not always-tokens — see docs/architecture.md §3.8:
// login on an untrusted device must challenge before issuing anything.
export type LoginResponseDto =
  | ({ mfaRequired: false } & TokenPairResponseDto)
  | {
      mfaRequired: true;
      challengeId: string;
      method: MfaMethodKind;
      expiresAt: Date;
    };
