import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
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
  @ApiOperation({ summary: 'Send money to another Cliqpay user' })
  async sendMoney(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SendTransferDto,
  ): Promise<SendTransferResponseDto> {
    return this.transfersService.sendMoney(req.user.userId, dto);
  }
}
