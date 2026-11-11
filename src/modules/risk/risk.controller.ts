import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { InternalSecretGuard } from '../../common/guards/internal-secret.guard';
import { LiftRestrictionDto } from './dto/lift-restriction.dto';
import { ListFlagsQueryDto } from './dto/list-flags-query.dto';
import { ReviewFlagDto } from './dto/review-flag.dto';
import { FraudFlag } from './entities/fraud-flag.entity';
import { RiskService } from './risk.service';

@ApiTags('Risk (internal)')
@ApiSecurity('internal-secret')
@Controller('internal/risk')
@UseGuards(InternalSecretGuard)
export class RiskController {
  constructor(private readonly riskService: RiskService) {}

  @Get('flags')
  @ApiOperation({
    summary: 'List enforced fraud flags (they hold withdrawals)',
  })
  listFlags(@Query() query: ListFlagsQueryDto): Promise<FraudFlag[]> {
    return this.riskService.listFlags(query, true);
  }

  @Get('flags/shadow')
  @ApiOperation({
    summary: 'List shadow fraud flags (observed only, they hold nothing)',
  })
  listShadowFlags(@Query() query: ListFlagsQueryDto): Promise<FraudFlag[]> {
    return this.riskService.listFlags(query, false);
  }

  @Get('flags/:id')
  @ApiOperation({ summary: 'Read one fraud flag with its evidence' })
  getFlag(@Param('id', ParseUUIDPipe) id: string): Promise<FraudFlag> {
    return this.riskService.getFlag(id);
  }

  @Post('flags/:id/review')
  @ApiOperation({
    summary:
      'Move a flag to reviewing, cleared or confirmed (confirming restricts outbound money)',
  })
  reviewFlag(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewFlagDto,
    @Req() req: Request,
  ): Promise<FraudFlag> {
    return this.riskService.reviewFlag(id, dto, req.reviewerId!);
  }

  @Post('restrictions/lift')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Lift an open restriction (not 'dispute' or 'sanctions')",
  })
  liftRestriction(
    @Body() dto: LiftRestrictionDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.riskService.liftRestriction(dto, req.reviewerId!);
  }
}
