import { ValidateBy, ValidationArguments } from 'class-validator';

export const SCHEDULED_REFERENCE_PREFIX = 'sched_';

export function IsNotReservedReference() {
  return ValidateBy({
    name: 'isNotReservedReference',
    validator: {
      validate: (value: unknown) =>
        typeof value !== 'string' ||
        !value.toLowerCase().startsWith(SCHEDULED_REFERENCE_PREFIX),
      defaultMessage: (args?: ValidationArguments) =>
        `${args?.property ?? 'reference'} must not start with "${SCHEDULED_REFERENCE_PREFIX}"`,
    },
  });
}
