import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { InternalSecretGuard } from '../../common/guards/internal-secret.guard';
import { ListScamCasesQueryDto } from './dto/list-scam-cases-query.dto';
import { ResolveScamCaseDto } from './dto/resolve-scam-case.dto';
import { toScamCaseReviewView } from './dto/scam-case-response.dto';
import { ScamCasesService } from './internal/scam-cases.service';

@ApiTags('Risk (internal)')
@ApiSecurity('internal-secret')
@Controller('internal/risk/scam-cases')
@UseGuards(InternalSecretGuard)
export class ScamCaseReviewController {
  constructor(private readonly scamCases: ScamCasesService) {}

  @Get()
  @ApiOperation({ summary: 'List scam cases, optionally only overdue ones' })
  async list(@Query() query: ListScamCasesQueryDto) {
    return (await this.scamCases.listCases(query)).map(toScamCaseReviewView);
  }

  @Get(':reference')
  @ApiOperation({ summary: 'Read one scam case with the recipient response' })
  async get(@Param('reference') reference: string) {
    return toScamCaseReviewView(await this.scamCases.getCase(reference));
  }

  @Post(':reference/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Uphold or reject a case',
    description:
      "'upheld' pays the held amount to the reporter and restricts the recipient; 'rejected' returns it to the recipient. A decided case is never reopened.",
  })
  async resolve(
    @Param('reference') reference: string,
    @Body() dto: ResolveScamCaseDto,
    @Req() req: Request,
  ) {
    return toScamCaseReviewView(
      await this.scamCases.resolve(reference, dto, req.reviewerId!),
    );
  }
}
