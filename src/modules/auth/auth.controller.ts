import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { RegisterResponseDto } from './dto/register-response.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { TokenPairResponseDto } from './dto/token-pair-response.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { VerifyPhoneDto } from './dto/verify-phone.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { CompletePasswordResetDto } from './dto/complete-password-reset.dto';
import { readTrustedDeviceCookie } from './internal/cookie.util';
import { extractDeviceMetadata } from './internal/device-metadata.util';
import { AuthenticatedRequest, JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    return this.authService.register(dto);
  }

  // No cookie is set here even on the mfaRequired:false (trusted-device
  // skip) path — the client already holds a valid one, nothing to reissue.
  // A fresh cookie is only ever minted on a successful MFA verify (see
  // MfaController) — see docs/architecture.md §3.8.
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResponseDto> {
    return this.authService.login(
      dto,
      readTrustedDeviceCookie(req),
      extractDeviceMetadata(req),
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<TokenPairResponseDto> {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() dto: LogoutDto): Promise<void> {
    return this.authService.logout(dto);
  }

  // Public — the token itself is the proof of identity, no guard needed.
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    return this.authService.verifyEmail(dto.token);
  }

  // Authenticated — avoids taking an email/identifier in the body, which
  // would be an enumeration vector.
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  resendVerificationEmail(@Req() req: AuthenticatedRequest): Promise<void> {
    return this.authService.resendEmailVerification(req.user.userId);
  }

  // Public — the code itself is the proof, same as verify-email.
  @Post('verify-phone')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifyPhone(@Body() dto: VerifyPhoneDto): Promise<void> {
    return this.authService.verifyPhone(dto.code);
  }

  // Authenticated — avoids taking a phone number in the body, which would
  // be an enumeration vector, same as verify-email/resend.
  @Post('verify-phone/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  resendVerificationPhone(@Req() req: AuthenticatedRequest): Promise<void> {
    return this.authService.resendPhoneVerification(req.user.userId);
  }

  // Public and unauthenticated by definition — the caller has no session
  // yet. Always 200, whether or not the email belongs to an account (see
  // AuthService.requestPasswordReset) — no signal to distinguish either way.
  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  requestPasswordReset(@Body() dto: RequestPasswordResetDto): Promise<void> {
    return this.authService.requestPasswordReset(dto.email);
  }

  // Public — the token itself is the proof, same as verify-email.
  @Post('password-reset/complete')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  completePasswordReset(@Body() dto: CompletePasswordResetDto): Promise<void> {
    return this.authService.completePasswordReset(
      dto.token,
      dto.newPassword,
      dto.revokeOtherSessions,
    );
  }
}
