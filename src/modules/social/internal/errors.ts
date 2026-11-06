import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class PostNotFoundException extends DomainException {
  readonly code = 'POST_NOT_FOUND';
  constructor() {
    super('Post not found', HttpStatus.NOT_FOUND);
  }
}
