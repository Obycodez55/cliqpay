import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { SchedulingService } from './scheduling.service';
import { CreateScheduledPaymentDto } from './dto/create-scheduled-payment.dto';
import { ListScheduledPaymentRunsQueryDto } from './dto/list-scheduled-payment-runs-query.dto';
import { ResumeScheduledPaymentDto } from './dto/resume-scheduled-payment.dto';
import { UpdateScheduledPaymentDto } from './dto/update-scheduled-payment.dto';
import { ScheduledPaymentRunResponseDto } from './dto/scheduled-payment-run-response.dto';
import { ListScheduledPaymentsQueryDto } from './dto/list-scheduled-payments-query.dto';
import { ScheduledPaymentResponseDto } from './dto/scheduled-payment-response.dto';

@ApiTags('Scheduled payments')
@ApiBearerAuth()
@Controller('scheduled-payments')
@UseGuards(JwtAuthGuard)
export class SchedulingController {
  constructor(private readonly schedulingService: SchedulingService) {}

  @Post()
  @ApiOperation({
    summary: 'Schedule a one-time or recurring payment to another Cliqpay user',
    description:
      'The PIN verified here authorises the payment on its date, when no PIN is asked. The balance is not checked now, only when the payment runs.',
  })
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateScheduledPaymentDto,
  ): Promise<ScheduledPaymentResponseDto> {
    return this.schedulingService.create(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List your scheduled payments, newest first' })
  @ApiExtraModels(ScheduledPaymentResponseDto)
  @ApiOkResponse({
    schema: {
      properties: {
        items: {
          type: 'array',
          items: { $ref: getSchemaPath(ScheduledPaymentResponseDto) },
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListScheduledPaymentsQueryDto,
  ): Promise<PaginatedResult<ScheduledPaymentResponseDto>> {
    return this.schedulingService.list(req.user.userId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of your scheduled payments' })
  async get(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ScheduledPaymentResponseDto> {
    return this.schedulingService.get(req.user.userId, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Modify a scheduled payment',
    description:
      'Owner only. Edits apply from the next run: a run already created keeps its settings. Changing the amount, interval, next run date or end condition needs the PIN; the note and visibility do not. The payee cannot be changed.',
  })
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScheduledPaymentDto,
  ): Promise<ScheduledPaymentResponseDto> {
    return this.schedulingService.update(req.user.userId, id, dto);
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

  @Post(':id/pause')
  @ApiOperation({
    summary: 'Pause a scheduled payment',
    description:
      'Needs no PIN. Runs not yet started are cancelled; an attempt already executing finishes. Nothing is sent until you resume.',
  })
  async pause(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ScheduledPaymentResponseDto> {
    return this.schedulingService.pause(req.user.userId, id);
  }

  @Post(':id/resume')
  @ApiOperation({
    summary: 'Resume a paused scheduled payment',
    description:
      'Needs the PIN. Continues from the next run date still in the future; dates that passed while paused are skipped, not run. 422 when no run is left to start.',
  })
  async resume(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResumeScheduledPaymentDto,
  ): Promise<ScheduledPaymentResponseDto> {
    return this.schedulingService.resume(req.user.userId, id, dto);
  }

  @Get(':id/runs')
  @ApiOperation({
    summary: "A scheduled payment's runs, newest first, with their attempts",
  })
  @ApiExtraModels(ScheduledPaymentRunResponseDto)
  @ApiOkResponse({
    schema: {
      properties: {
        items: {
          type: 'array',
          items: { $ref: getSchemaPath(ScheduledPaymentRunResponseDto) },
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  async listRuns(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListScheduledPaymentRunsQueryDto,
  ): Promise<PaginatedResult<ScheduledPaymentRunResponseDto>> {
    return this.schedulingService.listRuns(req.user.userId, id, query);
  }
}
