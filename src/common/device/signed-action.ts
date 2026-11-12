import { Request } from 'express';

export const SIGNATURE_HEADER = 'x-device-signature';
export const SIGNATURE_TIMESTAMP_HEADER = 'x-signature-timestamp';

export interface SignedAction {
  action: string;
  reference: string;
  amount: string;
  target: string;
}

export type SignedActionResolver = (req: Request) => SignedAction | null;

export interface SignedActionVerification extends SignedAction {
  userId: string;
  deviceId: string;
  timestamp: string | undefined;
  signature: string | undefined;
}

export interface SignedActionVerifier {
  verifySignedAction(input: SignedActionVerification): Promise<void>;
}

export const SIGNED_ACTION_VERIFIER = Symbol('SIGNED_ACTION_VERIFIER');

/**
 * Renders a raw request value as a signing part. Anything that is not a
 * string or a safe integer becomes the empty string, so a malformed value
 * can never equal what the client signed.
 */
export function signingPart(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return '';
}
