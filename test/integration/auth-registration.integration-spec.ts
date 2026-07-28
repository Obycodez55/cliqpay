import * as bcrypt from 'bcrypt';
import { seedSystemAccounts } from '../../src/database/seed-system-accounts';
import {
  EmailAlreadyRegisteredException,
  PhoneAlreadyRegisteredException,
  UsernameAlreadyTakenException,
} from '../../src/modules/users/internal/errors';
import {
  AuthTestContext,
  createAuthTestContext,
  destroyAuthTestContext,
} from './support/auth-test-context';
import { registerPayload } from './support/auth-test-helpers';

jest.setTimeout(120_000);

describe('Auth module — registration against a real Postgres', () => {
  let ctx: AuthTestContext;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  it('creates the user and a matching zero-balance NGN wallet atomically', async () => {
    const response = await ctx.authService.register(
      registerPayload({ username: 'AdaLovelace' }),
    );

    const user = await ctx.userRepo.findOneByOrFail({ id: response.user.id });
    expect(user.email).toBe('ada@example.com');
    expect(user.username).toBe('adalovelace');
    expect(user.phone).toBe('+2348012345678');

    const credential = await ctx.credentialRepo.findOneByOrFail({
      userId: user.id,
    });
    await expect(
      bcrypt.compare('a-strong-unique-passphrase', credential.passwordHash),
    ).resolves.toBe(true);
    expect(credential.transactionPinHash).toBeNull();

    const wallet = await ctx.accountRepo.findOneByOrFail({
      userId: user.id,
      role: 'user_wallet',
    });
    expect(wallet.type).toBe('liability');
    expect(wallet.provider).toBeNull();
    expect(wallet.currency).toBe('NGN');
    expect(wallet.balance).toBe(0n);

    expect(response.wallet.balance).toEqual({ amount: '0', currency: 'NGN' });
    expect(JSON.stringify(response)).not.toContain(credential.passwordHash);

    // Auto-enrolled on register, no separate call.
    const emailMethod = await ctx.mfaMethodRepo.findOneByOrFail({
      userId: user.id,
      type: 'email',
    });
    expect(emailMethod.status).toBe('active');
    expect(emailMethod.secretCiphertext).toBeNull();
  });

  it('rejects a duplicate email and leaves no extra rows', async () => {
    await ctx.authService.register(
      registerPayload({
        email: 'dup-email@example.com',
        username: 'dup_email_1',
        phone: '+2348011111111',
      }),
    );

    await expect(
      ctx.authService.register(
        registerPayload({
          email: 'dup-email@example.com',
          username: 'dup_email_2',
          phone: '+2348011111112',
        }),
      ),
    ).rejects.toBeInstanceOf(EmailAlreadyRegisteredException);

    expect(await ctx.userRepo.countBy({ email: 'dup-email@example.com' })).toBe(
      1,
    );
  });

  it('rejects a duplicate username regardless of case', async () => {
    await ctx.authService.register(
      registerPayload({
        email: 'user-a@example.com',
        username: 'dupuser',
        phone: '+2348022222221',
      }),
    );

    await expect(
      ctx.authService.register(
        registerPayload({
          email: 'user-b@example.com',
          username: 'DupUser',
          phone: '+2348022222222',
        }),
      ),
    ).rejects.toBeInstanceOf(UsernameAlreadyTakenException);

    expect(await ctx.userRepo.countBy({ username: 'dupuser' })).toBe(1);
  });

  it('rejects a duplicate phone and leaves no extra rows', async () => {
    await ctx.authService.register(
      registerPayload({
        email: 'phone-a@example.com',
        username: 'phone_user_a',
        phone: '+2348033333333',
      }),
    );

    await expect(
      ctx.authService.register(
        registerPayload({
          email: 'phone-b@example.com',
          username: 'phone_user_b',
          phone: '+2348033333333',
        }),
      ),
    ).rejects.toBeInstanceOf(PhoneAlreadyRegisteredException);

    expect(await ctx.userRepo.countBy({ phone: '+2348033333333' })).toBe(1);
  });

  it('seeds NGN system accounts via migration, idempotently', async () => {
    const float = await ctx.accountRepo.findOneByOrFail({
      role: 'float',
      currency: 'NGN',
    });
    expect(float.type).toBe('asset');
    expect(float.provider).toBe('kora');
    expect(float.userId).toBeNull();

    const feeIncome = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_income',
      currency: 'NGN',
    });
    expect(feeIncome.type).toBe('equity');
    expect(feeIncome.provider).toBeNull();

    const beforeCount = await ctx.accountRepo.countBy({
      role: 'float',
      currency: 'NGN',
    });
    const queryRunner = ctx.dataSource.createQueryRunner();
    await seedSystemAccounts(queryRunner, 'NGN');
    await queryRunner.release();
    const afterCount = await ctx.accountRepo.countBy({
      role: 'float',
      currency: 'NGN',
    });

    expect(afterCount).toBe(beforeCount);
    expect(afterCount).toBe(1);
  });
});
