import { createHmac } from 'crypto';
import * as bcrypt from 'bcrypt';

const BCRYPT_SALT_ROUNDS = 10;

// HMAC-SHA256 under the pepper first, then bcrypt over that — a database
// dump without TRANSACTION_PIN_PEPPER yields nothing, unlike bcrypt alone
// over a 4-digit space (see ADR-0009).
function pepperPin(pin: string, pepper: string): string {
  return createHmac('sha256', pepper).update(pin).digest('hex');
}

export function hashTransactionPin(
  pin: string,
  pepper: string,
): Promise<string> {
  return bcrypt.hash(pepperPin(pin, pepper), BCRYPT_SALT_ROUNDS);
}

export function compareTransactionPin(
  pin: string,
  pepper: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(pepperPin(pin, pepper), hash);
}
