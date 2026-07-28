import { ApiProperty } from '@nestjs/swagger';

export class TokenPairResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken: string;

  @ApiProperty({ example: 'a1b2c3d4e5f6...' })
  refreshToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({
    example: 900,
    description: 'Access token lifetime, in seconds',
  })
  expiresIn: number;
}

export function toTokenPairResponse(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): TokenPairResponseDto {
  return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn };
}
