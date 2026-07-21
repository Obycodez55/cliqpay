import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { runInTransaction } from '../../database/transaction.util';
import {
  SECURITY_ALERT_EVENT,
  SecurityAlertEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { LedgerService } from '../ledger/ledger.service';
import { Session } from './entities/session.entity';
import { User } from './entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import {
  RegisterResponseDto,
  toRegisterResponse,
} from './dto/register-response.dto';
import {
  TokenPairResponseDto,
  toTokenPairResponse,
} from './dto/token-pair-response.dto';
import {
  AccountLockedException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  SessionRevokedException,
  mapUsersUniqueViolation,
} from './internal/errors';
import {
  generateRefreshToken,
  hashRefreshToken,
} from './internal/refresh-token.util';

const BCRYPT_SALT_ROUNDS = 10;
const DEFAULT_WALLET_CURRENCY = 'NGN';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_FAILED_LOGIN_ATTEMPTS = 5; // 5 failed login attempts
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * The one exported surface of the auth module — see docs/architecture.md
 * §10. MFA (issue #4) is a later slice; this covers registration, login,
 * session rotation/revocation, and lockout only.
 */
@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledgerService: LedgerService,
    private readonly jwtService: JwtService,
    private readonly eventBus: EventBusService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    const { user, wallet } = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const userRepo = manager.getRepository(User);
        const user = userRepo.create({
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          username: dto.username,
          phone: dto.phone,
        });

        try {
          await userRepo.save(user);
        } catch (error) {
          mapUsersUniqueViolation(error);
        }

        const wallet = await this.ledgerService.createUserWallet(
          manager,
          user.id,
          DEFAULT_WALLET_CURRENCY,
        );

        return { user, wallet };
      },
    );

    return toRegisterResponse(user, wallet);
  }

  async login(dto: LoginDto): Promise<TokenPairResponseDto> {
    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOneBy({ email: dto.email });
    if (!user) {
      throw new InvalidCredentialsException();
    }

    const now = new Date();
    if (user.lockedUntil) {
      if (user.lockedUntil > now) {
        throw new AccountLockedException(user.lockedUntil);
      }
      // Lockout window has passed — this attempt gets a fresh count rather
      // than instantly re-locking on one more wrong guess.
      user.lockedUntil = null;
      user.failedLoginAttempts = 0;
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        user.lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
      }
      await userRepo.save(user);
      throw new InvalidCredentialsException();
    }

    user.failedLoginAttempts = 0;
    user.lockedUntil = null;

    const refreshToken = generateRefreshToken();
    const session = await runInTransaction(this.dataSource, async (manager) => {
      await manager.getRepository(User).save(user);

      const sessionRepo = manager.getRepository(Session);
      const session = sessionRepo.create({
        userId: user.id,
        currentTokenHash: hashRefreshToken(refreshToken),
        previousTokenHash: null,
        status: 'active',
        trustedDeviceId: null,
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
        lastUsedAt: now,
      });
      return sessionRepo.save(session);
    });

    const accessToken = await this.signAccessToken(user.id, session.id);
    return toTokenPairResponse(
      accessToken,
      refreshToken,
      ACCESS_TOKEN_TTL_SECONDS,
    );
  }

  async refresh(dto: RefreshDto): Promise<TokenPairResponseDto> {
    const hash = hashRefreshToken(dto.refreshToken);
    const sessionRepo = this.dataSource.getRepository(Session);

    const currentMatch = await sessionRepo.findOneBy({
      currentTokenHash: hash,
    });
    if (!currentMatch) {
      // A previous-generation token being replayed after the legitimate
      // client already rotated past it is a theft signal — see
      // docs/architecture.md §3.7.
      const previousMatch = await sessionRepo.findOne({
        where: { previousTokenHash: hash },
        relations: { user: true },
      });
      if (previousMatch) {
        previousMatch.status = 'revoked';
        await sessionRepo.save(previousMatch);

        // Published after the revoke above has committed, per
        // EventBusService's own rule — auth (core) can't call
        // NotificationService (peripheral) directly, so this goes through
        // the shared event bus; notifications' existing fire-and-forget
        // processor picks it up by job name.
        await this.eventBus.publish<string, SecurityAlertEventPayload>({
          name: SECURITY_ALERT_EVENT,
          payload: {
            userId: previousMatch.userId,
            email: previousMatch.user!.email,
            message:
              'We detected an already-used refresh token being replayed and revoked the affected session for your protection. If this wasn’t you, please change your password.',
          },
          occurredAt: new Date(),
        });

        throw new SessionRevokedException();
      }
      throw new InvalidRefreshTokenException();
    }

    const now = new Date();
    if (currentMatch.status !== 'active' || currentMatch.expiresAt <= now) {
      throw new InvalidRefreshTokenException();
    }

    const newRefreshToken = generateRefreshToken();
    currentMatch.previousTokenHash = currentMatch.currentTokenHash;
    currentMatch.currentTokenHash = hashRefreshToken(newRefreshToken);
    currentMatch.lastUsedAt = now;
    currentMatch.expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
    await sessionRepo.save(currentMatch);

    const accessToken = await this.signAccessToken(
      currentMatch.userId,
      currentMatch.id,
    );
    return toTokenPairResponse(
      accessToken,
      newRefreshToken,
      ACCESS_TOKEN_TTL_SECONDS,
    );
  }

  async logout(dto: LogoutDto): Promise<void> {
    const hash = hashRefreshToken(dto.refreshToken);
    const sessionRepo = this.dataSource.getRepository(Session);

    const session = await sessionRepo.findOneBy({
      currentTokenHash: hash,
      status: 'active',
    });
    if (!session) {
      throw new InvalidRefreshTokenException();
    }

    session.status = 'revoked';
    await sessionRepo.save(session);
  }

  private signAccessToken(userId: string, sessionId: string): Promise<string> {
    return this.jwtService.signAsync(
      { sub: userId, sid: sessionId },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );
  }
}
