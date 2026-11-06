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

export class SelfRelationshipException extends DomainException {
  readonly code = 'SELF_RELATIONSHIP_NOT_ALLOWED';
  constructor() {
    super(
      "You can't look up a relationship with yourself",
      HttpStatus.BAD_REQUEST,
    );
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

export class SelfBlockException extends DomainException {
  readonly code = 'SELF_BLOCK_NOT_ALLOWED';
  constructor() {
    super("You can't block yourself", HttpStatus.BAD_REQUEST);
  }
}

export class FollowRequiresUnblockException extends DomainException {
  readonly code = 'FOLLOW_REQUIRES_UNBLOCK';
  constructor() {
    super(
      "You've blocked this user. Unblock them first to follow them.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class CommentNotFoundException extends DomainException {
  readonly code = 'COMMENT_NOT_FOUND';
  constructor() {
    super('Comment not found', HttpStatus.NOT_FOUND);
  }
}

export class InteractionUnavailableException extends DomainException {
  readonly code = 'INTERACTION_UNAVAILABLE';
  constructor() {
    super(
      "This action isn't available for this user.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
