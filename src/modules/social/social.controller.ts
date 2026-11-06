import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { SocialService } from './social.service';
import { SetPostVisibilityDto } from './dto/set-post-visibility.dto';
import { PostStateResponseDto } from './dto/post-state-response.dto';

@ApiTags('Social')
@ApiBearerAuth()
@Controller('social')
@UseGuards(JwtAuthGuard)
export class SocialController {
  constructor(private readonly socialService: SocialService) {}

  @Patch('posts/:transactionId/visibility')
  @ApiOperation({
    summary: 'Change the visibility of a post for a transfer you sent',
  })
  async setVisibility(
    @Req() req: AuthenticatedRequest,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @Body() dto: SetPostVisibilityDto,
  ): Promise<PostStateResponseDto> {
    return this.socialService.setVisibility(
      req.user.userId,
      transactionId,
      dto.visibility,
    );
  }

  @Put('posts/:transactionId/hide')
  @ApiOperation({ summary: 'Hide a post for a transfer you received' })
  async hide(
    @Req() req: AuthenticatedRequest,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<PostStateResponseDto> {
    return this.socialService.setHiddenByRecipient(
      req.user.userId,
      transactionId,
      true,
    );
  }

  @Delete('posts/:transactionId/hide')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unhide a post for a transfer you received' })
  async unhide(
    @Req() req: AuthenticatedRequest,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<PostStateResponseDto> {
    return this.socialService.setHiddenByRecipient(
      req.user.userId,
      transactionId,
      false,
    );
  }
}
