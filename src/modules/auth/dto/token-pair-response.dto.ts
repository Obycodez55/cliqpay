export interface TokenPairResponseDto {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export function toTokenPairResponse(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): TokenPairResponseDto {
  return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn };
}
