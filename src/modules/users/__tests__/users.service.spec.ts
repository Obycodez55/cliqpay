import { DataSource, EntityManager } from 'typeorm';
import { UsersService } from '../users.service';
import { User } from '../entities/user.entity';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import {
  EmailAlreadyRegisteredException,
  PhoneAlreadyRegisteredException,
  UsernameAlreadyTakenException,
  UsernameChangeCooldownException,
} from '../internal/errors';

function buildUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: 'user-1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: 'ada_l',
    usernameChangedAt: null,
    phone: '+2348012345678',
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
}

// TypeORM's real Repository.create/save are heavily overloaded (single vs
// array args) — jest.Mocked<Pick<Repository<T>, ...>> can't satisfy every
// overload with one mock implementation, so this only models the one
// signature UsersService actually calls.
interface FakeUserRepo {
  create: jest.Mock<User, [Partial<User>]>;
  save: jest.Mock<Promise<User>, [User]>;
  findOneByOrFail: jest.Mock<Promise<User>, [Partial<User>]>;
  findOneBy: jest.Mock<Promise<User | null>, [Partial<User>]>;
  update: jest.Mock<Promise<unknown>, [unknown, Partial<User>]>;
}

describe('UsersService', () => {
  let userRepo: FakeUserRepo;
  let manager: { getRepository: jest.Mock<FakeUserRepo, unknown[]> };
  let dataSource: { getRepository: jest.Mock<FakeUserRepo, unknown[]> };
  let service: UsersService;
  let audit: { record: jest.Mock };

  beforeEach(() => {
    userRepo = {
      create: jest.fn(
        (data: Partial<User>) => ({ id: 'user-1', ...data }) as User,
      ),
      save: jest.fn((entity: User) => Promise.resolve(entity)),
      findOneByOrFail: jest.fn((_where: Partial<User>) =>
        Promise.resolve(buildUser()),
      ),
      findOneBy: jest.fn((_where: Partial<User>) =>
        Promise.resolve(buildUser()),
      ),
      update: jest.fn((_id: string, _fields: Partial<User>) =>
        Promise.resolve(),
      ),
    };
    manager = { getRepository: jest.fn(() => userRepo) };
    dataSource = { getRepository: jest.fn(() => userRepo) };
    audit = { record: jest.fn() };
    service = new UsersService(dataSource as unknown as DataSource, audit);
  });

  describe('startSecurityCooldown', () => {
    const NOW = new Date('2026-11-10T12:00:00.000Z');
    const HOUR = 60 * 60 * 1000;
    const actor = { type: 'user' as const, id: 'user-1' };
    const start = () =>
      service.startSecurityCooldown(
        manager as unknown as EntityManager,
        'user-1',
        'password_reset',
        actor,
      );
    const lastUpdate = () =>
      userRepo.update.mock.calls[userRepo.update.mock.calls.length - 1][1];

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(NOW);
      (manager as { query?: jest.Mock }).query = jest.fn();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('starts a 24 hour cooldown and audits it', async () => {
      await start();

      expect(lastUpdate()).toEqual({
        securityCooldownUntil: new Date(NOW.getTime() + 24 * HOUR),
        securityCooldownStartedAt: NOW,
      });
      expect(audit.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          action: 'security_cooldown_started',
          metadata: expect.objectContaining({
            trigger: 'password_reset',
          }) as unknown,
        }),
      );
    });

    it('extends an active cooldown and keeps its start', async () => {
      const startedAt = new Date(NOW.getTime() - 10 * HOUR);
      userRepo.findOneByOrFail.mockResolvedValue(
        buildUser({
          securityCooldownUntil: new Date(NOW.getTime() + 14 * HOUR),
          securityCooldownStartedAt: startedAt,
        }),
      );

      await start();

      expect(lastUpdate()).toEqual({
        securityCooldownUntil: new Date(NOW.getTime() + 24 * HOUR),
        securityCooldownStartedAt: startedAt,
      });
    });

    it('never shortens a cooldown that already ends later', async () => {
      const until = new Date(NOW.getTime() + 30 * HOUR);
      userRepo.findOneByOrFail.mockResolvedValue(
        buildUser({
          securityCooldownUntil: until,
          securityCooldownStartedAt: NOW,
        }),
      );

      await start();

      expect(lastUpdate().securityCooldownUntil).toEqual(until);
    });

    it('begins a new window once the previous cooldown has ended', async () => {
      userRepo.findOneByOrFail.mockResolvedValue(
        buildUser({
          securityCooldownUntil: new Date(NOW.getTime() - HOUR),
          securityCooldownStartedAt: new Date(NOW.getTime() - 25 * HOUR),
        }),
      );

      await start();

      expect(lastUpdate().securityCooldownStartedAt).toEqual(NOW);
    });
  });

  describe('createUser', () => {
    const createData = {
      email: 'ada@example.com',
      phone: '+2348012345678',
      username: 'ada_l',
      firstName: 'Ada',
      lastName: 'Lovelace',
    };

    it('creates a user with no credential fields', async () => {
      const user = await service.createUser(
        manager as unknown as EntityManager,
        createData,
      );

      expect(userRepo.create).toHaveBeenCalledWith(
        expect.objectContaining(createData),
      );
      expect(userRepo.save).toHaveBeenCalled();
      expect(user.id).toBe('user-1');
    });

    it.each([
      ['UQ_users_email', EmailAlreadyRegisteredException],
      ['UQ_users_username', UsernameAlreadyTakenException],
      ['UQ_users_phone', PhoneAlreadyRegisteredException],
    ] as const)(
      'maps a %s unique violation to its specific domain exception',
      async (constraint, ExpectedException) => {
        userRepo.save.mockRejectedValueOnce(
          Object.assign(new Error('duplicate key value'), {
            code: '23505',
            constraint,
          }),
        );

        await expect(
          service.createUser(manager as unknown as EntityManager, createData),
        ).rejects.toBeInstanceOf(ExpectedException);
      },
    );

    it('propagates a non-unique-violation error unchanged', async () => {
      const boom = new Error('connection lost');
      userRepo.save.mockRejectedValueOnce(boom);

      await expect(
        service.createUser(manager as unknown as EntityManager, createData),
      ).rejects.toBe(boom);
    });
  });

  describe('getProfile', () => {
    it('returns name, email/phone verification status, and username — no mfaMethods (see ADR-0005)', async () => {
      userRepo.findOneByOrFail.mockResolvedValueOnce(
        buildUser({ emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z') }),
      );

      const profile = await service.getProfile('user-1');

      expect(profile).toEqual({
        id: 'user-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
        phone: '+2348012345678',
        phoneVerifiedAt: null,
        username: 'ada_l',
      });
    });
  });

  describe('lookupRecipient', () => {
    it('resolves by email and returns only userId/username/firstName/lastName', async () => {
      userRepo.findOneBy.mockResolvedValueOnce(buildUser());

      const result = await service.lookupRecipient('ada@example.com');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({
        email: 'ada@example.com',
      });
      expect(result).toEqual({
        userId: 'user-1',
        username: 'ada_l',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
    });

    it('resolves by username when the identifier has no @', async () => {
      userRepo.findOneBy.mockResolvedValueOnce(buildUser());

      const result = await service.lookupRecipient('ada_l');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ username: 'ada_l' });
      expect(result).toEqual({
        userId: 'user-1',
        username: 'ada_l',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
    });

    it('returns null on a miss, via the same single-query shape as a hit', async () => {
      userRepo.findOneBy.mockResolvedValueOnce(null);

      const result = await service.lookupRecipient('nobody@example.com');

      expect(result).toBeNull();
      expect(userRepo.findOneBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateProfile', () => {
    it('updates firstName/lastName with no cooldown or restriction', async () => {
      const dto = Object.assign(new UpdateProfileDto(), {
        firstName: 'Grace',
        lastName: 'Hopper',
      });

      const profile = await service.updateProfile('user-1', dto);

      expect(profile.firstName).toBe('Grace');
      expect(profile.lastName).toBe('Hopper');
      const saved = userRepo.save.mock.calls[0][0];
      expect(saved.usernameChangedAt).toBeNull();
    });

    it('changes the username and stamps usernameChangedAt when never changed before', async () => {
      const dto = Object.assign(new UpdateProfileDto(), {
        username: 'grace_h',
      });

      const profile = await service.updateProfile('user-1', dto);

      expect(profile.username).toBe('grace_h');
      const saved = userRepo.save.mock.calls[0][0];
      expect(saved.usernameChangedAt).toBeInstanceOf(Date);
    });

    it('rejects a second username change within 30 days of the last one', async () => {
      const changedNineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
      userRepo.findOneByOrFail.mockResolvedValueOnce(
        buildUser({ usernameChangedAt: changedNineDaysAgo }),
      );
      const dto = Object.assign(new UpdateProfileDto(), {
        username: 'grace_h',
      });

      await expect(service.updateProfile('user-1', dto)).rejects.toBeInstanceOf(
        UsernameChangeCooldownException,
      );
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('allows a username change once 30 days have passed since the last one', async () => {
      const changedThirtyOneDaysAgo = new Date(
        Date.now() - 31 * 24 * 60 * 60 * 1000,
      );
      userRepo.findOneByOrFail.mockResolvedValueOnce(
        buildUser({ usernameChangedAt: changedThirtyOneDaysAgo }),
      );
      const dto = Object.assign(new UpdateProfileDto(), {
        username: 'grace_h',
      });

      const profile = await service.updateProfile('user-1', dto);

      expect(profile.username).toBe('grace_h');
    });

    it('does not touch usernameChangedAt or run the cooldown check when the username is unchanged', async () => {
      const changedNineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
      userRepo.findOneByOrFail.mockResolvedValueOnce(
        buildUser({ usernameChangedAt: changedNineDaysAgo, username: 'ada_l' }),
      );
      const dto = Object.assign(new UpdateProfileDto(), {
        username: 'ada_l',
      });

      const profile = await service.updateProfile('user-1', dto);

      expect(profile.username).toBe('ada_l');
      const saved = userRepo.save.mock.calls[0][0];
      expect(saved.usernameChangedAt).toBe(changedNineDaysAgo);
    });

    it('maps a UQ_users_username violation to UsernameAlreadyTakenException', async () => {
      userRepo.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value'), {
          code: '23505',
          constraint: 'UQ_users_username',
        }),
      );
      const dto = Object.assign(new UpdateProfileDto(), {
        username: 'taken_name',
      });

      await expect(service.updateProfile('user-1', dto)).rejects.toBeInstanceOf(
        UsernameAlreadyTakenException,
      );
    });
  });
});
