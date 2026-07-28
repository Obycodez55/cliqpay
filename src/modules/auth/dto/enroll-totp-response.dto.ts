import { ApiProperty } from '@nestjs/swagger';

// `otpauthUrl` is the standard `otpauth://` URI consumed directly by
// client-side QR-code renderers and authenticator apps — no image-rendering
// dependency needed on this side.
export class EnrollTotpResponseDto {
  @ApiProperty({ example: 'JBSWY3DPEHPK3PXP' })
  secret: string;

  @ApiProperty({
    example:
      'otpauth://totp/Cliqpay:jane@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Cliqpay',
  })
  otpauthUrl: string;
}
