import { validate } from 'class-validator';
import { IsNotWeakTransactionPin } from '../internal/is-not-weak-transaction-pin.validator';

class Probe {
  @IsNotWeakTransactionPin()
  pin: string;
}

function probe(pin: string): Probe {
  const p = new Probe();
  p.pin = pin;
  return p;
}

describe('IsNotWeakTransactionPin', () => {
  it.each(['0000', '1111', '9999'])(
    'rejects an all-same-digit PIN (%s)',
    async (pin) => {
      const errors = await validate(probe(pin));
      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty('isNotWeakTransactionPin');
    },
  );

  it.each(['1234', '4567', '6789'])(
    'rejects an ascending sequential PIN (%s)',
    async (pin) => {
      const errors = await validate(probe(pin));
      expect(errors).toHaveLength(1);
    },
  );

  it.each(['4321', '9876', '3210'])(
    'rejects a descending sequential PIN (%s)',
    async (pin) => {
      const errors = await validate(probe(pin));
      expect(errors).toHaveLength(1);
    },
  );

  it('rejects a PIN that is not exactly 4 digits', async () => {
    const errors = await validate(probe('123'));
    expect(errors).toHaveLength(1);
  });

  it('accepts a non-sequential, non-repeating PIN', async () => {
    const errors = await validate(probe('4837'));
    expect(errors).toHaveLength(0);
  });
});
