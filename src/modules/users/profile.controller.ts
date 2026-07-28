import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileResponseDto } from './dto/profile-response.dto';

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  getProfile(@Req() req: AuthenticatedRequest): Promise<ProfileResponseDto> {
    return this.usersService.getProfile(req.user.userId);
  }

  @Patch()
  updateProfile(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileResponseDto> {
    return this.usersService.updateProfile(req.user.userId, dto);
  }
}
