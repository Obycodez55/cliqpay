import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
  VERSION_NEUTRAL,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { KycService } from './kyc.service';
import { VerifyBvnDto } from './dto/verify-bvn.dto';
import { VerifyNinDto } from './dto/verify-nin.dto';
import { VerifyIdentityResponseDto } from './dto/verify-identity-response.dto';
import { KycStatusResponseDto } from './dto/kyc-status-response.dto';

@ApiTags('KYC')
@Controller('kyc')
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Post('verify-bvn')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: "Verify the caller's BVN and derive their KYC tier",
  })
  verifyBvn(
    @Req() req: AuthenticatedRequest,
    @Body() dto: VerifyBvnDto,
  ): Promise<VerifyIdentityResponseDto> {
    return this.kycService.verifyBvn(req.user.userId, dto.bvn, dto.liveness);
  }

  @Post('verify-nin')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: "Verify the caller's NIN and derive their KYC tier",
  })
  verifyNin(
    @Req() req: AuthenticatedRequest,
    @Body() dto: VerifyNinDto,
  ): Promise<VerifyIdentityResponseDto> {
    return this.kycService.verifyNin(req.user.userId, dto.nin, dto.liveness);
  }

  @Get('status')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Get current KYC tier, verified identity pieces, and daily allowance',
  })
  getStatus(@Req() req: AuthenticatedRequest): Promise<KycStatusResponseDto> {
    return this.kycService.getStatus(req.user.userId);
  }

  @Post('webhook')
  @Version(VERSION_NEUTRAL)
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({
    summary: "KYC provider's liveness result callback",
    description:
      'Unauthenticated trigger only: the body is never trusted, it just names a pending job whose result is re-fetched from the provider.',
  })
  handleLivenessWebhook(@Body() body: unknown): Promise<void> {
    return this.kycService.handleLivenessWebhook(body);
  }
}
