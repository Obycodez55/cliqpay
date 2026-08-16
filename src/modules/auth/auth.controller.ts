import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { RegisterResponseDto } from './dto/register-response.dto';
import { LoginDto } from './dto/login.dto';
import {
  LoginMfaRequiredResponseDto,
  LoginResponseDto,
  LoginSuccessResponseDto,
} from './dto/login-response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { TokenPairResponseDto } from './dto/token-pair-response.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { VerifyPhoneDto } from './dto/verify-phone.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { CompletePasswordResetDto } from './dto/complete-password-reset.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SetTransactionPinDto } from './dto/set-transaction-pin.dto';
import { ChangeTransactionPinDto } from './dto/change-transaction-pin.dto';
import { ResetTransactionPinDto } from './dto/reset-transaction-pin.dto';
import { ChangeEmailDto } from './dto/change-email.dto';
import { ConfirmChangeEmailDto } from './dto/confirm-change-email.dto';
import { ChangePhoneDto } from './dto/change-phone.dto';
import { ConfirmChangePhoneDto } from './dto/confirm-change-phone.dto';
import { StepUpChallengeResponseDto } from './dto/step-up-challenge-response.dto';
import { readTrustedDeviceCookie } from './internal/cookie.util';
import { extractDeviceMetadata } from './internal/device-metadata.util';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { SessionService } from './session.service';
import { TransactionPinService } from './transaction-pin.service';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    private readonly transactionPinService: TransactionPinService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a new user account' })
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
  @ApiOperation({
    summary: 'Log in with email and password, may return an MFA challenge',
  })
  @ApiExtraModels(LoginSuccessResponseDto, LoginMfaRequiredResponseDto)
  @ApiResponse({
    status: HttpStatus.OK,
    schema: {
      oneOf: [
        { $ref: getSchemaPath(LoginSuccessResponseDto) },
        { $ref: getSchemaPath(LoginMfaRequiredResponseDto) },
      ],
    },
  })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResponseDto> {
    return this.sessionService.login(
      dto,
      readTrustedDeviceCookie(req),
      extractDeviceMetadata(req),
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair' })
  refresh(@Body() dto: RefreshDto): Promise<TokenPairResponseDto> {
    return this.sessionService.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Log out and revoke the current session' })
  logout(@Body() dto: LogoutDto): Promise<void> {
    return this.sessionService.logout(dto);
  }

  // Public — the token itself is the proof of identity, no guard needed.
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Verify an email address using its verification token',
  })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    return this.authService.verifyEmail(dto.token);
  }

  // Authenticated — avoids taking an email/identifier in the body, which
  // would be an enumeration vector.
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resend the email verification link' })
  resendVerificationEmail(@Req() req: AuthenticatedRequest): Promise<void> {
    return this.authService.resendEmailVerification(req.user.userId);
  }

  // Public — the code itself is the proof, same as verify-email.
  @Post('verify-phone')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Verify a phone number using its verification code',
  })
  verifyPhone(@Body() dto: VerifyPhoneDto): Promise<void> {
    return this.authService.verifyPhone(dto.code);
  }

  // Authenticated — avoids taking a phone number in the body, which would
  // be an enumeration vector, same as verify-email/resend.
  @Post('verify-phone/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resend the phone verification code' })
  resendVerificationPhone(@Req() req: AuthenticatedRequest): Promise<void> {
    return this.authService.resendPhoneVerification(req.user.userId);
  }

  // Public and unauthenticated by definition — the caller has no session
  // yet. Always 200, whether or not the email belongs to an account (see
  // AuthService.requestPasswordReset) — no signal to distinguish either way.
  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request a password reset email' })
  requestPasswordReset(@Body() dto: RequestPasswordResetDto): Promise<void> {
    return this.authService.requestPasswordReset(dto.email);
  }

  // Public — the token itself is the proof, same as verify-email.
  @Post('password-reset/complete')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Complete a password reset using its reset token' })
  completePasswordReset(@Body() dto: CompletePasswordResetDto): Promise<void> {
    return this.authService.completePasswordReset(
      dto.token,
      dto.newPassword,
      dto.revokeOtherSessions,
    );
  }

  // Step 1 of 2 (see docs/adr/0006, issue #11) — fires unconditionally,
  // regardless of trusted-device status (docs/architecture.md §3.8).
  @Post('change-password/step-up')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start a step-up challenge for a password change' })
  initiateChangePasswordStepUp(
    @Req() req: AuthenticatedRequest,
  ): Promise<StepUpChallengeResponseDto> {
    return this.authService.initiatePasswordChangeStepUp(req.user.userId);
  }

  // Step 2 of 2 — verifies the step-up challenge and the current password,
  // then changes the password immediately — no pending/confirm step, unlike
  // change-email/change-phone, since there's no new value to deliver first.
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change the current password using a step-up challenge',
  })
  changePassword(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    return this.authService.changePassword(
      req.user.userId,
      req.user.sessionId,
      dto,
    );
  }

  // Step 1 of 3 (see docs/adr/0006) — fires unconditionally, regardless of
  // trusted-device status (docs/architecture.md §3.8).
  @Post('change-email/step-up')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start a step-up challenge for an email change' })
  initiateChangeEmailStepUp(
    @Req() req: AuthenticatedRequest,
  ): Promise<StepUpChallengeResponseDto> {
    return this.authService.initiateEmailChangeStepUp(req.user.userId);
  }

  // Step 2 of 3 — verifies the step-up challenge and sends a verification
  // code to the new address; the live email doesn't change until confirm.
  @Post('change-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Request an email change, sends a verification code to the new address',
  })
  changeEmail(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangeEmailDto,
  ): Promise<void> {
    return this.authService.changeEmail(req.user.userId, dto);
  }

  // Step 3 of 3 — only on a valid, unexpired, unused code does the email
  // actually change.
  @Post('change-email/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Confirm an email change using its verification code',
  })
  confirmChangeEmail(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ConfirmChangeEmailDto,
  ): Promise<void> {
    return this.authService.confirmEmailChange(
      req.user.userId,
      req.user.sessionId,
      dto,
    );
  }

  // Step 1 of 3 (see docs/adr/0006, issue #10) — fires unconditionally,
  // regardless of trusted-device status (docs/architecture.md §3.8).
  @Post('change-phone/step-up')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start a step-up challenge for a phone number change',
  })
  initiateChangePhoneStepUp(
    @Req() req: AuthenticatedRequest,
  ): Promise<StepUpChallengeResponseDto> {
    return this.authService.initiatePhoneChangeStepUp(req.user.userId);
  }

  // Step 2 of 3 — verifies the step-up challenge and sends an OTP to the
  // new number; the live phone doesn't change until confirm.
  @Post('change-phone')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Request a phone number change, sends an OTP to the new number',
  })
  changePhone(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangePhoneDto,
  ): Promise<void> {
    return this.authService.changePhone(req.user.userId, dto);
  }

  // Step 3 of 3 — only on a valid, unexpired, unused code does the phone
  // number actually change.
  @Post('change-phone/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm a phone number change using its OTP' })
  confirmChangePhone(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ConfirmChangePhoneDto,
  ): Promise<void> {
    return this.authService.confirmPhoneChange(
      req.user.userId,
      req.user.sessionId,
      dto,
    );
  }

  // Step 1 of 2 for set-pin — only usable while no PIN exists yet (see
  // setTransactionPin below); fires unconditionally regardless of
  // trusted-device status, same as the other step-up flows.
  @Post('transaction-pin/set/step-up')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start a step-up challenge for setting a transaction PIN',
  })
  initiateSetPinStepUp(
    @Req() req: AuthenticatedRequest,
  ): Promise<StepUpChallengeResponseDto> {
    return this.transactionPinService.initiateSetPinStepUp(req.user.userId);
  }

  // Step 2 of 2 — first-time PIN only; an existing PIN must go through
  // change or reset instead.
  @Post('transaction-pin/set')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Set the transaction PIN using a step-up challenge',
  })
  setTransactionPin(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SetTransactionPinDto,
  ): Promise<void> {
    return this.transactionPinService.setTransactionPin(req.user.userId, dto);
  }

  // Step 1 of 2 for change-pin.
  @Post('transaction-pin/change/step-up')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start a step-up challenge for changing the transaction PIN',
  })
  initiateChangePinStepUp(
    @Req() req: AuthenticatedRequest,
  ): Promise<StepUpChallengeResponseDto> {
    return this.transactionPinService.initiateChangePinStepUp(req.user.userId);
  }

  // Step 2 of 2 — requires the current PIN; a wrong current PIN here counts
  // toward the PIN lockout (see docs/adr/0009-transaction-pin.md).
  @Post('transaction-pin/change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Change the transaction PIN using the current PIN and a step-up challenge',
  })
  changeTransactionPin(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangeTransactionPinDto,
  ): Promise<void> {
    return this.transactionPinService.changeTransactionPin(
      req.user.userId,
      dto,
    );
  }

  // Step 1 of 2 for reset-pin — the recovery path for a forgotten PIN, so
  // it must stay reachable even while the PIN is locked (see ADR-0009).
  @Post('transaction-pin/reset/step-up')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Start a step-up challenge for resetting a forgotten transaction PIN',
  })
  initiateResetPinStepUp(
    @Req() req: AuthenticatedRequest,
  ): Promise<StepUpChallengeResponseDto> {
    return this.transactionPinService.initiateResetPinStepUp(req.user.userId);
  }

  // Step 2 of 2 — no current PIN required, since this is the recovery path;
  // clears the PIN lockout state as part of setting the new PIN.
  @Post('transaction-pin/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reset the transaction PIN using a step-up challenge',
  })
  resetTransactionPin(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ResetTransactionPinDto,
  ): Promise<void> {
    return this.transactionPinService.resetTransactionPin(req.user.userId, dto);
  }
}
