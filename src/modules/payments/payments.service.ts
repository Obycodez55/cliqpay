import { Inject, Injectable } from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { Money } from '../../shared/primitives/money';
import { FundWalletDto } from './dto/fund-wallet.dto';
import { FundWalletResponseDto } from './dto/fund-wallet-response.dto';
import {
  PAYMENT_PROVIDER_ADAPTER,
  PaymentProviderAdapter,
} from './adapters/payment-provider.interface';
import { isUniqueViolation } from './internal/errors';

const NGN = 'NGN'; // Funding is NGN-only for now — see issue #12.

/**
 * The one exported surface of the payments module — see
 * docs/architecture.md §10. No ledger entries are posted here — that's
 * issue #13, once a webhook actually confirms something succeeded. This
 * only gets as far as a `pending` `transactions` row and a checkout URL.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly usersService: UsersService,
    @Inject(PAYMENT_PROVIDER_ADAPTER)
    private readonly adapter: PaymentProviderAdapter,
  ) {}

  // Idempotent on `reference` (§3.4): the pre-check handles the common
  // retry case without touching Kora at all; the unique-constraint catch is
  // the race-free backstop for two concurrent calls that both miss the
  // pre-check (mirrors UsersService.createUser's approach to the same
  // problem — insert-and-catch, not a lock).
  async fundWallet(
    userId: string,
    dto: FundWalletDto,
  ): Promise<FundWalletResponseDto> {
    const existing = await this.ledgerService.findTransactionByReference(
      dto.reference,
    );
    if (existing) {
      return { checkoutUrl: existing.metadata.checkoutUrl };
    }

    const [user, wallet] = await Promise.all([
      this.usersService.findById(userId),
      this.ledgerService.getUserWallet(userId),
    ]);
    const amount = Money.of(dto.amount, NGN);

    const result = await this.adapter.initiatePayment({
      reference: dto.reference,
      amount,
      customerEmail: user.email,
    });

    try {
      await this.ledgerService.createPendingFundingTransaction({
        reference: dto.reference,
        provider: 'kora',
        providerReference: dto.reference,
        amount,
        recipientWalletId: wallet.id,
        metadata: { checkoutUrl: result.checkoutUrl },
      });
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_transactions_reference')) {
        const raced = await this.ledgerService.findTransactionByReference(
          dto.reference,
        );
        if (raced) {
          return { checkoutUrl: raced.metadata.checkoutUrl };
        }
      }
      throw error;
    }

    return { checkoutUrl: result.checkoutUrl };
  }
}
