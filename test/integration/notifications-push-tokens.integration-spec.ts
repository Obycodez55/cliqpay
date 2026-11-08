import { randomUUID } from 'crypto';
import * as request from 'supertest';
import {
  NEW_FOLLOWER_EVENT,
  NewFollowerEventPayload,
} from '../../src/shared/events/domain-events';
import {
  NotificationsTestContext,
  createNotificationsTestContext,
  destroyNotificationsTestContext,
  waitFor,
} from './support/notifications-test-context';

jest.setTimeout(120_000);

describe('Notifications API — push tokens', () => {
  let ctx: NotificationsTestContext;

  beforeAll(async () => {
    ctx = await createNotificationsTestContext();
  });

  afterAll(async () => {
    await destroyNotificationsTestContext(ctx ?? {});
  });

  function register(userId: string, body: unknown) {
    return request(ctx.app.getHttpServer())
      .post('/notifications/push-tokens')
      .set('Authorization', `Bearer ${ctx.tokenFor(userId)}`)
      .send(body as object);
  }

  function remove(userId: string, token: string) {
    return request(ctx.app.getHttpServer())
      .delete(`/notifications/push-tokens/${encodeURIComponent(token)}`)
      .set('Authorization', `Bearer ${ctx.tokenFor(userId)}`);
  }

  function deviceToken(): string {
    return `fcm-${randomUUID()}:APA91b-${randomUUID()}`;
  }

  async function publishNewFollower(userId: string): Promise<void> {
    await ctx.eventBus.publish<string, NewFollowerEventPayload>({
      name: NEW_FOLLOWER_EVENT,
      payload: {
        userId,
        followerUserId: randomUUID(),
        followerUsername: 'tolu',
      },
      occurredAt: new Date(),
    });
  }

  function pushesTo(token: string) {
    return ctx.pushAdapter.sent.filter((message) => message.token === token);
  }

  it('registers a token for the caller', async () => {
    const userId = randomUUID();
    const token = deviceToken();

    await register(userId, { platform: 'android', token }).expect(204);

    expect(await ctx.pushTokenRepo.findBy({ token })).toEqual([
      expect.objectContaining({ userId, platform: 'android', token }),
    ]);
  });

  it('registering the same token again keeps one row and updates the platform', async () => {
    const userId = randomUUID();
    const token = deviceToken();

    await register(userId, { platform: 'android', token }).expect(204);
    await register(userId, { platform: 'ios', token }).expect(204);

    expect(await ctx.pushTokenRepo.findBy({ token })).toEqual([
      expect.objectContaining({ userId, platform: 'ios' }),
    ]);
  });

  it('moves a token to whoever registered it last', async () => {
    const previous = randomUUID();
    const current = randomUUID();
    const token = deviceToken();

    await register(previous, { platform: 'ios', token }).expect(204);
    await register(current, { platform: 'ios', token }).expect(204);

    expect(await ctx.pushTokenRepo.findBy({ token })).toEqual([
      expect.objectContaining({ userId: current }),
    ]);
  });

  it('delivers a push to a registered device', async () => {
    const userId = randomUUID();
    const token = deviceToken();
    await register(userId, { platform: 'android', token }).expect(204);

    await publishNewFollower(userId);

    await waitFor(() => pushesTo(token).length > 0);
    expect(pushesTo(token)).toEqual([
      expect.objectContaining({
        title: 'New follower',
        body: 'tolu started following you.',
      }),
    ]);
  });

  it('removes one of the caller’s own tokens', async () => {
    const userId = randomUUID();
    const token = deviceToken();
    await register(userId, { platform: 'android', token }).expect(204);

    await remove(userId, token).expect(204);

    expect(await ctx.pushTokenRepo.findBy({ token })).toEqual([]);
  });

  it('answers 204 but leaves the row when the token belongs to someone else', async () => {
    const owner = randomUUID();
    const token = deviceToken();
    await register(owner, { platform: 'android', token }).expect(204);

    await remove(randomUUID(), token).expect(204);
    await remove(randomUUID(), deviceToken()).expect(204);

    expect(await ctx.pushTokenRepo.findBy({ token })).toEqual([
      expect.objectContaining({ userId: owner }),
    ]);
  });

  it.each([
    ['an unknown platform', { platform: 'web', token: 'abc' }],
    ['a missing token', { platform: 'ios' }],
    ['an empty token', { platform: 'ios', token: '' }],
    ['an unexpected field', { platform: 'ios', token: 'abc', userId: 'x' }],
  ])('rejects %s with 400', async (_label, body) => {
    await register(randomUUID(), body).expect(400);
  });

  it('requires authentication on both routes', async () => {
    const server = ctx.app.getHttpServer();
    await request(server)
      .post('/notifications/push-tokens')
      .send({ platform: 'ios', token: deviceToken() })
      .expect(401);
    await request(server)
      .delete(`/notifications/push-tokens/${deviceToken()}`)
      .expect(401);
  });
});
