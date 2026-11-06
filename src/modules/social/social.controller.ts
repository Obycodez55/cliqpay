import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  AuthenticatedRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { SocialService } from './social.service';
import { SetPostVisibilityDto } from './dto/set-post-visibility.dto';
import { PostStateResponseDto } from './dto/post-state-response.dto';
import { FollowStateResponseDto } from './dto/follow-state-response.dto';
import { RelationshipResponseDto } from './dto/relationship-response.dto';
import { SocialPageQueryDto } from './dto/social-page-query.dto';
import { IdentitySummaryDto } from '../../common/dto/identity-summary.dto';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';

const IDENTITY_PAGE_SCHEMA = {
  schema: {
    properties: {
      items: {
        type: 'array',
        items: { $ref: getSchemaPath(IdentitySummaryDto) },
      },
      nextCursor: { type: 'string', nullable: true },
    },
  },
};

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

  @Put('follows/:userId')
  @ApiOperation({ summary: 'Follow a user' })
  async follow(
    @Req() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<FollowStateResponseDto> {
    return this.socialService.follow(req.user.userId, userId);
  }

  @Delete('follows/:userId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unfollow a user' })
  async unfollow(
    @Req() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<FollowStateResponseDto> {
    return this.socialService.unfollow(req.user.userId, userId);
  }

  @Get('followers')
  @ApiOperation({ summary: 'List the people who follow you, newest first' })
  @ApiExtraModels(IdentitySummaryDto)
  @ApiOkResponse(IDENTITY_PAGE_SCHEMA)
  async listFollowers(
    @Req() req: AuthenticatedRequest,
    @Query() query: SocialPageQueryDto,
  ): Promise<PaginatedResult<IdentitySummaryDto>> {
    return this.socialService.listFollowers(req.user.userId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('following')
  @ApiOperation({ summary: 'List the people you follow, newest first' })
  @ApiExtraModels(IdentitySummaryDto)
  @ApiOkResponse(IDENTITY_PAGE_SCHEMA)
  async listFollowing(
    @Req() req: AuthenticatedRequest,
    @Query() query: SocialPageQueryDto,
  ): Promise<PaginatedResult<IdentitySummaryDto>> {
    return this.socialService.listFollowing(req.user.userId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('users/:userId/relationship')
  @ApiOperation({
    summary: 'Your relationship with another user, and their follow counts',
  })
  async relationship(
    @Req() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<RelationshipResponseDto> {
    return this.socialService.getRelationship(req.user.userId, userId);
  }
}
