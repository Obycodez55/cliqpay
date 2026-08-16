import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
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
import { MoneyRequestsService } from './money-requests.service';
import { CreateMoneyRequestDto } from './dto/create-money-request.dto';
import { PayMoneyRequestDto } from './dto/pay-money-request.dto';
import { MoneyRequestResponseDto } from './dto/money-request-response.dto';

@ApiTags('Money requests')
@ApiBearerAuth()
@Controller('money-requests')
@UseGuards(JwtAuthGuard)
export class MoneyRequestsController {
  constructor(private readonly moneyRequestsService: MoneyRequestsService) {}

  @Post()
  @ApiOperation({ summary: 'Request money from another Cliqpay user' })
  // No idempotency key here, unlike funding/transfers (ADR-0010) — creating
  // a request moves no money, so a double-tap costs at most one pair-cap
  // slot, not a double-spend.
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateMoneyRequestDto,
  ): Promise<MoneyRequestResponseDto> {
    return this.moneyRequestsService.createRequest(req.user.userId, dto);
  }

  @Get('incoming')
  @ApiOperation({ summary: 'List money requests where you are the payer' })
  @ApiExtraModels(MoneyRequestResponseDto)
  @ApiOkResponse({
    schema: {
      properties: {
        items: {
          type: 'array',
          items: { $ref: getSchemaPath(MoneyRequestResponseDto) },
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  async listIncoming(
    @Req() req: AuthenticatedRequest,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<PaginatedResult<MoneyRequestResponseDto>> {
    return this.moneyRequestsService.listIncoming(req.user.userId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('outgoing')
  @ApiOperation({ summary: 'List money requests where you are the requester' })
  @ApiExtraModels(MoneyRequestResponseDto)
  @ApiOkResponse({
    schema: {
      properties: {
        items: {
          type: 'array',
          items: { $ref: getSchemaPath(MoneyRequestResponseDto) },
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  async listOutgoing(
    @Req() req: AuthenticatedRequest,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<PaginatedResult<MoneyRequestResponseDto>> {
    return this.moneyRequestsService.listOutgoing(req.user.userId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a money request you sent' })
  async cancel(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MoneyRequestResponseDto> {
    return this.moneyRequestsService.cancelRequest(req.user.userId, id);
  }

  @Post(':id/decline')
  @ApiOperation({ summary: 'Decline a money request you received' })
  async decline(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MoneyRequestResponseDto> {
    return this.moneyRequestsService.declineRequest(req.user.userId, id);
  }

  @Post(':id/pay')
  @ApiOperation({ summary: 'Pay a money request you received' })
  async pay(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayMoneyRequestDto,
  ): Promise<MoneyRequestResponseDto> {
    return this.moneyRequestsService.payRequest(req.user.userId, id, dto);
  }
}
