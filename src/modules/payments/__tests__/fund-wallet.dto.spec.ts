import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FundWalletDto } from '../dto/fund-wallet.dto';

const errorsFor = (amount: number) =>
  validate(plainToInstance(FundWalletDto, { amount, reference: 'ref-1' }));

describe('FundWalletDto', () => {
  it('accepts exactly the NGN 100 minimum', async () => {
    expect(await errorsFor(10_000)).toHaveLength(0);
  });

  it('rejects an amount below NGN 100', async () => {
    const errors = await errorsFor(9_999);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('amount');
  });
});
