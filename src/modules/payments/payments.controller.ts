import {
  Body,
  Controller,
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

// Shares the `/wallet` namespace with ledger's WalletController by design
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
