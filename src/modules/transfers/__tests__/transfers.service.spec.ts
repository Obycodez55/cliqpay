import {
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EntityNotFoundError } from 'typeorm';
import { AppConfig } from '../../../config';
import { TransfersService } from '../transfers.service';
import {
  IdempotentReplay,
  LedgerService,
  PostTransferResult,
} from '../../ledger/ledger.service';
import { UsersService } from '../../users/users.service';
import { AuthService } from '../../auth/auth.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Money } from '../../../shared/primitives/money';
import {
  RecipientWalletNotFoundException,
  SelfTransferException,
  SenderEmailNotVerifiedException,
  TransferAmountTooLargeException,
  TransferAmountTooSmallException,
  UnsupportedTransferCurrencyException,
} from '../internal/errors';
import {
  TRANSFER_RECEIVED_EVENT,
  TRANSFER_SENT_EVENT,
} from '../../../shared/events/domain-events';

const testConfig = {
  transfers: { minAmount: 10_000, maxAmount: 100_000_000, platformFee: 0 },
} as AppConfig;

type User = Awaited<ReturnType<UsersService['findById']>>;
type Wallet = Awaited<ReturnType<LedgerService['getUserWallet']>>;

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'sender-1',
    email: 'sender@example.com',
    username: 'sender_username',
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as User;
}

function wallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: 'wallet-sender',
    userId: 'sender-1',
    currency: 'NGN',
    balance: 1_000_000n,
    ...overrides,
  } as Wallet;
}

