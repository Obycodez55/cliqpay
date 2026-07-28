import { MfaMethodKind } from './login-response.dto';

// Same shape as LoginResponseDto's mfaRequired:true branch — a step-up
// challenge is the same MfaChallenge machinery, just triggered explicitly
// instead of as a login fork.
export interface StepUpChallengeResponseDto {
  challengeId: string;
  method: MfaMethodKind;
  expiresAt: Date;
}
