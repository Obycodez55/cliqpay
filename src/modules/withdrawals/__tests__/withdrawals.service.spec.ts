import { AppConfig } from '../../../config';
import { WithdrawalsService } from '../withdrawals.service';
import { LedgerService } from '../../ledger/ledger.service';
import { UsersService } from '../../users/users.service';
import { AuthService } from '../../auth/auth.service';
import { PaymentsService } from '../../payments/payments.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { BankAccount } from '../entities/bank-account.entity';
import { InitiatorAccountFrozenException } from '../internal/errors';

const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

const testConfig = {
  withdrawals: {
    minAmount: 10_000,
    maxAmount: 100_000_000,
    platformFee: 0,
    providerFee: 3_000,
  },
  encryption: { key: TEST_ENCRYPTION_KEY },
} as AppConfig;

type User = Awaited<ReturnType<UsersService['findById']>>;
type Wallet = Awaited<ReturnType<LedgerService['getUserWallet']>>;

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'withdrawer-1',
    email: 'withdrawer@example.com',
    isFrozen: false,
    ...overrides,
  } as User;
}

function wallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: 'wallet-1',
    userId: 'withdrawer-1',
    currency: 'NGN',
    balance: 1_000_000n,
    ...overrides,
  } as Wallet;
}

function bankAccount(overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    id: 'bank-account-1',
    userId: 'withdrawer-1',
    provider: 'kora',
    bankCode: '058',
    bankName: 'Test Bank',
    accountNumberCiphertext: 'unused-in-these-tests',
    accountNumberHash: 'unused-in-these-tests',
    accountName: 'Ada Lovelace',
    ...overrides,
  } as BankAccount;
}

describe('WithdrawalsService.initiateWithdrawal', () => {
  let bankAccountRepo: { findOneBy: jest.Mock };
  let authService: jest.Mocked<Pick<AuthService, 'verifyTransactionPin'>>;
  let paymentsService: jest.Mocked<Pick<PaymentsService, 'initiatePayout'>>;
  let ledgerService: jest.Mocked<
    Pick<
      LedgerService,
      'getUserWallet' | 'checkIdempotentReplay' | 'postWithdrawal'
    >
  >;
  let usersService: jest.Mocked<Pick<UsersService, 'findById'>>;
  let eventBus: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let service: WithdrawalsService;

  const dto = {
    bankAccountId: 'bank-account-1',
    amount: 500_000,
    reference: 'cliqpay-wd-1',
    pin: '1234',
  };

  beforeEach(() => {
    bankAccountRepo = { findOneBy: jest.fn().mockResolvedValue(bankAccount()) };
    authService = { verifyTransactionPin: jest.fn() };
    paymentsService = { initiatePayout: jest.fn() };
    ledgerService = {
      getUserWallet: jest.fn().mockResolvedValue(wallet()),
      checkIdempotentReplay: jest.fn().mockResolvedValue({ outcome: 'none' }),
      postWithdrawal: jest.fn(),
    };
    usersService = { findById: jest.fn().mockResolvedValue(user()) };
    eventBus = { publish: jest.fn() };

    service = new WithdrawalsService(
      bankAccountRepo as never,
      authService as unknown as AuthService,
      paymentsService as unknown as PaymentsService,
      ledgerService as unknown as LedgerService,
      usersService as unknown as UsersService,
      eventBus as unknown as EventBusService,
      testConfig,
    );
  });

  it('rejects a frozen initiator at the PIN-check call site, without verifying the PIN or posting', async () => {
    usersService.findById.mockResolvedValue(user({ isFrozen: true }));

    await expect(
      service.initiateWithdrawal('withdrawer-1', dto),
    ).rejects.toThrow(InitiatorAccountFrozenException);

    expect(authService.verifyTransactionPin).not.toHaveBeenCalled();
    expect(ledgerService.postWithdrawal).not.toHaveBeenCalled();
  });

  it('proceeds past the frozen check to PIN verification for a non-frozen initiator', async () => {
    usersService.findById.mockResolvedValue(user({ isFrozen: false }));
    authService.verifyTransactionPin.mockRejectedValue(
      new Error('pin-check-reached'),
    );

    await expect(
      service.initiateWithdrawal('withdrawer-1', dto),
    ).rejects.toThrow('pin-check-reached');

    expect(authService.verifyTransactionPin).toHaveBeenCalledWith(
      'withdrawer-1',
      '1234',
    );
    expect(ledgerService.postWithdrawal).not.toHaveBeenCalled();
  });
});