describe('TransfersService.sendMoney', () => {
  let ledgerService: jest.Mocked<
    Pick<
      LedgerService,
      'getUserWallet' | 'checkIdempotentReplay' | 'postTransfer'
    >
  >;
  let usersService: jest.Mocked<Pick<UsersService, 'findById'>>;
  let authService: jest.Mocked<Pick<AuthService, 'verifyTransactionPin'>>;
  let eventBus: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let service: TransfersService;

  const dto = {
    recipientUserId: 'recipient-1',
    amount: 500_000,
    reference: 'cliqpay-xfer-1',
    pin: '1234',
  };

  const postTransferResult: PostTransferResult = {
    transactionId: 'txn-1',
    reference: 'cliqpay-xfer-1',
    senderUserId: 'sender-1',
    recipientUserId: 'recipient-1',
    amount: Money.of(500_000n, 'NGN'),
    platformFee: Money.zero('NGN'),
    createdAt: new Date('2026-08-16T00:00:00Z'),
  };

  beforeEach(() => {
    ledgerService = {
      getUserWallet: jest.fn(),
      checkIdempotentReplay: jest.fn(),
      postTransfer: jest.fn(),
    };
    usersService = { findById: jest.fn() };
    authService = { verifyTransactionPin: jest.fn() };
    eventBus = { publish: jest.fn() };
    service = new TransfersService(
      ledgerService as unknown as LedgerService,
      usersService as unknown as UsersService,
      authService as unknown as AuthService,
      eventBus as unknown as EventBusService,
      testConfig,
    );

    usersService.findById.mockResolvedValue(user());
    ledgerService.getUserWallet.mockImplementation((userId: string) =>
      Promise.resolve(
        wallet(
          userId === 'sender-1'
            ? { id: 'wallet-sender', userId: 'sender-1' }
            : { id: 'wallet-recipient', userId: 'recipient-1' },
        ),
      ),
    );
    ledgerService.checkIdempotentReplay.mockResolvedValue({ outcome: 'none' });
    ledgerService.postTransfer.mockResolvedValue(postTransferResult);
  });

  it('rejects an amount below the configured minimum before touching any service', async () => {
    await expect(
      service.sendMoney('sender-1', { ...dto, amount: 9_999 }),
    ).rejects.toThrow(TransferAmountTooSmallException);

    expect(usersService.findById).not.toHaveBeenCalled();
  });

  it('rejects an amount above the configured maximum', async () => {
    await expect(
      service.sendMoney('sender-1', { ...dto, amount: 100_000_001 }),
    ).rejects.toThrow(TransferAmountTooLargeException);
  });

  it('rejects sending to yourself', async () => {
    await expect(
      service.sendMoney('sender-1', { ...dto, recipientUserId: 'sender-1' }),
    ).rejects.toThrow(SelfTransferException);
  });

  it("rejects when the sender's email is not verified", async () => {
    usersService.findById.mockResolvedValue(user({ emailVerifiedAt: null }));

    await expect(service.sendMoney('sender-1', dto)).rejects.toThrow(
      SenderEmailNotVerifiedException,
    );
  });

  it('maps a missing recipient wallet to a domain exception', async () => {
    ledgerService.getUserWallet.mockImplementation((userId: string) =>
      userId === 'recipient-1'
        ? Promise.reject(new EntityNotFoundError('Account', {}))
        : Promise.resolve(wallet()),
    );

    await expect(service.sendMoney('sender-1', dto)).rejects.toThrow(
      RecipientWalletNotFoundException,
    );
  });

  it('rejects when either wallet is not NGN (defensive — unreachable via the real DTO today)', async () => {
    ledgerService.getUserWallet.mockImplementation((userId: string) =>
      Promise.resolve(
        wallet(
          userId === 'sender-1'
            ? { id: 'wallet-sender', userId: 'sender-1', currency: 'USD' }
            : { id: 'wallet-recipient', userId: 'recipient-1' },
        ),
      ),
    );

    await expect(service.sendMoney('sender-1', dto)).rejects.toThrow(
      UnsupportedTransferCurrencyException,
    );
  });

  it('returns the original result on a matching replay without re-checking the PIN', async () => {
    ledgerService.checkIdempotentReplay.mockResolvedValue({
      outcome: 'match',
      transaction: {
        reference: 'cliqpay-xfer-1',
        amount: 500_000n,
        currency: 'NGN',
        metadata: { platformFee: { amount: '0', currency: 'NGN' } },
        createdAt: new Date('2026-08-16T00:00:00Z'),
      },
    } as IdempotentReplay);

    const result = await service.sendMoney('sender-1', dto);

    expect(result).toEqual({
      reference: 'cliqpay-xfer-1',
      amount: { amount: '500000', currency: 'NGN' },
      fee: { amount: '0', currency: 'NGN' },
      recipientUserId: 'recipient-1',
      createdAt: '2026-08-16T00:00:00.000Z',
    });
    expect(authService.verifyTransactionPin).not.toHaveBeenCalled();
    expect(ledgerService.postTransfer).not.toHaveBeenCalled();
  });

  it('rejects a reference already used by a different user without exposing it', async () => {
    ledgerService.checkIdempotentReplay.mockResolvedValue({
      outcome: 'foreign',
    });

    await expect(service.sendMoney('sender-1', dto)).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects a reference reused with different parameters', async () => {
    ledgerService.checkIdempotentReplay.mockResolvedValue({
      outcome: 'diverged',
    });

    await expect(service.sendMoney('sender-1', dto)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('verifies the PIN, posts the transfer, and publishes both notifications', async () => {
    usersService.findById.mockImplementation((userId: string) =>
      Promise.resolve(
        userId === 'sender-1'
          ? user({ id: 'sender-1', username: 'sender_username' })
          : user({
              id: 'recipient-1',
              email: 'recipient@example.com',
              username: 'recipient_username',
            }),
      ),
    );

    const result = await service.sendMoney('sender-1', dto);

    expect(authService.verifyTransactionPin).toHaveBeenCalledWith(
      'sender-1',
      '1234',
    );
    expect(ledgerService.postTransfer).toHaveBeenCalledWith({
      reference: 'cliqpay-xfer-1',
      senderWalletId: 'wallet-sender',
      recipientWalletId: 'wallet-recipient',
      amount: Money.of(500_000n, 'NGN'),
      platformFee: Money.zero('NGN'),
    });
    expect(result.reference).toBe('cliqpay-xfer-1');

    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    const names = eventBus.publish.mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(names).toEqual(
      expect.arrayContaining([TRANSFER_SENT_EVENT, TRANSFER_RECEIVED_EVENT]),
    );
  });

  it('posts a non-zero configured fee as the debit-side addition, not folded into amount', async () => {
    const feeConfig = {
      transfers: {
        minAmount: 10_000,
        maxAmount: 100_000_000,
        platformFee: 5_000,
      },
    } as AppConfig;
    service = new TransfersService(
      ledgerService as unknown as LedgerService,
      usersService as unknown as UsersService,
      authService as unknown as AuthService,
      eventBus as unknown as EventBusService,
      feeConfig,
    );

    await service.sendMoney('sender-1', dto);

    expect(ledgerService.postTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ platformFee: Money.of(5_000n, 'NGN') }),
    );
  });

  it('does not throw when publishing notifications fails, since the transfer already posted', async () => {
    eventBus.publish.mockRejectedValue(new Error('redis unavailable'));

    await expect(service.sendMoney('sender-1', dto)).resolves.toMatchObject({
      reference: 'cliqpay-xfer-1',
    });
  });

  it('re-checks replay on a unique-violation race and returns the winner’s result', async () => {
    ledgerService.postTransfer.mockRejectedValue({
      code: '23505',
      constraint: 'UQ_transactions_reference',
    });
    ledgerService.checkIdempotentReplay
      .mockResolvedValueOnce({ outcome: 'none' })
      .mockResolvedValueOnce({
        outcome: 'match',
        transaction: {
          reference: 'cliqpay-xfer-1',
          amount: 500_000n,
          currency: 'NGN',
          metadata: { platformFee: { amount: '0', currency: 'NGN' } },
          createdAt: new Date('2026-08-16T00:00:00Z'),
        },
      } as IdempotentReplay);

    const result = await service.sendMoney('sender-1', dto);

    expect(result.reference).toBe('cliqpay-xfer-1');
  });

  it('rethrows a unique-violation race when the raced replay is still not a match', async () => {
    ledgerService.postTransfer.mockRejectedValue({
      code: '23505',
      constraint: 'UQ_transactions_reference',
    });
    ledgerService.checkIdempotentReplay
      .mockResolvedValueOnce({ outcome: 'none' })
      .mockResolvedValueOnce({ outcome: 'none' });

    await expect(service.sendMoney('sender-1', dto)).rejects.toBeDefined();
  });
});
