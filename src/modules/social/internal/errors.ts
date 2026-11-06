import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/exceptions/domain.exception';

export class PostNotFoundException extends DomainException {
  readonly code = 'POST_NOT_FOUND';
  constructor() {
    super('Post not found', HttpStatus.NOT_FOUND);
  }
}

export class SocialKycRequiredException extends DomainException {
  readonly code = 'KYC_VERIFICATION_REQUIRED';
  constructor() {
    super(
      'Verify your BVN or NIN to follow people and use the social feed.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class SelfFollowException extends DomainException {
  readonly code = 'SELF_FOLLOW_NOT_ALLOWED';
  constructor() {
    super("You can't follow yourself", HttpStatus.BAD_REQUEST);
  }
}

export class SocialUserNotFoundException extends DomainException {
  readonly code = 'USER_NOT_FOUND';
  constructor() {
    super('User not found', HttpStatus.NOT_FOUND);
  }
}

export class FollowLimitReachedException extends DomainException {
  readonly code = 'FOLLOW_LIMIT_REACHED';
  readonly details: { limit: number };
  constructor(limit: number) {
    super(
      `You can follow at most ${limit.toLocaleString('en-US')} people. Unfollow someone to follow someone new.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    this.details = { limit };
  }
}
