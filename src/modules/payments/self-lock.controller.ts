import {
  Body,
  Controller,
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
import { SelfLockResponseDto } from './dto/self-lock-response.dto';
import { SelfLockTokenDto } from './dto/self-lock-token.dto';
import { SelfLockService } from './internal/self-lock.service';

@ApiTags('Authentication')
@Controller('auth/self-lock')
export class SelfLockController {
  constructor(private readonly selfLockService: SelfLockService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lock your own account ("This wasn’t me")',
    description:
      'Blocks sending money, revokes every session and trusted device, cancels a pending limit raise and refuses security changes until the account is unlocked. Locking twice is harmless.',
  })
  async selfLock(
    @Req() req: AuthenticatedRequest,
  ): Promise<SelfLockResponseDto> {
    await this.selfLockService.lock(req.user.userId, 'app');
    return { locked: true };
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Lock an account from the link in a security alert',
    description:
      'Public: the token is a signed, 7-day link from a security alert and can only lock.',
  })
  async selfLockWithToken(
    @Body() dto: SelfLockTokenDto,
  ): Promise<SelfLockResponseDto> {
    await this.selfLockService.lockWithToken(dto.token);
    return { locked: true };
  }
}
