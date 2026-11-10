import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../../src/config';
import { TrustedDevice } from '../../../src/modules/auth/entities/trusted-device.entity';
import { buildSigningString } from '../../../src/shared/crypto/device-signature.util';
import { dataOf, errorOf } from './api-response';
import { createTestDeviceKey, signWith, TestDeviceKey } from './device-keys';
import { TEST_DEVICE_ID } from './device-defaults';

export interface SignedParts {
  action: string;
  reference: string;
  amount: string;
  target: string;
}

export const OTHER_DEVICE_KEY = createTestDeviceKey();

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function signedHeaders(
  key: TestDeviceKey,
  parts: SignedParts,
  timestamp: number = nowSeconds(),
): Record<string, string> {
  const signature = signWith(
    key.privateKey,
    buildSigningString([
      parts.action,
      parts.reference,
      parts.amount,
      parts.target,
      String(timestamp),
    ]),
  );
  return {
    'X-Device-Signature': signature,
    'X-Signature-Timestamp': String(timestamp),
  };
}

export async function seedSigningDevice(
  dataSource: DataSource,
  userId: string,
  key: TestDeviceKey,
  deviceId: string = TEST_DEVICE_ID,
): Promise<void> {
  const now = new Date();
  await dataSource.getRepository(TrustedDevice).save({
    userId,
    tokenHash: randomUUID(),
    deviceId,
    publicKey: key.publicKeySpkiBase64,
    device: { ipAddress: '203.0.113.10', userAgent: 'jest' },
    revokedAt: null,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    lastUsedAt: now,
  });
}

export interface SignedActionCase {
  userId: string;
  signs: SignedParts;
  send: (headers: Record<string, string>) => request.Test;
  // Requests whose body differs from what was signed, by field.
  tampered: Record<string, (headers: Record<string, string>) => request.Test>;
  expectApplied: (res: request.Response) => Promise<void>;
  expectUntouched: () => Promise<void>;
}

// Runs the shared matrix for one signed action. The context is passed lazily
// because it exists only after beforeAll.
export function describeSignedAction(
  title: string,
  getContext: () => { dataSource: DataSource; config: AppConfig },
  options: { tamper: string[]; replays: boolean },
  makeCase: () => Promise<SignedActionCase>,
): void {
  describe(title, () => {
    let previous: boolean;

    beforeAll(() => {
      previous = getContext().config.device.keyRequired;
      getContext().config.device.keyRequired = true;
    });

    afterAll(() => {
      getContext().config.device.keyRequired = previous;
    });

    async function prepared(): Promise<SignedActionCase> {
      const testCase = await makeCase();
      await seedSigningDevice(
        getContext().dataSource,
        testCase.userId,
        OTHER_DEVICE_KEY,
      );
      return testCase;
    }

    it('applies the action when the signature is valid', async () => {
      const c = await prepared();
      const res = await c.send(signedHeaders(OTHER_DEVICE_KEY, c.signs));
      expect(res.status).toBeLessThan(300);
      await c.expectApplied(res);
    });

    it('rejects a request with no signature headers', async () => {
      const c = await prepared();
      const res = await c.send({});
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('ACTION_SIGNATURE_REQUIRED');
      await c.expectUntouched();
    });

    it('rejects a timestamp more than 2 minutes old', async () => {
      const c = await prepared();
      const res = await c.send(
        signedHeaders(OTHER_DEVICE_KEY, c.signs, nowSeconds() - 130),
      );
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('ACTION_SIGNATURE_STALE');
      await c.expectUntouched();
    });

    it('rejects a timestamp more than 2 minutes ahead', async () => {
      const c = await prepared();
      const res = await c.send(
        signedHeaders(OTHER_DEVICE_KEY, c.signs, nowSeconds() + 130),
      );
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('ACTION_SIGNATURE_STALE');
      await c.expectUntouched();
    });

    it('rejects a signature made with a different key', async () => {
      const c = await prepared();
      const res = await c.send(signedHeaders(createTestDeviceKey(), c.signs));
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('ACTION_SIGNATURE_INVALID');
      await c.expectUntouched();
    });

    it('rejects a signature over a different action name', async () => {
      const c = await prepared();
      const res = await c.send(
        signedHeaders(OTHER_DEVICE_KEY, { ...c.signs, action: 'other.action' }),
      );
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('ACTION_SIGNATURE_INVALID');
      await c.expectUntouched();
    });

    it('rejects when the caller has no trusted device key', async () => {
      const c = await makeCase();
      await getContext()
        .dataSource.getRepository(TrustedDevice)
        .update({ userId: c.userId }, { revokedAt: new Date() });
      const res = await c.send(signedHeaders(OTHER_DEVICE_KEY, c.signs));
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('DEVICE_KEY_NOT_REGISTERED');
      await c.expectUntouched();
    });

    it('skips the check while DEVICE_KEY_REQUIRED is off', async () => {
      const c = await makeCase();
      const config = getContext().config;
      config.device.keyRequired = false;
      try {
        const res = await c.send({});
        expect(res.status).toBeLessThan(300);
        await c.expectApplied(res);
      } finally {
        config.device.keyRequired = true;
      }
    });

    it.each(options.tamper)('rejects a changed %s', async (field) => {
      const c = await prepared();
      const res = await c.tampered[field](
        signedHeaders(OTHER_DEVICE_KEY, c.signs),
      );
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('ACTION_SIGNATURE_INVALID');
      await c.expectUntouched();
    });

    if (options.replays) {
      it('returns the original result for a replayed reference signed afresh', async () => {
        const c = await prepared();
        const first = await c.send(signedHeaders(OTHER_DEVICE_KEY, c.signs));
        await c.expectApplied(first);
        const second = await c.send(signedHeaders(OTHER_DEVICE_KEY, c.signs));
        expect(second.status).toBe(first.status);
        expect(dataOf(second)).toEqual(dataOf(first));
      });
    }
  });
}
