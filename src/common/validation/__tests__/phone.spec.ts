import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegisterDto } from '../../../modules/auth/dto/register.dto';
import { normalizeNigerianMobile } from '../phone';

function phoneOf(phone: unknown) {
  const dto = plainToInstance(RegisterDto, {
    email: 'a@example.com',
    password: 'correct-horse-battery-staple-9',
    username: 'ada_lovelace',
    phone,
  });
  const errors = validateSync(dto).filter((e) => e.property === 'phone');
  return { phone: dto.phone, valid: errors.length === 0 };
}

describe('Nigerian mobile validation', () => {
  it.each([
    '+2348012345678',
    '2348012345678',
    '08012345678',
    '8012345678',
    ' +234 801-234-5678 ',
    '0801 234 5678',
  ])('normalises %p to E.164', (input) => {
    expect(phoneOf(input)).toEqual({ phone: '+2348012345678', valid: true });
  });

  it.each([
    ['one digit short', '+234820289978'],
    ['one digit long', '+23480123456789'],
    ['a Lagos landline', '+23412345678'],
    ['a UK mobile', '+447911123456'],
    ['letters', 'not-a-number'],
    ['empty', ''],
    ['a number type', 2348012345678],
  ])('rejects %s', (_label, input) => {
    expect(phoneOf(input).valid).toBe(false);
  });

  it('leaves non-strings untouched', () => {
    expect(normalizeNigerianMobile(42)).toBe(42);
  });
});
