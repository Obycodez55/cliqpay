import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
@ApiBearerAuth()
@Controller('kyc')
@UseGuards(JwtAuthGuard)
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Post('verify-bvn')
  @ApiOperation({
    summary: "Verify the caller's BVN and derive their KYC tier",
  })
  verifyBvn(
    @Req() req: AuthenticatedRequest,
    @Body() dto: VerifyBvnDto,
  ): Promise<VerifyIdentityResponseDto> {
    return this.kycService.verifyBvn(req.user.userId, dto.bvn);
  }

  @Post('verify-nin')
  @ApiOperation({
    summary: "Verify the caller's NIN and derive their KYC tier",
  })
  verifyNin(
    @Req() req: AuthenticatedRequest,
    @Body() dto: VerifyNinDto,
  ): Promise<VerifyIdentityResponseDto> {
    return this.kycService.verifyNin(req.user.userId, dto.nin);
  }

  @Get('status')
  @ApiOperation({
    summary:
      'Get current KYC tier, verified identity pieces, and daily allowance',
  })
  getStatus(@Req() req: AuthenticatedRequest): Promise<KycStatusResponseDto> {
    return this.kycService.getStatus(req.user.userId);
  }
}
