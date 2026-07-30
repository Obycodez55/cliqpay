import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { PaymentsService } from './payments.service';
import { FundWalletDto } from './dto/fund-wallet.dto';
import { FundWalletResponseDto } from './dto/fund-wallet-response.dto';

// Shares the `/wallet` namespace with ledger's WalletController by design,
// not by accident: /v1/wallet is one user-facing surface, split by whether
// a route needs a payment provider (here) or not (ledger). See ADR-0008.
// Named after the module (matches auth.controller.ts as auth's primary
// controller), not after `fund` specifically — withdrawal (Phase 4) lands
// on this same controller, another provider-backed /wallet route.
@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('fund')
  @ApiOperation({
    summary: "Start funding the current user's wallet, returns a checkout URL",
  })
  fundWallet(
    @Req() req: AuthenticatedRequest,
    @Body() dto: FundWalletDto,
  ): Promise<FundWalletResponseDto> {
    return this.paymentsService.fundWallet(req.user.userId, dto);
  }
}
