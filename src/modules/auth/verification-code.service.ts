import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  VerificationCode,
  VerificationPurpose,
} from './entities/verification-code.entity';
import {
  VerificationCodeInvalidException,
  VerificationCodeRateLimitedException,
} from './internal/errors';
import { generateOpaqueToken, hashOpaqueToken } from './internal/secrets.util';

const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
export const MAX_SENDS_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Internal to the auth module — not exported from AuthModule. Shared
// create/verify/rate-limit logic across every VerificationCode purpose.
@Injectable()
export class VerificationCodeService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async issue(
    userId: string,
    purpose: VerificationPurpose,
    ttlMs: number,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = generateOpaqueToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const repo = this.dataSource.getRepository(VerificationCode);
    const record = repo.create({
      userId,
      purpose,
      codeHash: hashOpaqueToken(token),
      expiresAt,
      usedAt: null,
    });
    await repo.save(record);
    return { token, expiresAt };
  }

  async consume(
    purpose: VerificationPurpose,
    token: string,
  ): Promise<{ userId: string }> {
    const repo = this.dataSource.getRepository(VerificationCode);
    const record = await repo.findOneBy({
      purpose,
      codeHash: hashOpaqueToken(token),
    });

    const now = new Date();
    if (!record || record.usedAt || record.expiresAt <= now) {
      throw new VerificationCodeInvalidException();
    }

    record.usedAt = now;
    await repo.save(record);
    return { userId: record.userId };
  }

  // Called by the resend path only, not by `issue()` itself — the automatic
  // send at registration has nothing to rate-limit against yet.
  async assertResendAllowed(
    userId: string,
    purpose: VerificationPurpose,
  ): Promise<void> {
    const repo = this.dataSource.getRepository(VerificationCode);
    const recent = await repo.find({
      where: { userId, purpose },
      order: { createdAt: 'DESC' },
      take: MAX_SENDS_PER_HOUR,
    });
    if (recent.length === 0) {
      return;
    }

    const now = new Date();
    const sinceLast = now.getTime() - recent[0].createdAt.getTime();
    if (sinceLast < RESEND_COOLDOWN_MS) {
      throw new VerificationCodeRateLimitedException(
        Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000),
      );
    }

    const withinWindow = recent.filter(
      (record) =>
        now.getTime() - record.createdAt.getTime() < RATE_LIMIT_WINDOW_MS,
    );
    if (withinWindow.length >= MAX_SENDS_PER_HOUR) {
      const oldest = withinWindow[withinWindow.length - 1];
      const retryAfterMs =
        RATE_LIMIT_WINDOW_MS - (now.getTime() - oldest.createdAt.getTime());
      throw new VerificationCodeRateLimitedException(
        Math.ceil(retryAfterMs / 1000),
      );
    }
  }
}
