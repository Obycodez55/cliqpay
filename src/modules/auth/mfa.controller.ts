import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { APP_CONFIG, AppConfig } from '../../config';
import { AuthService } from './auth.service';
import { ConfirmTotpDto } from './dto/confirm-totp.dto';
import { EnrollTotpResponseDto } from './dto/enroll-totp-response.dto';
import { TokenPairResponseDto } from './dto/token-pair-response.dto';
import { VerifyMfaChallengeDto } from './dto/verify-mfa-challenge.dto';
import { setTrustedDeviceCookie } from './internal/cookie.util';
import { AuthenticatedRequest, JwtAuthGuard } from './guards/jwt-auth.guard';
import { MfaService, TRUSTED_DEVICE_TTL_MS } from './mfa.service';
import { extractDeviceMetadata } from './internal/device-metadata.util';

@Controller('mfa')
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly authService: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('totp/enroll')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  enrollTotp(@Req() req: AuthenticatedRequest): Promise<EnrollTotpResponseDto> {
    return this.mfaService.enrollTotp(req.user.userId);
  }

  @Post('totp/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  confirmTotp(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ConfirmTotpDto,
  ): Promise<void> {
    return this.mfaService.confirmTotp(req.user.userId, dto.code);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async verify(
    @Body() dto: VerifyMfaChallengeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPairResponseDto> {
    const { tokens, trustedDeviceToken } =
      await this.authService.verifyMfaChallenge(
        dto,
        extractDeviceMetadata(req),
      );
    setTrustedDeviceCookie(
      res,
      trustedDeviceToken,
      TRUSTED_DEVICE_TTL_MS,
      this.config.app.env !== 'development',
    );
    return tokens;
  }
}
