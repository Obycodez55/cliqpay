import * as request from 'supertest';
import { RateLimitModule } from '../../src/rate-limit/rate-limit.module';
import { RecipientLookupResponseDto } from '../../src/modules/users/dto/recipient-lookup-response.dto';
import {
  AuthTestContext,
  createAuthTestContext,
  destroyAuthTestContext,
} from './support/auth-test-context';
import { createAuthTestHelpers } from './support/auth-test-helpers';

jest.setTimeout(120_000);

describe('Recipient lookup endpoint', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext([RateLimitModule]);
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  async function registeredAndLoggedIn(overrides: Record<string, unknown>) {
    const { user } = await helpers.registerUser(overrides);
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    return { user, tokens };
  }

  it('resolves a recipient by username with exactly the four allowed fields', async () => {
    const { user: recipient } = await registeredAndLoggedIn({
      email: 'lookup-recipient-username@example.com',
      username: 'lookup_recipient_uname',
      phone: '+2348099998001',
    });
    const { tokens: senderTokens } = await registeredAndLoggedIn({
      email: 'lookup-sender-username@example.com',
      username: 'lookup_sender_uname',
      phone: '+2348099998002',
    });

    const res = await request(ctx.app.getHttpServer())
      .get('/recipients/lookup')
      .query({ identifier: 'lookup_recipient_uname' })
      .set('Authorization', `Bearer ${senderTokens.accessToken}`)
      .expect(200);

    const body = res.body as RecipientLookupResponseDto;
    expect(Object.keys(body).sort()).toEqual(
      ['firstName', 'lastName', 'userId', 'username'].sort(),
    );
    expect(body.userId).toBe(recipient.id);
    expect(body.username).toBe('lookup_recipient_uname');
    expect(body.firstName).toBe('Ada');
    expect(body.lastName).toBe('Lovelace');
  });

  it('resolves a recipient by email with exactly the four allowed fields', async () => {
    const { user: recipient } = await registeredAndLoggedIn({
      email: 'lookup-recipient-email@example.com',
      username: 'lookup_recipient_email',
      phone: '+2348099998003',
    });
    const { tokens: senderTokens } = await registeredAndLoggedIn({
      email: 'lookup-sender-email@example.com',
      username: 'lookup_sender_email',
      phone: '+2348099998004',
    });

    const res = await request(ctx.app.getHttpServer())
      .get('/recipients/lookup')
      .query({ identifier: 'lookup-recipient-email@example.com' })
      .set('Authorization', `Bearer ${senderTokens.accessToken}`)
      .expect(200);

    const body = res.body as RecipientLookupResponseDto;
    expect(Object.keys(body).sort()).toEqual(
      ['firstName', 'lastName', 'userId', 'username'].sort(),
    );
    expect(body.userId).toBe(recipient.id);
    expect(body.username).toBe('lookup_recipient_email');
  });

  it('returns 404 for an identifier with no matching user', async () => {
    const { tokens } = await registeredAndLoggedIn({
      email: 'lookup-miss-sender@example.com',
      username: 'lookup_miss_sender',
      phone: '+2348099998005',
    });

    await request(ctx.app.getHttpServer())
      .get('/recipients/lookup')
      .query({ identifier: 'nobody_by_this_name' })
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(404);
  });

  it('rejects an unauthenticated lookup request', async () => {
    await request(ctx.app.getHttpServer())
      .get('/recipients/lookup')
      .query({ identifier: 'anyone' })
      .expect(401);
  });

  it('self-lookup returns the caller their own identity', async () => {
    const { user, tokens } = await registeredAndLoggedIn({
      email: 'lookup-self@example.com',
      username: 'lookup_self_user',
      phone: '+2348099998006',
    });

    const res = await request(ctx.app.getHttpServer())
      .get('/recipients/lookup')
      .query({ identifier: 'lookup_self_user' })
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    const body = res.body as RecipientLookupResponseDto;
    expect(body.userId).toBe(user.id);
    expect(body.username).toBe('lookup_self_user');
  });

  it('rate-limits the lookup endpoint well below the global default, per user', async () => {
    const { tokens } = await registeredAndLoggedIn({
      email: 'lookup-rate-limit@example.com',
      username: 'lookup_rate_limit_user',
      phone: '+2348099998007',
    });

    for (let i = 0; i < 10; i++) {
      await request(ctx.app.getHttpServer())
        .get('/recipients/lookup')
        .query({ identifier: 'lookup_rate_limit_user' })
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);
    }

    await request(ctx.app.getHttpServer())
      .get('/recipients/lookup')
      .query({ identifier: 'lookup_rate_limit_user' })
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(429);
  });

  it('tracks the rate limit per user, not shared across users on the same connection', async () => {
    const { tokens: tokensA } = await registeredAndLoggedIn({
      email: 'lookup-rate-limit-a@example.com',
      username: 'lookup_rate_limit_a',
      phone: '+2348099998008',
    });
    const { tokens: tokensB } = await registeredAndLoggedIn({
      email: 'lookup-rate-limit-b@example.com',
      username: 'lookup_rate_limit_b',
      phone: '+2348099998009',
    });

    for (let i = 0; i < 10; i++) {
      await request(ctx.app.getHttpServer())
        .get('/recipients/lookup')
        .query({ identifier: 'lookup_rate_limit_a' })
        .set('Authorization', `Bearer ${tokensA.accessToken}`)
        .expect(200);
    }

    // User A is now exhausted; user B, a fresh budget, still succeeds.
    await request(ctx.app.getHttpServer())
      .get('/recipients/lookup')
      .query({ identifier: 'lookup_rate_limit_a' })
      .set('Authorization', `Bearer ${tokensA.accessToken}`)
      .expect(429);

    await request(ctx.app.getHttpServer())
      .get('/recipients/lookup')
      .query({ identifier: 'lookup_rate_limit_b' })
      .set('Authorization', `Bearer ${tokensB.accessToken}`)
      .expect(200);
  });
});
