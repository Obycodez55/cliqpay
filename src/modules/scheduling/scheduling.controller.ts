import {
  Body,
  Controller,
  Get,
  Param,
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
import { SchedulingService } from './scheduling.service';
import { CreateScheduledPaymentDto } from './dto/create-scheduled-payment.dto';
import { ScheduledPaymentResponseDto } from './dto/scheduled-payment-response.dto';

@ApiTags('Scheduled payments')
@ApiBearerAuth()
@Controller('scheduled-payments')
@UseGuards(JwtAuthGuard)
export class SchedulingController {
  constructor(private readonly schedulingService: SchedulingService) {}

  @Post()
  @ApiOperation({
    summary: 'Schedule a one-time payment to another Cliqpay user',
    description:
      'The PIN verified here authorises the payment on its date, when no PIN is asked. The balance is not checked now, only when the payment runs.',
  })
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateScheduledPaymentDto,
  ): Promise<ScheduledPaymentResponseDto> {
    return this.schedulingService.create(req.user.userId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of your scheduled payments' })
  async get(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ScheduledPaymentResponseDto> {
    return this.schedulingService.get(req.user.userId, id);
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: 'Cancel a scheduled payment',
    description:
      'Needs no PIN. A run already executing finishes; any run not yet started is cancelled.',
  })
  async cancel(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ScheduledPaymentResponseDto> {
    return this.schedulingService.cancel(req.user.userId, id);
  }
}
