import {
  Body,
  Controller,
  Get,
  Post,
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
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import { NotificationService } from './notification.service';
import { NotificationListQueryDto } from './dto/notification-list-query.dto';
import { NotificationItemDto } from './dto/notification-item.dto';
import { MarkNotificationsReadDto } from './dto/mark-notifications-read.dto';
import { UnreadCountResponseDto } from './dto/unread-count-response.dto';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @ApiOperation({ summary: "List the current user's notifications" })
  @ApiExtraModels(NotificationItemDto)
  @ApiOkResponse({
    schema: {
      properties: {
        items: {
          type: 'array',
          items: { $ref: getSchemaPath(NotificationItemDto) },
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() query: NotificationListQueryDto,
  ): Promise<PaginatedResult<NotificationItemDto>> {
    return this.notificationService.listNotifications(req.user.userId, {
      cursor: query.cursor,
      limit: query.limit,
      unreadOnly: query.unread,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: "Get the current user's unread notification count" })
  async unreadCount(
    @Req() req: AuthenticatedRequest,
  ): Promise<UnreadCountResponseDto> {
    const count = await this.notificationService.getUnreadCount(
      req.user.userId,
    );
    return { count };
  }

  @Post('read')
  @ApiOperation({ summary: 'Mark notifications as read' })
  async markRead(
    @Req() req: AuthenticatedRequest,
    @Body() dto: MarkNotificationsReadDto,
  ): Promise<void> {
    await this.notificationService.markRead(req.user.userId, {
      ids: dto.ids,
      all: dto.all,
    });
  }
}
