import { ValidateBy, ValidationArguments } from 'class-validator';

const INVISIBLE_CHARACTERS = /\u200B|\u200C|\u200D|\u2060|\uFEFF/g;

// Invisible characters only decide whether text is blank; they're kept
// otherwise, because U+200D joins multi-part emoji.
export function normalizeText(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.replace(INVISIBLE_CHARACTERS, '').trim() === '' ? '' : trimmed;
}

// Counted in code points, as Postgres counts varchar length, so an emoji
// can't pass validation and then overflow the column.
export function HasCodePointLength(min: number, max: number) {
  return ValidateBy({
    name: 'hasCodePointLength',
    validator: {
      validate: (value: unknown) => {
        if (typeof value !== 'string') {
          return false;
        }
        const length = [...value].length;
        return length >= min && length <= max;
      },
      defaultMessage: (args?: ValidationArguments) =>
        `${args?.property ?? 'value'} must be between ${min} and ${max} characters`,
    },
  });
}
