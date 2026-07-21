// `otpauthUrl` is the standard `otpauth://` URI consumed directly by
// client-side QR-code renderers and authenticator apps — no image-rendering
// dependency needed on this side.
export interface EnrollTotpResponseDto {
  secret: string;
  otpauthUrl: string;
}
