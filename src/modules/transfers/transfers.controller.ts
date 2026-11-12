import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { ApiRiskAcknowledgementRequired } from '../../common/docs/risk-acknowledgement.docs';
import { RequireDeviceSignature } from '../../common/guards/device-signature.guard';
import { signingPart } from '../../common/device/signed-action';
import { TransfersService } from './transfers.service';
import { SendTransferDto } from './dto/send-transfer.dto';
import { SendTransferResponseDto } from './dto/send-transfer-response.dto';

@ApiTags('Transfers')
@ApiBearerAuth()
@Controller('transfers')
@UseGuards(JwtAuthGuard)
export class TransfersController {
  constructor(private readonly transfersService: TransfersService) {}

  @Post()
  @RequireDeviceSignature({
    action: 'transfer.send',
    signs:
      'reference = body.reference, amount = body.amount in kobo, target = body.recipientUserId',
    resolve: (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return {
        action: 'transfer.send',
        reference: signingPart(body.reference),
        amount: signingPart(body.amount),
        target: signingPart(body.recipientUserId),
      };
    },
  })
  @ApiRiskAcknowledgementRequired()
  @ApiOperation({ summary: 'Send money to another Cliqpay user' })
  async sendMoney(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SendTransferDto,
  ): Promise<SendTransferResponseDto> {
    return this.transfersService.sendMoney(req.user.userId, dto);
  }
}
