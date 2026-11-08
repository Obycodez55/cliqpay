import { ValidateBy, ValidationArguments } from 'class-validator';
import { parsePhoneNumberFromString } from 'libphonenumber-js/mobile';

// The mobile-only metadata build makes isValid() reject landlines.
function parseNigerianMobile(value: string): string | null {
  const parsed = parsePhoneNumberFromString(value, 'NG');
  return parsed?.isValid() && parsed.country === 'NG' ? parsed.number : null;
}

// Every spelling of a number must reach the same E.164 string, or the
// unique index on users.phone would let one number register twice.
export function normalizeNigerianMobile(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return parseNigerianMobile(trimmed) ?? trimmed;
}

export function IsNigerianMobile() {
  return ValidateBy({
    name: 'isNigerianMobile',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && parseNigerianMobile(value) === value,
      defaultMessage: (args?: ValidationArguments) =>
        `${args?.property ?? 'value'} must be a valid Nigerian mobile number`,
    },
  });
}
