import { ValidationOptions, registerDecorator } from 'class-validator';

function isSequential(digits: number[]): boolean {
  const ascending = digits.every(
    (digit, i) => i === 0 || digit === digits[i - 1] + 1,
  );
  const descending = digits.every(
    (digit, i) => i === 0 || digit === digits[i - 1] - 1,
  );
  return ascending || descending;
}

function isWeakPin(pin: string): boolean {
  const digits = pin.split('').map(Number);
  const allSame = digits.every((digit) => digit === digits[0]);
  return allSame || isSequential(digits);
}

export function IsNotWeakTransactionPin(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNotWeakTransactionPin',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return (
            typeof value === 'string' &&
            /^\d{4}$/.test(value) &&
            !isWeakPin(value)
          );
        },
        defaultMessage(): string {
          return 'PIN is too easy to guess — avoid repeated or sequential digits';
        },
      },
    });
  };
}
