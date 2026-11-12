import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { RateLimitModule } from '../../src/rate-limit/rate-limit.module';
import { KycVerification } from '../../src/modules/kyc/entities/kyc-verification.entity';
import { RecipientLookupResponseDto } from '../../src/modules/transfers/dto/recipient-lookup-response.dto';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  seedTransferUser,
} from './support/transfers-test-context';
import { dataOf } from './support/api-response';

jest.setTimeout(120_000);

describe('Recipient lookup endpoint', () => {
  let ctx: TransfersTestContext;
  let seq = 0;
  const jwtService = new JwtService({
    secret: 'test-jwt-secret-at-least-32-characters-long',
  });

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0, [RateLimitModule]);
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function seedUser(username: string, email?: string) {
    seq += 1;
    const { userId } = await seedTransferUser(ctx, {
      email: email ?? `${username}@example.com`,
      phone: `+2348099${String(998_000 + seq).padStart(6, '0')}`,
      username,
    });
    return { userId, token: jwtService.sign({ sub: userId, sid: 'test' }) };
  }

  async function verifyName(userId: string, name: string | null) {
    await ctx.dataSource.getRepository(KycVerification).save({
      userId,
      verifiedLegalName: name,
    });
  }

  const lookup = (token: string, identifier: string) =>
    request(ctx.app.getHttpServer())
      .get('/recipients/lookup')
      .query({ identifier })
      .set('Authorization', `Bearer ${token}`);

  it('resolves a recipient by username with the identity fields and the verified name', async () => {
    const recipient = await seedUser('lookup_recipient_uname');
    await verifyName(recipient.userId, 'Ada Obi Lovelace');
    const sender = await seedUser('lookup_sender_uname');

    const res = await lookup(sender.token, 'lookup_recipient_uname').expect(
      200,
    );

    const body = dataOf<RecipientLookupResponseDto>(res);
    expect(Object.keys(body).sort()).toEqual(
      ['firstName', 'lastName', 'userId', 'username', 'verifiedName'].sort(),
    );
    expect(body.userId).toBe(recipient.userId);
    expect(body.username).toBe('lookup_recipient_uname');
    expect(body.firstName).toBe('Ada');
    expect(body.lastName).toBe('Lovelace');
    expect(body.verifiedName).toBe('Ada Obi Lovelace');
  });

  it('resolves a recipient by email', async () => {
    const recipient = await seedUser(
      'lookup_recipient_email',
      'lookup-recipient-email@example.com',
    );
    const sender = await seedUser('lookup_sender_email');

    const res = await lookup(
      sender.token,
      'lookup-recipient-email@example.com',
    ).expect(200);

    expect(dataOf<RecipientLookupResponseDto>(res).userId).toBe(
      recipient.userId,
    );
  });

  it('withholds the verified name when the lookup is by email', async () => {
    const recipient = await seedUser(
      'lookup_email_name',
      'lookup-email-name@example.com',
    );
    await verifyName(recipient.userId, 'Ada Obi Lovelace');
    const sender = await seedUser('lookup_sender_email_name');

    const res = await lookup(
      sender.token,
      'lookup-email-name@example.com',
    ).expect(200);

    const body = dataOf<RecipientLookupResponseDto>(res);
    expect(body.userId).toBe(recipient.userId);
    expect(body.verifiedName).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('Ada Obi Lovelace');
  });

  it('returns a null verifiedName when the recipient has no KYC record', async () => {
    await seedUser('lookup_unverified');
    const sender = await seedUser('lookup_sender_null');

    const res = await lookup(sender.token, 'lookup_unverified').expect(200);

    expect(dataOf<RecipientLookupResponseDto>(res).verifiedName).toBeNull();
  });

  it('returns a null verifiedName when the KYC record has no legal name', async () => {
    const recipient = await seedUser('lookup_no_legal_name');
    await verifyName(recipient.userId, null);
    const sender = await seedUser('lookup_sender_no_name');

    const res = await lookup(sender.token, 'lookup_no_legal_name').expect(200);

    expect(dataOf<RecipientLookupResponseDto>(res).verifiedName).toBeNull();
  });

  it('returns 404 for an identifier with no matching user', async () => {
    const sender = await seedUser('lookup_miss_sender');

    await lookup(sender.token, 'nobody_by_this_name').expect(404);
  });

  it('rejects an unauthenticated lookup request', async () => {
    await request(ctx.app.getHttpServer())
      .get('/recipients/lookup')
      .query({ identifier: 'anyone' })
      .expect(401);
  });

  it('self-lookup returns the caller their own identity', async () => {
    const user = await seedUser('lookup_self_user');

    const res = await lookup(user.token, 'lookup_self_user').expect(200);

    const body = dataOf<RecipientLookupResponseDto>(res);
    expect(body.userId).toBe(user.userId);
    expect(body.username).toBe('lookup_self_user');
  });

  it('rate-limits the lookup to 5 a minute, well below the global default, per user', async () => {
    const user = await seedUser('lookup_rate_limit_user');

    for (let i = 0; i < 5; i++) {
      await lookup(user.token, 'lookup_rate_limit_user').expect(200);
    }

    await lookup(user.token, 'lookup_rate_limit_user').expect(429);
  });

  it('tracks the rate limit per user, not shared across users on the same connection', async () => {
    const a = await seedUser('lookup_rate_limit_a');
    const b = await seedUser('lookup_rate_limit_b');

    for (let i = 0; i < 5; i++) {
      await lookup(a.token, 'lookup_rate_limit_a').expect(200);
    }
    await lookup(a.token, 'lookup_rate_limit_a').expect(429);

    await lookup(b.token, 'lookup_rate_limit_b').expect(200);
  });
});
