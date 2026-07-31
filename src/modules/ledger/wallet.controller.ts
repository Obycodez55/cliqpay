import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import { LedgerService } from './ledger.service';
import {
  WalletBalanceResponseDto,
  toWalletBalanceResponse,
} from './dto/wallet-balance-response.dto';
import { TransactionHistoryItemDto } from './dto/transaction-history-item.dto';

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Get('balance')
  @ApiOperation({ summary: "Get the current user's wallet balance" })
  async getBalance(
    @Req() req: AuthenticatedRequest,
  ): Promise<WalletBalanceResponseDto> {
    const wallet = await this.ledgerService.getUserWallet(req.user.userId);
    return toWalletBalanceResponse(wallet);
  }

  @Get('transactions')
  @ApiOperation({ summary: "Get the current user's transaction history" })
  async getTransactions(
    @Req() req: AuthenticatedRequest,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<PaginatedResult<TransactionHistoryItemDto>> {
    const wallet = await this.ledgerService.getUserWallet(req.user.userId);
    return this.ledgerService.getTransactionHistory(wallet.id, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
