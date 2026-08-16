import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { WithdrawalsService } from './withdrawals.service';
import { SaveBankAccountDto } from './dto/save-bank-account.dto';
import { BankAccountResponseDto } from './dto/bank-account-response.dto';
import { StepUpChallengeResponseDto } from './dto/step-up-challenge-response.dto';

@ApiTags('Withdrawals')
@ApiBearerAuth()
@Controller('withdrawals/bank-accounts')
@UseGuards(JwtAuthGuard)
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  @Post('step-up')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Start a step-up challenge for saving a bank account',
  })
  initiateSaveBankAccountStepUp(
    @Req() req: AuthenticatedRequest,
  ): Promise<StepUpChallengeResponseDto> {
    return this.withdrawalsService.initiateSaveBankAccountStepUp(
      req.user.userId,
    );
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Save a bank account, using a step-up challenge',
  })
  saveBankAccount(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SaveBankAccountDto,
  ): Promise<BankAccountResponseDto> {
    return this.withdrawalsService.saveBankAccount(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List saved bank accounts' })
  listBankAccounts(
    @Req() req: AuthenticatedRequest,
  ): Promise<BankAccountResponseDto[]> {
    return this.withdrawalsService.listBankAccounts(req.user.userId);
  }
}
