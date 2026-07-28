import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { LedgerService } from './ledger.service';
import {
  WalletBalanceResponseDto,
  toWalletBalanceResponse,
} from './dto/wallet-balance-response.dto';

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Get('balance')
  async getBalance(
    @Req() req: AuthenticatedRequest,
  ): Promise<WalletBalanceResponseDto> {
    const wallet = await this.ledgerService.getUserWallet(req.user.userId);
    return toWalletBalanceResponse(wallet);
  }
}
