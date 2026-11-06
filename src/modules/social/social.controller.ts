import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { PerUserThrottlerGuard } from '../../common/guards/per-user-throttler.guard';
import { SocialService } from './social.service';
import { SetPostVisibilityDto } from './dto/set-post-visibility.dto';
import { PostStateResponseDto } from './dto/post-state-response.dto';
import { FollowStateResponseDto } from './dto/follow-state-response.dto';
import { BlockStateResponseDto } from './dto/block-state-response.dto';
import { RelationshipResponseDto } from './dto/relationship-response.dto';
import { SocialPageQueryDto } from './dto/social-page-query.dto';
import {
  FeedPostResponseDto,
  PostResponseDto,
} from './dto/feed-post-response.dto';
import { SetReactionDto } from './dto/set-reaction.dto';
import { ReactionStateResponseDto } from './dto/reaction-state-response.dto';
import { AddCommentDto } from './dto/add-comment.dto';
import { CommentResponseDto } from './dto/comment-response.dto';
import { IdentitySummaryDto } from '../../common/dto/identity-summary.dto';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';

const COMMENT_RATE_LIMIT = 10;
const COMMENT_RATE_TTL_MS = 60_000;

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

  @Get('feed')
  @ApiOperation({
    summary:
      'Public posts involving you or people you follow, newest first. Never includes amounts.',
  })
  @ApiExtraModels(FeedPostResponseDto)
  @ApiOkResponse({
    schema: {
      properties: {
        items: {
          type: 'array',
          items: { $ref: getSchemaPath(FeedPostResponseDto) },
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  async feed(
    @Req() req: AuthenticatedRequest,
    @Query() query: SocialPageQueryDto,
  ): Promise<PaginatedResult<FeedPostResponseDto>> {
    return this.socialService.getFeed(req.user.userId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('posts/:transactionId')
  @ApiOperation({ summary: 'A single post you can see' })
  async post(
    @Req() req: AuthenticatedRequest,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<PostResponseDto> {
    return this.socialService.getPost(req.user.userId, transactionId);
  }

  @Put('posts/:transactionId/reaction')
  @ApiOperation({
    summary: 'Set or replace your reaction on a post you can see',
  })
  async setReaction(
    @Req() req: AuthenticatedRequest,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @Body() dto: SetReactionDto,
  ): Promise<ReactionStateResponseDto> {
    return this.socialService.setReaction(
      req.user.userId,
      transactionId,
      dto.reaction,
    );
  }

  @Delete('posts/:transactionId/reaction')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove your reaction from a post you can see' })
  async removeReaction(
    @Req() req: AuthenticatedRequest,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<ReactionStateResponseDto> {
    return this.socialService.removeReaction(req.user.userId, transactionId);
  }

  @Post('posts/:transactionId/comments')
  @UseGuards(PerUserThrottlerGuard(COMMENT_RATE_LIMIT, COMMENT_RATE_TTL_MS))
  @ApiOperation({ summary: 'Comment on a post you can see' })
  async addComment(
    @Req() req: AuthenticatedRequest,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @Body() dto: AddCommentDto,
  ): Promise<CommentResponseDto> {
    return this.socialService.addComment(
      req.user.userId,
      transactionId,
      dto.body,
    );
  }

  @Get('posts/:transactionId/comments')
  @ApiOperation({
    summary: 'Comments on a post you can see, oldest first, 20 per page',
  })
  @ApiExtraModels(CommentResponseDto)
  @ApiOkResponse({
    schema: {
      properties: {
        items: {
          type: 'array',
          items: { $ref: getSchemaPath(CommentResponseDto) },
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  async listComments(
    @Req() req: AuthenticatedRequest,
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
    @Query('cursor') cursor?: string,
  ): Promise<PaginatedResult<CommentResponseDto>> {
    return this.socialService.listComments(
      req.user.userId,
      transactionId,
      cursor,
    );
  }

  @Delete('comments/:commentId')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Delete a comment you wrote, or any comment on a post you are part of',
  })
  async deleteComment(
    @Req() req: AuthenticatedRequest,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ): Promise<void> {
    await this.socialService.deleteComment(req.user.userId, commentId);
  }

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

  @Put('blocks/:userId')
  @ApiOperation({ summary: 'Block a user' })
  async block(
    @Req() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<BlockStateResponseDto> {
    return this.socialService.block(req.user.userId, userId);
  }

  @Delete('blocks/:userId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unblock a user' })
  async unblock(
    @Req() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<BlockStateResponseDto> {
    return this.socialService.unblock(req.user.userId, userId);
  }

  @Get('blocks')
  @ApiOperation({ summary: 'List the people you have blocked, newest first' })
  @ApiExtraModels(IdentitySummaryDto)
  @ApiOkResponse(IDENTITY_PAGE_SCHEMA)
  async listBlocks(
    @Req() req: AuthenticatedRequest,
    @Query() query: SocialPageQueryDto,
  ): Promise<PaginatedResult<IdentitySummaryDto>> {
    return this.socialService.listBlocks(req.user.userId, {
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
