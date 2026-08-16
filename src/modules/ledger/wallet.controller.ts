import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { CursorPaginationQueryDto } from '../../common/dto/cursor-pagination-query.dto';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import {
  IdentitySummaryDto,
  toIdentitySummary,
} from '../../common/dto/identity-summary.dto';
import { UsersService } from '../users/users.service';
import { LedgerService } from './ledger.service';
import {
  WalletBalanceResponseDto,
  toWalletBalanceResponse,
} from './dto/wallet-balance-response.dto';
import {
  TransactionHistoryItemDto,
  toTransactionHistoryItem,
} from './dto/transaction-history-item.dto';

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly usersService: UsersService,
  ) {}

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
  @ApiExtraModels(TransactionHistoryItemDto)
  @ApiOkResponse({
    schema: {
      properties: {
        items: {
          type: 'array',
          items: { $ref: getSchemaPath(TransactionHistoryItemDto) },
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  async getTransactions(
    @Req() req: AuthenticatedRequest,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<PaginatedResult<TransactionHistoryItemDto>> {
    const wallet = await this.ledgerService.getUserWallet(req.user.userId);
    const result = await this.ledgerService.getTransactionHistory(wallet.id, {
      cursor: query.cursor,
      limit: query.limit,
    });

    // Counterparty *names* are resolved here, not in LedgerService — ledger
    // stays clear of the `users` module (ADR-0011); this controller already
    // has UsersService in scope, so it batch-resolves the distinct
    // counterparty ids from the whole page in one query instead of N.
    const counterpartyUserIds = [
      ...new Set(
        result.items
          .map((item) => item.counterpartyUserId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const counterpartyUsers = counterpartyUserIds.length
      ? await this.usersService.findByIds(counterpartyUserIds)
      : [];
    const identityByUserId = new Map<string, IdentitySummaryDto>(
      counterpartyUsers.map((user) => [user.id, toIdentitySummary(user)]),
    );

    return {
      items: result.items.map((item) =>
        toTransactionHistoryItem(item, identityByUserId),
      ),
      nextCursor: result.nextCursor,
    };
  }
}
