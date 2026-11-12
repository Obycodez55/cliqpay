import {
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PerUserThrottlerGuard } from '../../common/guards/per-user-throttler.guard';
import { UsersService } from '../users/users.service';
import { KycService } from '../kyc/kyc.service';
import { LookupRecipientQueryDto } from './dto/lookup-recipient-query.dto';
import { RecipientLookupResponseDto } from './dto/recipient-lookup-response.dto';

// Well below the global default of 100/60s (rate-limit.module.ts) — this
// is a post-auth enumeration oracle that also reveals legal names.
const LOOKUP_RATE_LIMIT = 5;
const LOOKUP_RATE_TTL_MS = 60_000;

@ApiTags('Recipients')
@ApiBearerAuth()
@Controller('recipients')
@UseGuards(
  JwtAuthGuard,
  PerUserThrottlerGuard(LOOKUP_RATE_LIMIT, LOOKUP_RATE_TTL_MS),
)
export class RecipientController {
  constructor(
    private readonly usersService: UsersService,
    private readonly kycService: KycService,
  ) {}

  @Get('lookup')
  @ApiOperation({
    summary: 'Resolve a recipient by username or email before sending money',
  })
  async lookup(
    @Query() query: LookupRecipientQueryDto,
  ): Promise<RecipientLookupResponseDto> {
    const recipient = await this.usersService.lookupRecipient(query.identifier);
    if (!recipient) {
      throw new NotFoundException();
    }
    return {
      ...recipient,
      verifiedName: await this.kycService.getVerifiedLegalName(
        recipient.userId,
      ),
    };
  }
}
