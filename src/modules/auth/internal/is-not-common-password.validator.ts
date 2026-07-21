import { ValidationOptions, registerDecorator } from 'class-validator';
import { isCommonPassword } from './common-passwords';

export function IsNotCommonPassword(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNotCommonPassword',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && !isCommonPassword(value);
        },
        defaultMessage(): string {
          return 'password is too common — choose a stronger one';
        },
      },
    });
  };
}
