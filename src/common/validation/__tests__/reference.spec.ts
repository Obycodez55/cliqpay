import { validate } from 'class-validator';
import { IsNotReservedReference } from '../reference';

class Body {
  @IsNotReservedReference()
  reference: string;
}

async function errorsFor(reference: unknown) {
  const body = new Body();
  body.reference = reference as string;
  return validate(body);
}

describe('IsNotReservedReference', () => {
  it.each(['sched_abc', 'sched_', 'SCHED_abc', 'Sched_1_2_3'])(
    'rejects %s',
    async (reference) => {
      expect(await errorsFor(reference)).toHaveLength(1);
    },
  );

  it.each(['cliqpay-1', 'my_sched_1', 'sched-1', 'schedule_1'])(
    'accepts %s',
    async (reference) => {
      expect(await errorsFor(reference)).toHaveLength(0);
    },
  );

  it('leaves non-strings to the other validators', async () => {
    expect(await errorsFor(undefined)).toHaveLength(0);
  });
});
