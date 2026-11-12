import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { KycVerification } from '../../src/modules/kyc/entities/kyc-verification.entity';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  fundWallet,
  seedTransferUser,
} from './support/transfers-test-context';

jest.setTimeout(180_000);

const LEGAL_NAME = 'Zeppelin Quixote Verifiable';

describe('the verified legal name stays out of everything but recipient lookup', () => {
  let ctx: TransfersTestContext;
  const jwtService = new JwtService({
    secret: 'test-jwt-secret-at-least-32-characters-long',
  });

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0);
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  it('is not in the profile, feed, follows, money requests, wallet history or the payment response', async () => {
    const sender = await seedTransferUser(ctx, {
      email: 'vn-sender@example.com',
      phone: '+2348055000001',
      username: 'vn_sender',
    });
    const recipient = await seedTransferUser(ctx, {
      email: 'vn-recipient@example.com',
      phone: '+2348055000002',
      username: 'vn_recipient',
    });
    await fundWallet(ctx, {
      reference: 'cliqpay-vn-fund',
      walletId: sender.walletId,
      netAmountMinor: 5_000_000n,
    });
    await ctx.dataSource.getRepository(KycVerification).save({
      userId: recipient.userId,
      verifiedLegalName: LEGAL_NAME,
    });
    const senderToken = jwtService.sign({ sub: sender.userId, sid: 't' });
    const recipientToken = jwtService.sign({ sub: recipient.userId, sid: 't' });
    const server = ctx.app.getHttpServer();

    const sent = await request(server)
      .post('/transfers')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({
        recipientUserId: recipient.userId,
        amount: 100_000,
        reference: 'cliqpay-vn-xfer',
        pin: '1234',
        visibility: 'public',
        riskAcknowledged: true,
      });
    const transactionId = (sent.body as { data: { transactionId: string } })
      .data.transactionId;
    const responses = [sent];
    await request(server)
      .post('/money-requests')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ payerUserId: recipient.userId, amount: 100_000 })
      .expect(201);

    for (const [token, path] of [
      [senderToken, '/profile'],
      [recipientToken, '/profile'],
      [senderToken, '/money-requests/outgoing'],
      [recipientToken, '/money-requests/incoming'],
      [senderToken, '/wallet/transactions'],
      [senderToken, '/social/feed'],
      [recipientToken, '/social/feed'],
      [senderToken, `/social/posts/${transactionId}`],
      [senderToken, `/social/posts/${transactionId}/comments`],
      [senderToken, '/social/following'],
      [senderToken, '/social/followers'],
      [senderToken, `/social/users/${recipient.userId}/relationship`],
    ]) {
      responses.push(
        await request(server).get(path).set('Authorization', `Bearer ${token}`),
      );
    }

    expect(responses[0].status).toBe(201);
    expect(responses.filter((r) => r.status === 200).length).toBeGreaterThan(3);
    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toContain(LEGAL_NAME);
      expect(JSON.stringify(res.body)).not.toContain('verifiedName');
    }
  });
});
