import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalSecretGuard } from '../../common/guards/internal-secret.guard';
import { DisputesService } from './disputes.service';
import { RecordChargebackDto } from './dto/record-chargeback.dto';
import { RecordChargebackResponseDto } from './dto/record-chargeback-response.dto';
import { CollectionsEntryDto } from './dto/collections-response.dto';

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
  ): Promise<RecordChargebackResponseDto> {
    return this.disputesService.recordChargeback(dto);
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
