import { validate } from 'class-validator';
import { IsNotCommonPassword } from '../internal/is-not-common-password.validator';

class Probe {
  @IsNotCommonPassword()
  password: string;
}

function probe(password: string): Probe {
  const p = new Probe();
  p.password = password;
  return p;
}

describe('IsNotCommonPassword', () => {
  it('rejects a password from the blocklist', async () => {
    const errors = await validate(probe('password'));
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isNotCommonPassword');
  });

  it('is case-insensitive against the blocklist', async () => {
    const errors = await validate(probe('PaSSwoRD'));
    expect(errors).toHaveLength(1);
  });

  it('accepts a passphrase not on the blocklist', async () => {
    const errors = await validate(probe('correct-horse-battery-staple-42'));
    expect(errors).toHaveLength(0);
  });
});
