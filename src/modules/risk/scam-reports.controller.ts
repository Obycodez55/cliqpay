import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { PerUserThrottlerGuard } from '../../common/guards/per-user-throttler.guard';
import { CreateScamReportDto } from './dto/create-scam-report.dto';
import {
  ScamReportAckDto,
  ScamReportViewDto,
  toScamReportAck,
  toScamReportView,
} from './dto/scam-case-response.dto';
import { ScamResponseDto } from './dto/scam-response.dto';
import { ScamCasesService } from './internal/scam-cases.service';

const REPORT_RATE_LIMIT = 5;
const REPORT_RATE_TTL_MS = 60 * 60 * 1000;

@ApiTags('Scam reports')
@ApiBearerAuth()
@Controller('scam-reports')
@UseGuards(JwtAuthGuard)
export class ScamReportsController {
  constructor(private readonly scamCases: ScamCasesService) {}

  @Post()
  @UseGuards(PerUserThrottlerGuard(REPORT_RATE_LIMIT, REPORT_RATE_TTL_MS))
  @ApiOperation({
    summary: 'Report a P2P transfer you sent as a scam',
    description:
      'The reported amount is held from the recipient until a reviewer decides. Returns the case reference, the due date and the next steps.',
  })
  async report(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateScamReportDto,
  ): Promise<ScamReportAckDto> {
    return toScamReportAck(await this.scamCases.report(req.user.userId, dto));
  }

  @Get()
  @ApiOperation({ summary: 'List the scam reports you have filed' })
  async list(@Req() req: AuthenticatedRequest): Promise<ScamReportViewDto[]> {
    const cases = await this.scamCases.listForReporter(req.user.userId);
    return cases.map(toScamReportView);
  }

  @Post(':reference/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw your report before it is decided',
    description: 'The held amount goes back to the recipient.',
  })
  async withdraw(
    @Req() req: AuthenticatedRequest,
    @Param('reference') reference: string,
  ): Promise<ScamReportViewDto> {
    return toScamReportView(
      await this.scamCases.withdraw(req.user.userId, reference),
    );
  }

  @Post(':reference/response')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Give your side of a report made against a transfer you received',
  })
  async respond(
    @Req() req: AuthenticatedRequest,
    @Param('reference') reference: string,
    @Body() dto: ScamResponseDto,
  ): Promise<void> {
    await this.scamCases.submitResponse(
      req.user.userId,
      reference,
      dto.response,
    );
  }
}
