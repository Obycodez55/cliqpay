import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { PaymentsService } from './payments.service';
import { FundWalletDto } from './dto/fund-wallet.dto';
import { FundWalletResponseDto } from './dto/fund-wallet-response.dto';
import { WalletLimitsResponseDto } from './dto/wallet-limits-response.dto';
import {
  CancelLimitIncreaseDto,
  LowerDailyLimitDto,
  RaiseDailyLimitDto,
  UserLimitResponseDto,
} from './dto/user-limit.dto';
import { RequireDeviceSignature } from '../../common/guards/device-signature.guard';
import { signingPart } from '../../common/device/signed-action';

// Shares the `/wallet` namespace with the wallet module's WalletController by design
@ApiTags('Wallet')
@Controller('wallet')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('fund')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Start funding the current user's wallet, returns a checkout URL",
    description:
      'reference must be globally unique across all users — a UUID is recommended.',
  })
  @ApiResponse({
    status: 409,
    description: 'reference was already used by a different user.',
  })
  @ApiResponse({
    status: 422,
    description:
      'reference was already used by this user with a different amount.',
  })
  fundWallet(
    @Req() req: AuthenticatedRequest,
    @Body() dto: FundWalletDto,
  ): Promise<FundWalletResponseDto> {
    return this.paymentsService.fundWallet(req.user.userId, dto);
  }

  @Get('limits')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Today's remaining daily allowance and balance headroom",
    description:
      "Composed from the tier's limits and the wallet's activity; enforcement still decides each request.",
  })
  @ApiResponse({ status: 200, type: WalletLimitsResponseDto })
  getLimits(
    @Req() req: AuthenticatedRequest,
  ): Promise<WalletLimitsResponseDto> {
    return this.paymentsService.getWalletLimits(req.user.userId);
  }

  @Post('limits/daily/lower')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Lower your own daily outflow limit, effective at once',
    description:
      'Needs the transaction PIN only and no device signature: a lower limit cannot hurt the owner. Lowering also cancels a pending raise.',
  })
  @ApiResponse({ status: 200, type: UserLimitResponseDto })
  lowerDailyLimit(
    @Req() req: AuthenticatedRequest,
    @Body() dto: LowerDailyLimitDto,
  ): Promise<UserLimitResponseDto> {
    return this.paymentsService.lowerDailyLimit(
      req.user.userId,
      dto.amount,
      dto.pin,
    );
  }

  @Post('limits/daily/raise/step-up')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Start a step-up challenge for raising your limit' })
  initiateRaiseDailyLimitStepUp(@Req() req: AuthenticatedRequest) {
    return this.paymentsService.initiateRaiseDailyLimitStepUp(req.user.userId);
  }

  @Post('limits/daily/raise')
  @HttpCode(200)
  @ApiBearerAuth()
  @RequireDeviceSignature({
    action: 'limit.raise',
    signs:
      'reference = body.challengeId, amount = body.amount in kobo, target = ""',
    resolve: (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return {
        action: 'limit.raise',
        reference: signingPart(body.challengeId),
        amount: signingPart(body.amount),
        target: '',
      };
    },
  })
  // Below the signature decorator on purpose: guards run bottom-up, and the
  // signature guard needs the user the JWT guard sets.
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Request a higher daily outflow limit, effective 24 hours later',
    description:
      'Needs a step-up challenge and the transaction PIN, and sends a security alert at once. The raise can be cancelled until it takes effect.',
  })
  @ApiResponse({ status: 200, type: UserLimitResponseDto })
  raiseDailyLimit(
    @Req() req: AuthenticatedRequest,
    @Body() dto: RaiseDailyLimitDto,
  ): Promise<UserLimitResponseDto> {
    return this.paymentsService.raiseDailyLimit(req.user.userId, dto);
  }

  @Post('limits/daily/raise/cancel')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Cancel a pending limit raise',
    description:
      'Needs the transaction PIN only and no device signature: cancelling can only keep the limit where it is.',
  })
  @ApiResponse({ status: 200, type: UserLimitResponseDto })
  cancelDailyLimitRaise(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CancelLimitIncreaseDto,
  ): Promise<UserLimitResponseDto> {
    return this.paymentsService.cancelDailyLimitRaise(req.user.userId, dto.pin);
  }

  @Post('webhook/kora')
  @Version(VERSION_NEUTRAL)
  @HttpCode(200)
  // Its own bucket, not the global per-IP default (100/min)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({ summary: "Kora's webhook receiver (charges and payouts)" })
  handleKoraWebhook(
    @Req() req: Request,
    @Headers('x-korapay-signature') signature: string | undefined,
  ): Promise<void> {
    return this.paymentsService.handleKoraWebhook(
      req.rawBody ?? Buffer.alloc(0),
      signature,
    );
  }
}
