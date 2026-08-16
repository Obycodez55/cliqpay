import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { User } from './entities/user.entity';
import {
  NoPendingEmailChangeException,
  NoPendingPhoneChangeException,
  UsernameChangeCooldownException,
} from './internal/errors';
import { mapUsersUniqueViolation } from './internal/errors';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  ProfileResponseDto,
  toProfileResponse,
} from './dto/profile-response.dto';
import {
  RecipientLookupResponseDto,
  toRecipientLookupResponse,
} from './dto/recipient-lookup-response.dto';

const USERNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface CreateUserData {
  email: string;
  phone: string;
  username: string;
  firstName: string;
  lastName: string;
}

/**
 * The one exported surface of the users module — see docs/architecture.md
 * §10. Owns identity (`User`): who someone is, not how they authenticate
 * (that's `auth`'s `Credential` — see ADR-0005). `auth` depends on this
 * module; this module depends on nothing else in the app.
 */
@Injectable()
export class UsersService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Takes the caller's own EntityManager — auth.register() creates the
   * User, Credential, MFA method, and wallet atomically in one transaction,
   * same pattern as LedgerService.createUserWallet.
   */
  async createUser(
    manager: EntityManager,
    data: CreateUserData,
  ): Promise<User> {
    const repo = manager.getRepository(User);
    const user = repo.create({
      email: data.email,
      phone: data.phone,
      username: data.username,
      firstName: data.firstName,
      lastName: data.lastName,
      usernameChangedAt: null,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
    });

    try {
      await repo.save(user);
    } catch (error) {
      mapUsersUniqueViolation(error);
    }

    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.dataSource.getRepository(User).findOneBy({ email });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.dataSource.getRepository(User).findOneBy({ username });
  }

  // Exactly one query either way — a hit and a miss run the same
  // findOneBy, so there's no extra join or lookup on the hit path that
  // could show up as a timing difference (see issue #21).
  async lookupRecipient(
    identifier: string,
  ): Promise<RecipientLookupResponseDto | null> {
    const user = identifier.includes('@')
      ? await this.findByEmail(identifier)
      : await this.findByUsername(identifier);
    return user ? toRecipientLookupResponse(user) : null;
  }

  async findById(userId: string): Promise<User> {
    return this.dataSource.getRepository(User).findOneByOrFail({ id: userId });
  }

  // Batch counterpart to findById — feeds transaction-history counterparty
  // resolution (issue #23), where a page of rows can name several distinct
  // users and resolving them one at a time would be an N+1.
  async findByIds(userIds: string[]): Promise<User[]> {
    if (userIds.length === 0) {
      return [];
    }
    return this.dataSource.getRepository(User).findBy({ id: In(userIds) });
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.dataSource
      .getRepository(User)
      .update(userId, { emailVerifiedAt: new Date() });
  }

  async markPhoneVerified(userId: string): Promise<void> {
    await this.dataSource
      .getRepository(User)
      .update(userId, { phoneVerifiedAt: new Date() });
  }

  // Called by AuthService.changeEmail once step-up MFA has been proven —
  // stashes the new address without touching the live `email` (see issue #9).
  async setPendingEmail(userId: string, newEmail: string): Promise<void> {
    await this.dataSource
      .getRepository(User)
      .update(userId, { pendingEmail: newEmail });
  }

  // Called by AuthService.confirmEmailChange once the new address's
  // verification code has been consumed. Insert-and-catch on the unique
  // violation, same race-free pattern as changeUsername — no pre-check
  // findByEmail.
  async confirmPendingEmail(userId: string): Promise<User> {
    const repo = this.dataSource.getRepository(User);
    const user = await repo.findOneByOrFail({ id: userId });
    if (!user.pendingEmail) {
      throw new NoPendingEmailChangeException();
    }

    user.email = user.pendingEmail;
    user.pendingEmail = null;
    user.emailVerifiedAt = new Date();
    try {
      await repo.save(user);
    } catch (error) {
      mapUsersUniqueViolation(error);
    }
    return user;
  }

  // Called by AuthService.changePhone once step-up MFA has been proven —
  // stashes the new number without touching the live `phone` (see issue #10).
  async setPendingPhone(userId: string, newPhone: string): Promise<void> {
    await this.dataSource
      .getRepository(User)
      .update(userId, { pendingPhone: newPhone });
  }

  // Called by AuthService.confirmPhoneChange once the new number's
  // verification code has been consumed. Insert-and-catch on the unique
  // violation, same race-free pattern as confirmPendingEmail.
  async confirmPendingPhone(userId: string): Promise<User> {
    const repo = this.dataSource.getRepository(User);
    const user = await repo.findOneByOrFail({ id: userId });
    if (!user.pendingPhone) {
      throw new NoPendingPhoneChangeException();
    }

    user.phone = user.pendingPhone;
    user.pendingPhone = null;
    user.phoneVerifiedAt = new Date();
    try {
      await repo.save(user);
    } catch (error) {
      mapUsersUniqueViolation(error);
    }
    return user;
  }

  async getProfile(userId: string): Promise<ProfileResponseDto> {
    const user = await this.dataSource
      .getRepository(User)
      .findOneByOrFail({ id: userId });
    return toProfileResponse(user);
  }

  // firstName/lastName update freely (cosmetic, no addressing function).
  private applyNames(
    user: User,
    data: { firstName?: string; lastName?: string },
  ): void {
    if (data.firstName !== undefined) {
      user.firstName = data.firstName;
    }
    if (data.lastName !== undefined) {
      user.lastName = data.lastName;
    }
  }

  // username is a payment-routing address (Phase 3: "send money by username
  // or email") — re-validated and rate-limited to once per 30 days.
  private applyUsernameChange(user: User, newUsername: string): void {
    if (newUsername === user.username) {
      return;
    }
    const now = new Date();
    if (user.usernameChangedAt) {
      const nextAllowedAt = new Date(
        user.usernameChangedAt.getTime() + USERNAME_CHANGE_COOLDOWN_MS,
      );
      if (nextAllowedAt > now) {
        throw new UsernameChangeCooldownException(nextAllowedAt);
      }
    }
    user.username = newUsername;
    user.usernameChangedAt = now;
  }

  async updateNames(
    userId: string,
    data: { firstName?: string; lastName?: string },
  ): Promise<User> {
    const repo = this.dataSource.getRepository(User);
    const user = await repo.findOneByOrFail({ id: userId });
    this.applyNames(user, data);
    await repo.save(user);
    return user;
  }

  async changeUsername(userId: string, newUsername: string): Promise<User> {
    const repo = this.dataSource.getRepository(User);
    const user = await repo.findOneByOrFail({ id: userId });
    this.applyUsernameChange(user, newUsername);
    try {
      await repo.save(user);
    } catch (error) {
      mapUsersUniqueViolation(error);
    }
    return user;
  }

  // Single fetch + single save — firstName/lastName and username apply
  // atomically together, same shape as the pre-split AuthService.updateProfile.
  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<ProfileResponseDto> {
    const repo = this.dataSource.getRepository(User);
    const user = await repo.findOneByOrFail({ id: userId });

    this.applyNames(user, { firstName: dto.firstName, lastName: dto.lastName });
    if (dto.username !== undefined) {
      this.applyUsernameChange(user, dto.username);
    }

    try {
      await repo.save(user);
    } catch (error) {
      mapUsersUniqueViolation(error);
    }

    return toProfileResponse(user);
  }
}
