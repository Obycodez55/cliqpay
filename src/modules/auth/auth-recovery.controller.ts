import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { InternalSecretGuard } from '../../common/guards/internal-secret.guard';
import { AuthService } from './auth.service';
import { RecoverEmailDto } from './dto/recover-email.dto';

// Reviewer-only, gated like the disputes controller. It sits in `auth`
// because restoring an email also has to cut every session and code tied to
// the old address; the risk module will own the /internal/risk prefix.
@ApiTags('Account recovery (internal)')
@ApiSecurity('internal-secret')
@Controller('internal/risk/users')
@UseGuards(InternalSecretGuard)
export class AuthRecoveryController {
  constructor(private readonly authService: AuthService) {}

  @Post(':id/recover-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Restore an email the owner controls, after out-of-band verification',
  })
  recoverEmail(
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: RecoverEmailDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.authService.recoverEmail(userId, dto.newEmail, req.reviewerId!);
  }
}
