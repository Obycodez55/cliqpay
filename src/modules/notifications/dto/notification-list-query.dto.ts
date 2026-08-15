import { Type } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { CursorPaginationQueryDto } from '../../../common/dto/cursor-pagination-query.dto';

export class NotificationListQueryDto extends CursorPaginationQueryDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unread?: boolean;
}
