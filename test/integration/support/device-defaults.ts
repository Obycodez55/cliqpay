/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return -- patches library prototypes */
import { JwtService } from '@nestjs/jwt';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import SupertestTest = require('supertest/lib/test');

export const TEST_DEVICE_ID = 'test-device-0000000000';

// Every authenticated request must carry X-Device-Id and an access token
// bound to it. Specs that forge tokens with jwtService.sign and call routes
// through supertest get that default here; specs that exercise device
// binding set the header and claim explicitly.
const originalEnd = SupertestTest.prototype.end;
SupertestTest.prototype.end = function (
  this: SupertestTest,
  fn?: Parameters<typeof originalEnd>[0],
) {
  if (!this.get('X-Device-Id')) {
    void this.set('X-Device-Id', TEST_DEVICE_ID);
  }
  return originalEnd.call(this, fn);
} as typeof originalEnd;

const originalSign = JwtService.prototype.sign;
JwtService.prototype.sign = function (
  this: JwtService,
  payload: string | Buffer | object,
  options?: object,
) {
  const claims =
    typeof payload === 'object' && !Buffer.isBuffer(payload)
      ? { did: TEST_DEVICE_ID, ...payload }
      : payload;
  return originalSign.call(this, claims, options);
} as JwtService['sign'];
