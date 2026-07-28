import { ApiProperty } from '@nestjs/swagger';

// Docs-only mirror of ApiErrorResponse (api-error-response.interface.ts) —
// that interface has no runtime presence for the swagger plugin to read,
// and AllExceptionsFilter is the one place in the app that produces this
// shape, so every error response across every endpoint matches this model.
class ApiErrorDetailDto {
  @ApiProperty({ example: 'VALIDATION_FAILED' })
  code: string;

  @ApiProperty({ example: 'Request validation failed' })
  message: string;

  @ApiProperty({ required: false })
  details?: unknown;
}

export class ErrorResponseDto {
  @ApiProperty({ example: false })
  success: false;

  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ type: ApiErrorDetailDto })
  error: ApiErrorDetailDto;

  @ApiProperty({ example: '/v1/auth/login' })
  path: string;

  @ApiProperty({ example: '2026-07-28T19:04:00.000Z' })
  timestamp: string;
}
