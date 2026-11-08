import {
  Body,
  Controller,
  Get,
  Param,
  Query,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { BillSplitService } from './billsplit.service';
import { CreateBillSplitDto } from './dto/create-bill-split.dto';
import {
  BillSplitListItemDto,
  BillSplitResponseDto,
} from './dto/bill-split-response.dto';
import { ListBillSplitsQueryDto } from './dto/list-bill-splits-query.dto';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';

@ApiTags('Bill splits')
@ApiBearerAuth()
@Controller('bill-splits')
@UseGuards(JwtAuthGuard)
export class BillSplitController {
  constructor(private readonly billSplitService: BillSplitService) {}

  @Post()
  @ApiOperation({
    summary:
      'Split a bill: send each participant a money request for their share',
    description:
      "Each share is a group-share money request. Paying one is an ordinary P2P transfer, but it records no post and takes no `visibility`, so a paid share's transaction id has no post.",
  })
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateBillSplitDto,
  ): Promise<BillSplitResponseDto> {
    return this.billSplitService.createSplit(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List bill splits you started or were asked to pay into',
  })
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListBillSplitsQueryDto,
  ): Promise<PaginatedResult<BillSplitListItemDto>> {
    return this.billSplitService.listSplits(req.user.userId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'View a bill split you started or were asked to pay into',
  })
  async get(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BillSplitResponseDto> {
    return this.billSplitService.getSplit(req.user.userId, id);
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: 'Cancel an open bill split, cancelling every share still pending',
    description:
      'Initiator only. Shares already paid or declined are untouched; participants are not notified.',
  })
  async cancel(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BillSplitResponseDto> {
    return this.billSplitService.cancelSplit(req.user.userId, id);
  }
}
