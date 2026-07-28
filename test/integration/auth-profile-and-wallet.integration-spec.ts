import * as request from 'supertest';
import { ProfileResponseDto } from '../../src/modules/users/dto/profile-response.dto';
import { WalletBalanceResponseDto } from '../../src/modules/ledger/dto/wallet-balance-response.dto';
import {
  AuthTestContext,
  createAuthTestContext,
  destroyAuthTestContext,
} from './support/auth-test-context';
import { createAuthTestHelpers } from './support/auth-test-helpers';

jest.setTimeout(120_000);

describe('Profile and wallet endpoints', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  it('GET /profile returns name, email/phone verification, and username', async () => {
    const { user } = await helpers.registerUser({
      email: 'profile-read@example.com',
      username: 'profile_read_user',
      phone: '+2348099999901',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    const res = await request(ctx.app.getHttpServer())
      .get('/profile')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    const body = res.body as ProfileResponseDto;
    expect(body.firstName).toBe('Ada');
    expect(body.lastName).toBe('Lovelace');
    expect(body.email).toBe('profile-read@example.com');
    expect(body.emailVerifiedAt).toBeNull();
    expect(body.phone).toBe('+2348099999901');
    expect(body.phoneVerifiedAt).toBeNull();
    expect(body.username).toBe('profile_read_user');
    // No mfaMethods field — users can't depend on auth's MfaService, so
    // it's dropped rather than forcing the dependency.
    expect(body).not.toHaveProperty('mfaMethods');
  });

  it('rejects an unauthenticated profile request', async () => {
    await request(ctx.app.getHttpServer()).get('/profile').expect(401);
  });

  it('PATCH /profile updates firstName/lastName with no cooldown or verification', async () => {
    const { user } = await helpers.registerUser({
      email: 'profile-name@example.com',
      username: 'profile_name_user',
      phone: '+2348099999902',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    const res = await request(ctx.app.getHttpServer())
      .patch('/profile')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ firstName: 'Grace', lastName: 'Hopper' })
      .expect(200);

    const body = res.body as ProfileResponseDto;
    expect(body.firstName).toBe('Grace');
    expect(body.lastName).toBe('Hopper');

    const updated = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(updated.usernameChangedAt).toBeNull();
  });

  it('PATCH /profile changes the username on the first change', async () => {
    const { user } = await helpers.registerUser({
      email: 'profile-username@example.com',
      username: 'profile_uname_user',
      phone: '+2348099999903',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    const res = await request(ctx.app.getHttpServer())
      .patch('/profile')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ username: 'new_username_1' })
      .expect(200);

    const body = res.body as ProfileResponseDto;
    expect(body.username).toBe('new_username_1');

    const updated = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(updated.usernameChangedAt).not.toBeNull();
  });

  it('PATCH /profile rejects a second username change within the 30-day cooldown', async () => {
    const { user } = await helpers.registerUser({
      email: 'profile-cooldown@example.com',
      username: 'profile_cd_user',
      phone: '+2348099999904',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    await request(ctx.app.getHttpServer())
      .patch('/profile')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ username: 'cooldown_username_1' })
      .expect(200);

    await request(ctx.app.getHttpServer())
      .patch('/profile')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ username: 'cooldown_username_2' })
      .expect(429);

    const updated = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(updated.username).toBe('cooldown_username_1');
  });

  it('PATCH /profile rejects a username already taken by another user', async () => {
    await helpers.registerUser({
      email: 'profile-taken-owner@example.com',
      username: 'profile_taken_name',
      phone: '+2348099999905',
    });
    const { user } = await helpers.registerUser({
      email: 'profile-taken-claimant@example.com',
      username: 'profile_taken_claim',
      phone: '+2348099999906',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    await request(ctx.app.getHttpServer())
      .patch('/profile')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ username: 'profile_taken_name' })
      .expect(409);
  });

  it('GET /wallet/balance returns the caller wallet balance and currency', async () => {
    const { user } = await helpers.registerUser({
      email: 'wallet-balance@example.com',
      username: 'wallet_balance_user',
      phone: '+2348099999907',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    const res = await request(ctx.app.getHttpServer())
      .get('/wallet/balance')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    const body = res.body as WalletBalanceResponseDto;
    expect(body.currency).toBe('NGN');
    expect(body.balance).toEqual({ amount: '0', currency: 'NGN' });
  });

  it('rejects an unauthenticated wallet balance request', async () => {
    await request(ctx.app.getHttpServer()).get('/wallet/balance').expect(401);
  });
});
