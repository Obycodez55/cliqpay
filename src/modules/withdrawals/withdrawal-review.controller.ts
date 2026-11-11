import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { InternalSecretGuard } from '../../common/guards/internal-secret.guard';
import { WithdrawalsService } from './withdrawals.service';

class ListHeldWithdrawalsQuery {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class RejectHeldWithdrawalDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// Lives here, under the risk review prefix, because release and reject drive
// the payout code; risk itself must not depend on withdrawals.
@ApiTags('Risk (internal)')
@ApiSecurity('internal-secret')
@Controller('internal/risk/withdrawals')
@UseGuards(InternalSecretGuard)
export class WithdrawalReviewController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  @Get()
  @ApiOperation({ summary: 'List withdrawals held under review, oldest first' })
  list(@Query() query: ListHeldWithdrawalsQuery) {
    return this.withdrawalsService.listHeldWithdrawals(query);
  }

  @Post(':reference/release')
  @ApiOperation({
    summary: 'Release a held withdrawal: the payout is sent as normal',
  })
  release(@Param('reference') reference: string, @Req() req: Request) {
    return this.withdrawalsService.releaseHeldWithdrawal(
      reference,
      req.reviewerId!,
    );
  }

  @Post(':reference/reject')
  @ApiOperation({
    summary: 'Reject a held withdrawal: the money returns to the wallet',
  })
  reject(
    @Param('reference') reference: string,
    @Body() dto: RejectHeldWithdrawalDto,
    @Req() req: Request,
  ) {
    return this.withdrawalsService.rejectHeldWithdrawal(
      reference,
      req.reviewerId!,
      dto.note,
    );
  }
}
