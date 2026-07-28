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
import { EnrollTotpDto } from './dto/enroll-totp.dto';
import { EnrollTotpResponseDto } from './dto/enroll-totp-response.dto';
import { StepUpChallengeResponseDto } from './dto/step-up-challenge-response.dto';
import { TokenPairResponseDto } from './dto/token-pair-response.dto';
import { VerifyMfaChallengeDto } from './dto/verify-mfa-challenge.dto';
import { setTrustedDeviceCookie } from './internal/cookie.util';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { MfaService, TRUSTED_DEVICE_TTL_MS } from './mfa.service';
import { extractDeviceMetadata } from './internal/device-metadata.util';

@Controller('mfa')
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly authService: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // Step-up initiate for TOTP enrollment — see docs/architecture.md §3.8
  // ("MFA methods" is directly on the step-up trigger list) and
  // AuthService.initiateTotpEnrollStepUp. Same shape as the change-email/
  // phone/password step-up endpoints.
  @Post('totp/enroll/step-up')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  initiateTotpEnrollStepUp(
    @Req() req: AuthenticatedRequest,
  ): Promise<StepUpChallengeResponseDto> {
    return this.authService.initiateTotpEnrollStepUp(req.user.userId);
  }

  @Post('totp/enroll')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  enrollTotp(
    @Req() req: AuthenticatedRequest,
    @Body() dto: EnrollTotpDto,
  ): Promise<EnrollTotpResponseDto> {
    return this.authService.enrollTotp(req.user.userId, dto);
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
