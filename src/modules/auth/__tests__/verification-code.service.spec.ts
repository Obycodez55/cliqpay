import { DataSource } from 'typeorm';
import { VerificationCodeService } from '../verification-code.service';
import { VerificationCode } from '../entities/verification-code.entity';
import {
  VerificationCodeInvalidException,
  VerificationCodeRateLimitedException,
} from '../internal/errors';

interface FakeRepo {
  create: jest.Mock<VerificationCode, [Partial<VerificationCode>]>;
  save: jest.Mock<Promise<VerificationCode>, [VerificationCode]>;
  find: jest.Mock<Promise<VerificationCode[]>, unknown[]>;
  findOneBy: jest.Mock<Promise<VerificationCode | null>, unknown[]>;
}

function buildRecord(
  overrides: Partial<VerificationCode> = {},
): VerificationCode {
  return Object.assign(new VerificationCode(), {
    id: 'code-1',
    userId: 'user-1',
    purpose: 'email_verification',
    codeHash: 'hash',
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  });
}

describe('VerificationCodeService', () => {
  let repo: FakeRepo;
  let dataSource: { getRepository: jest.Mock<FakeRepo, unknown[]> };
  let service: VerificationCodeService;

  beforeEach(() => {
    repo = {
      create: jest.fn((data: Partial<VerificationCode>) =>
        Object.assign(new VerificationCode(), {
          id: 'new-code',
          createdAt: new Date(),
          ...data,
        }),
      ),
      save: jest.fn((entity: VerificationCode) => Promise.resolve(entity)),
      find: jest.fn(() => Promise.resolve([])),
      findOneBy: jest.fn(() => Promise.resolve(null)),
    };
    dataSource = { getRepository: jest.fn(() => repo) };
    service = new VerificationCodeService(dataSource as unknown as DataSource);
  });

  describe('issue', () => {
    it('creates a hashed, expiring record and returns the raw token, with no rate-limit check', async () => {
      const { token, expiresAt } = await service.issue(
        'user-1',
        'email_verification',
        60_000,
      );

      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(20);
      const saved = repo.save.mock.calls[0][0];
      expect(saved.codeHash).not.toBe(token);
      expect(saved.userId).toBe('user-1');
      expect(saved.purpose).toBe('email_verification');
      expect(saved.usedAt).toBeNull();
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(repo.find).not.toHaveBeenCalled();
    });
  });

  describe('assertResendAllowed', () => {
    it('passes silently when no prior code has been issued', async () => {
      await expect(
        service.assertResendAllowed('user-1', 'email_verification'),
      ).resolves.toBeUndefined();
    });

    it('rejects a resend within the 60s cooldown of the last issued code', async () => {
      repo.find.mockResolvedValueOnce([buildRecord({ createdAt: new Date() })]);

      await expect(
        service.assertResendAllowed('user-1', 'email_verification'),
      ).rejects.toBeInstanceOf(VerificationCodeRateLimitedException);
    });

    it('allows a resend once the cooldown has passed', async () => {
      repo.find.mockResolvedValueOnce([
        buildRecord({ createdAt: new Date(Date.now() - 61_000) }),
      ]);

      await expect(
        service.assertResendAllowed('user-1', 'email_verification'),
      ).resolves.toBeUndefined();
    });

    it('rejects a 6th send within the same hour even outside the cooldown', async () => {
      const now = Date.now();
      repo.find.mockResolvedValueOnce(
        Array.from({ length: 5 }, (_, i) =>
          buildRecord({
            id: `code-${i}`,
            createdAt: new Date(now - (61_000 + i * 1000)),
          }),
        ),
      );

      await expect(
        service.assertResendAllowed('user-1', 'email_verification'),
      ).rejects.toBeInstanceOf(VerificationCodeRateLimitedException);
    });
  });

  describe('consume', () => {
    it('marks a valid record used and returns its userId', async () => {
      const record = buildRecord();
      repo.findOneBy.mockResolvedValueOnce(record);

      const result = await service.consume('email_verification', 'raw-token');

      expect(result.userId).toBe('user-1');
      const saved = repo.save.mock.calls[0][0];
      expect(saved.usedAt).toBeInstanceOf(Date);
    });

    it('rejects an unknown token', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);

      await expect(
        service.consume('email_verification', 'never-issued'),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidException);
    });

    it('rejects an expired token', async () => {
      repo.findOneBy.mockResolvedValueOnce(
        buildRecord({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        service.consume('email_verification', 'expired'),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidException);
    });

    it('rejects an already-used token', async () => {
      repo.findOneBy.mockResolvedValueOnce(buildRecord({ usedAt: new Date() }));

      await expect(
        service.consume('email_verification', 'reused'),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidException);
    });
  });
});
