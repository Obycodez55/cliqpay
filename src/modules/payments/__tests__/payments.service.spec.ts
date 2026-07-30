import { UnauthorizedException } from '@nestjs/common';
import { PaymentsService } from '../payments.service';
import { LedgerService, PostFundingResult } from '../../ledger/ledger.service';
import { UsersService } from '../../users/users.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Money } from '../../../shared/primitives/money';
import { PaymentProviderAdapter } from '../adapters/payment-provider.interface';
import { FUNDING_COMPLETED_EVENT } from '../../../shared/events/domain-events';

function webhookBody(overrides: Partial<Record<string, unknown>> = {}) {
  return Buffer.from(
    JSON.stringify({
      event: 'charge.success',
      data: {
        reference: 'cliqpay-ref-1',
        status: 'success',
        amount: '5000.00',
        fee: 50,
        ...overrides,
      },
    }),
    'utf8',
  );
}

describe('PaymentsService.handleFundingWebhook', () => {
  let ledgerService: jest.Mocked<
    Pick<LedgerService, 'postFunding' | 'findTransactionByReference'>
  >;
  let usersService: jest.Mocked<Pick<UsersService, 'findById'>>;
  let eventBus: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let adapter: jest.Mocked<PaymentProviderAdapter>;
  let service: PaymentsService;

  const postFundingResult: PostFundingResult = {
    userId: 'user-1',
    netAmount: Money.of(500_000n, 'NGN'),
  };

  beforeEach(() => {
    ledgerService = {
      postFunding: jest.fn(),
      findTransactionByReference: jest.fn(),
    };
    usersService = { findById: jest.fn() };
    eventBus = { publish: jest.fn() };
    adapter = {
      initiatePayment: jest.fn(),
      verifyWebhookSignature: jest.fn().mockReturnValue(true),
    };
    service = new PaymentsService(
      ledgerService as unknown as LedgerService,
      usersService as unknown as UsersService,
      eventBus as unknown as EventBusService,
      adapter,
    );
  });

  it('rejects an invalid signature before touching the ledger', async () => {
    adapter.verifyWebhookSignature.mockReturnValue(false);

    await expect(
      service.handleFundingWebhook(webhookBody(), 'bad-signature'),
    ).rejects.toThrow(UnauthorizedException);

    expect(ledgerService.postFunding).not.toHaveBeenCalled();
  });

  it('rejects a missing signature before touching the ledger', async () => {
    await expect(
      service.handleFundingWebhook(webhookBody(), undefined),
    ).rejects.toThrow(UnauthorizedException);

    expect(ledgerService.postFunding).not.toHaveBeenCalled();
  });

  it('publishes funding_completed after a successful posting', async () => {
    ledgerService.postFunding.mockResolvedValue(postFundingResult);
    usersService.findById.mockResolvedValue({
      email: 'user@example.com',
    } as Awaited<ReturnType<UsersService['findById']>>);

    await service.handleFundingWebhook(webhookBody(), 'sig');

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    const published = eventBus.publish.mock.calls[0][0] as {
      name: string;
      payload: Record<string, unknown>;
    };
    expect(published.name).toBe(FUNDING_COMPLETED_EVENT);
    expect(published.payload).toMatchObject({
      userId: 'user-1',
      email: 'user@example.com',
      amount: '5000.00',
      currency: 'NGN',
    });
  });

  it('does not publish when postFunding reports a duplicate or unresolved delivery', async () => {
    ledgerService.postFunding.mockResolvedValue(null);

    await service.handleFundingWebhook(webhookBody(), 'sig');

    expect(usersService.findById).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  // The regression this guards: a failure here used to propagate as a
  // thrown error, which would make the webhook handler return non-2xx,
  // which would make Kora retry — landing on postFunding's idempotency
  // guard (already `completed`) before ever reaching this code again,
  // permanently and silently dropping the notification despite the money
  // having posted correctly. See payments.service.ts's handleFundingWebhook.
  it('does not throw when publishing the completion notification fails, since the funding already posted', async () => {
    ledgerService.postFunding.mockResolvedValue(postFundingResult);
    usersService.findById.mockResolvedValue({
      email: 'user@example.com',
    } as Awaited<ReturnType<UsersService['findById']>>);
    eventBus.publish.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      service.handleFundingWebhook(webhookBody(), 'sig'),
    ).resolves.toBeUndefined();

    expect(eventBus.publish).toHaveBeenCalled();
  });

  it('does not throw when looking up the user for notification fails, since the funding already posted', async () => {
    ledgerService.postFunding.mockResolvedValue(postFundingResult);
    usersService.findById.mockRejectedValue(new Error('db blip'));

    await expect(
      service.handleFundingWebhook(webhookBody(), 'sig'),
    ).resolves.toBeUndefined();

    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});
