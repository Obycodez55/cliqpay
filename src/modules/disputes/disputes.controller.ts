import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalSecretGuard } from '../../common/guards/internal-secret.guard';
import { DisputesService } from './disputes.service';
import { RecordChargebackDto } from './dto/record-chargeback.dto';
import { RecordChargebackResponseDto } from './dto/record-chargeback-response.dto';
import { CollectionsEntryDto } from './dto/collections-response.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { ResolveDisputeResponseDto } from './dto/resolve-dispute-response.dto';

// Internal/ops surface, not user-facing — gated by InternalSecretGuard
// (X-Internal-Secret header), never JwtAuthGuard. See
// docs/adr/0016-disputes-module-boundary.md.
@ApiTags('Disputes (internal)')
@ApiSecurity('internal-secret')
@Controller('disputes')
@UseGuards(InternalSecretGuard)
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Post('chargebacks')
  @ApiOperation({
    summary:
      'Record a chargeback against a funding transaction (ops-triggered)',
  })
  recordChargeback(
    @Body() dto: RecordChargebackDto,
    @Req() req: Request,
  ): Promise<RecordChargebackResponseDto> {
    return this.disputesService.recordChargeback(dto, req.reviewerId!);
  }

  @Post('resolve')
  @ApiOperation({
    summary:
      "Resolve a dispute — upheld (bank's ruling stands) or resolved in Cliqpay's favor (re-credits the user)",
  })
  resolveDispute(
    @Body() dto: ResolveDisputeDto,
    @Req() req: Request,
  ): Promise<ResolveDisputeResponseDto> {
    return this.disputesService.resolveDispute(dto, req.reviewerId!);
  }

  @Get('collections')
  @ApiOperation({
    summary:
      'List wallets currently owing Cliqpay money because of a chargeback',
  })
  getCollections(): Promise<CollectionsEntryDto[]> {
    return this.disputesService.getCollections();
  }
}
