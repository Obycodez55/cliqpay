import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, EntityNotFoundError } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import {
  IdempotentReplay,
  LedgerService,
  PostTransferResult,
} from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { KycService } from '../kyc/kyc.service';
import {
  PostOrigin,
  PostVisibility,
  SocialService,
} from '../social/social.service';
import { AuthService } from '../auth/auth.service';
import { Money } from '../../shared/primitives/money';
import { runInTransaction } from '../../database/transaction.util';
import {
  MONEY_REQUEST_CREATED_EVENT,
  MoneyRequestCreatedEventPayload,
  TRANSFER_RECEIVED_EVENT,
  TRANSFER_SENT_EVENT,
  TransferReceivedEventPayload,
  TransferSentEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { MoneyRequest } from './entities/money-request.entity';
import {
  MoneyRequestApiStatus,
  computeMoneyRequestApiStatus,
} from './dto/money-request-response.dto';
import { countEffectivelyPending } from './internal/money-request-queries';
import { SendTransferDto } from './dto/send-transfer.dto';
import { SendTransferResponseDto } from './dto/send-transfer-response.dto';
import {
  MoneyRequestAmountTooSmallException,
  MoneyRequestPairCapExceededException,
  PayerNotFoundException,
  RecipientUnableToReceiveException,
  RecipientWalletNotFoundException,
  SelfMoneyRequestException,
  SelfTransferException,
  SenderAccountFrozenException,
  SenderEmailNotVerifiedException,
  TransferAmountTooSmallException,
  UnsupportedTransferCurrencyException,
} from './internal/errors';
import { isUniqueViolation } from '../../database/postgres-errors.util';

const NGN = 'NGN'; // Transfers are NGN-only for now — see docs/architecture.md §6 Phase 3.

// Structural, not the `User`/`Account` entity types — transfers reaches
// users/ledger only through their exported service surfaces
// (docs/architecture.md §10).
type TransferSender = Awaited<ReturnType<UsersService['findById']>>;
type TransferWallet = Awaited<ReturnType<LedgerService['getUserWallet']>>;

export interface PreparedTransfer {
  sender: TransferSender;
  senderWallet: TransferWallet;
  recipientWallet: TransferWallet;
  recipientUserId: string;
  amount: Money;
}

// A replayed reference carrying a different note or visibility is rejected,
// even though neither is in the ledger fingerprint. A null visibility means
// the payment records no post and is compared on the note alone.
export interface TransferPostDetails {
  note: string | null;
  visibility: PostVisibility | null;
  origin?: PostOrigin;
}

export interface SplitRequestShare {
  payerUserId: string;
  amount: number; // minor units
}

export interface CreateSplitRequestsParams {
  requesterId: string;
  shares: SplitRequestShare[];
  note: string | null;
  expiresAt: Date;
  now: Date;
}

export interface SplitRequestRecord {
  id: string;
  payerUserId: string;
  amount: bigint;
  note: string | null;
  currency: string;
  fromFollowed: boolean;
}

export interface MoneyRequestSummary {
  id: string;
  payerUserId: string;
  amount: bigint;
  status: MoneyRequestApiStatus;
  transactionId: string | null;
  expiresAt: Date;
}

export interface ExecuteTransferParams {
  recipientUserId: string;
  amount: number; // minor units
  reference: string;
  pin: string;
  details: TransferPostDetails;
}

export interface FinalizeTransferOutcome {
  result: PostTransferResult;
  // True when a duplicate request racing this one committed first and its
  // result is returned instead.
  replayed: boolean;
}

export interface ExecuteTransferOutcome {
  result: PostTransferResult;
  // False only for the one call that actually posted new ledger entries —
  // every other outcome (idempotent replay, raced duplicate insert) must
  // not re-publish notifications for an event that already fired once.
  replayed: boolean;
  sender: TransferSender;
}

/**
 * The one exported surface of the transfers module — see
 * docs/architecture.md §10 and ADR-0011. Owns eligibility, PIN
 * verification, and idempotency; hands ledger the facts and lets it decide
 * what they post to.
 */
@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledgerService: LedgerService,
    private readonly usersService: UsersService,
    private readonly kycService: KycService,
    private readonly socialService: SocialService,
    private readonly authService: AuthService,
    private readonly eventBus: EventBusService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sendMoney(
    senderId: string,
    dto: SendTransferDto,
  ): Promise<SendTransferResponseDto> {
    const outcome = await this.executeTransfer(senderId, {
      recipientUserId: dto.recipientUserId,
      amount: dto.amount,
      reference: dto.reference,
      pin: dto.pin,
      details: { note: dto.note ?? null, visibility: dto.visibility },
    });

    if (!outcome.replayed) {
      await this.publishTransferEvents(
        outcome.result,
        outcome.sender,
        dto.recipientUserId,
        dto.note,
      );
    }

    return {
      transactionId: outcome.result.transactionId,
      reference: outcome.result.reference,
      amount: outcome.result.amount.toJSON(),
      fee: outcome.result.platformFee.toJSON(),
      recipientUserId: dto.recipientUserId,
      createdAt: outcome.result.createdAt.toISOString(),
    };
  }

  // Bounds/self-transfer/verified-email/wallet-resolution — every rule that
  // doesn't depend on idempotency or the PIN, shared by sendMoney and
  // MoneyRequestsService.payRequest (same-module peer, ADR-0011) so the two
  // money-movement entry points can't drift on what "eligible to send"
  // means.
  async prepareTransfer(
    senderId: string,
    recipientUserId: string,
    amountMinor: number,
  ): Promise<PreparedTransfer> {
    const { minAmount } = this.config.transfers;
    if (amountMinor < minAmount) {
      throw new TransferAmountTooSmallException(
        Money.of(minAmount, NGN).toDecimalString(),
      );
    }
    if (recipientUserId === senderId) {
      throw new SelfTransferException();
    }

    const sender = await this.usersService.findById(senderId);
    if (!sender.emailVerifiedAt) {
      throw new SenderEmailNotVerifiedException();
    }

    let recipientWallet: TransferWallet;
    try {
      recipientWallet = await this.ledgerService.getUserWallet(recipientUserId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new RecipientWalletNotFoundException();
      }
      throw error;
    }
    const senderWallet = await this.ledgerService.getUserWallet(senderId);

    // Currency is hardcoded below (no currency field on the DTO), so this
    // can't be reached through the real API today — defensive only, for the
    // day multi-currency wallets exist (Phase 10).
    if (senderWallet.currency !== NGN || recipientWallet.currency !== NGN) {
      throw new UnsupportedTransferCurrencyException();
    }

    return {
      sender,
      senderWallet,
      recipientWallet,
      recipientUserId,
      amount: Money.of(amountMinor, NGN),
    };
  }

  // Whether `reference` already has a result for this sender+operation —
  // split out from finalizeTransfer below so a caller that needs to gate on
  // something else first (MoneyRequestsService.payRequest gates on the
  // request's own pending/expiry state) can check for a replay — which must
  // always win regardless of that other state, since it proves this exact
  // operation already completed — without paying for a PIN verification it
  // may not need.
  async checkTransferReplay(
    senderId: string,
    prepared: PreparedTransfer,
    reference: string,
    details: TransferPostDetails,
  ): Promise<PostTransferResult | null> {
    // Only the fields that define the operation (ADR-0010) — the platform
    // fee is config-derived, never client-supplied, so it isn't part of the
    // fingerprint. `type` guards against a reference reused across a
    // different transaction type entirely (Phase 3 end-of-phase audit).
    const fingerprint = {
      type: 'p2p_transfer' as const,
      amount: prepared.amount.amount,
      currency: NGN,
      counterpartyWalletId: prepared.recipientWallet.id,
    };
    const replay = await this.ledgerService.checkIdempotentReplay(
      reference,
      senderId,
      fingerprint,
    );
    if (replay.outcome === 'match') {
      await this.assertSameDetails(replay.transaction, details);
    }
    return resolveReplayAsPostResult(replay, prepared);
  }

  private async assertSameDetails(
    transaction: { id: string; metadata: unknown },
    details: TransferPostDetails,
  ): Promise<void> {
    const storedNote =
      (transaction.metadata as { note?: string } | null)?.note ?? null;
    const storedVisibility = await this.socialService.getRequestedVisibility(
      transaction.id,
    );
    if (
      storedNote !== details.note ||
      (details.visibility !== null &&
        storedVisibility !== null &&
        storedVisibility !== details.visibility)
    ) {
      throw new ConflictException(
        'This reference was already used with a different note or visibility — use a new reference.',
      );
    }
  }

  // PIN verification and posting — called only once a caller has confirmed
  // there is no replay and the operation is actually eligible to proceed.
  // `manager` lets a caller with its own open transaction (paying a money
  // request must post the transfer and flip the request's status
  // atomically) fold this posting into it, rather than defaulting to
  // postTransfer's own implicit transaction.
  async finalizeTransfer(
    senderId: string,
    prepared: PreparedTransfer,
    reference: string,
    pin: string,
    details: TransferPostDetails,
    manager?: EntityManager,
  ): Promise<FinalizeTransferOutcome> {
    if (prepared.sender.isFrozen) {
      throw new SenderAccountFrozenException();
    }
    await this.authService.verifyTransactionPin(senderId, pin);

    const fee = Money.of(this.config.transfers.platformFee, NGN);
    const postParams = {
      reference,
      senderWalletId: prepared.senderWallet.id,
      recipientWalletId: prepared.recipientWallet.id,
      amount: prepared.amount,
      platformFee: fee,
      note: details.note,
    };

    const post = async (tx: EntityManager) => {
      if (
        await this.socialService.lockPairAndCheckBlock(
          tx,
          senderId,
          prepared.recipientUserId,
        )
      ) {
        throw new RecipientUnableToReceiveException();
      }
      await this.kycService.checkTransferLimits(
        tx,
        senderId,
        prepared.recipientUserId,
        prepared.amount,
        {
          readDebitedSince: (m, since) =>
            this.ledgerService.getDebitedSince(m, senderId, since),
          readRecipientBalanceAndPending: (m) =>
            this.ledgerService.getBalanceAndPendingFunding(
              m,
              prepared.recipientUserId,
            ),
        },
      );
      const result = await this.ledgerService.postTransferWithinTransaction(
        tx,
        postParams,
      );
      if (details.visibility) {
        await this.socialService.recordTransferPost(tx, {
          transactionId: result.transactionId,
          senderUserId: result.senderUserId,
          recipientUserId: result.recipientUserId,
          note: details.note,
          visibility: details.visibility,
          origin: details.origin,
        });
      }
      return result;
    };

    if (manager) {
      // A duplicate-reference race against *this same request* is
      // impossible on this path — the caller already holds a row lock (see
      // MoneyRequestsService.payRequest) that serializes concurrent
      // attempts before either reaches here. But that lock is per-request,
      // not per-reference: a client reusing this `reference` on a
      // *different* money request (or a plain sendMoney call) has no lock
      // relationship with this one, and would still hit
      // UQ_transactions_reference. Unlike the no-manager branch below, that
      // can't be recovered as a replay here — the failed insert has already
      // aborted this transaction at the Postgres level, so a further query
      // on `manager` (or letting the callback resolve "successfully" into a
      // commit of an aborted transaction) isn't safe. The caller already
      // ruled out a same-reference replay for this sender before reaching
      // here, so a collision now can only be a genuine clash with someone
      // else's transaction — map it to the same clean conflict the
      // no-manager path produces instead of a raw 500.
      try {
        return { result: await post(manager), replayed: false };
      } catch (error) {
        if (isUniqueViolation(error, 'UQ_transactions_reference')) {
          throw new ConflictException(
            'This reference has already been used for a different transfer.',
          );
        }
        throw error;
      }
    }

    try {
      return {
        result: await runInTransaction(this.dataSource, post),
        replayed: false,
      };
    } catch (error) {
      // A duplicate request racing this one may have committed first, so this
      // one fails on the unique reference or on the limit its twin just
      // consumed; the committed result is the answer, read after the failed
      // transaction has ended, and is reported as a replay.
      const raced = await this.checkTransferReplay(
        senderId,
        prepared,
        reference,
        details,
      );
      if (raced) {
        return { result: raced, replayed: true };
      }
      throw error;
    }
  }

  // The shared core of a plain P2P send — bounds/eligibility, the
  // idempotency replay check, then PIN verification and posting.
  // MoneyRequestsService.payRequest calls the three steps above directly
  // instead, since it needs to gate on the request's own pending/expiry
  // state in between the replay check and finalizeTransfer.
  async executeTransfer(
    senderId: string,
    params: ExecuteTransferParams,
    manager?: EntityManager,
  ): Promise<ExecuteTransferOutcome> {
    const prepared = await this.prepareTransfer(
      senderId,
      params.recipientUserId,
      params.amount,
    );

    const replayResult = await this.checkTransferReplay(
      senderId,
      prepared,
      params.reference,
      params.details,
    );
    if (replayResult) {
      return { result: replayResult, replayed: true, sender: prepared.sender };
    }

    // PIN checked only after a replay match would have short-circuited
    // above — a retried, already-successful send shouldn't demand the PIN
    // again, mirroring funding's checkoutUrl replay.
    const { result, replayed } = await this.finalizeTransfer(
      senderId,
      prepared,
      params.reference,
      params.pin,
      params.details,
      manager,
    );
    return { result, replayed, sender: prepared.sender };
  }

  // Writes one group_share request per share inside the caller's
  // transaction, so a caller that owns its own rows (a bill split) commits
  // or loses them together with the requests. Pair locks are taken in
  // ascending payer id order, which keeps two concurrent calls from one
  // requester from deadlocking. Any failing share throws and, with the
  // caller's rollback, leaves nothing written.
  async createSplitRequests(
    manager: EntityManager,
    params: CreateSplitRequestsParams,
  ): Promise<SplitRequestRecord[]> {
    const { requesterId, note, expiresAt, now } = params;
    const { minAmount } = this.config.transfers;
    const shares = [...params.shares].sort((a, b) =>
      a.payerUserId < b.payerUserId ? -1 : 1,
    );

    for (const share of shares) {
      if (share.payerUserId === requesterId) {
        throw new SelfMoneyRequestException();
      }
      if (share.amount < minAmount) {
        throw new MoneyRequestAmountTooSmallException(
          Money.of(minAmount, NGN).toDecimalString(),
        );
      }
    }

    const total = shares.reduce((sum, share) => sum + BigInt(share.amount), 0n);
    await this.kycService.checkCanReceive(
      manager,
      requesterId,
      Money.of(total, NGN),
      (m) => this.ledgerService.getBalanceAndPendingFunding(m, requesterId),
    );

    const payers = await this.usersService.findByIds(
      shares.map((share) => share.payerUserId),
    );
    const payerById = new Map(payers.map((payer) => [payer.id, payer]));
    if (payerById.size !== shares.length) {
      throw new PayerNotFoundException();
    }

    const { maxPendingPerPair } = this.config.moneyRequests;
    for (const share of shares) {
      if (
        await this.socialService.lockPairAndCheckBlock(
          manager,
          requesterId,
          share.payerUserId,
        )
      ) {
        throw new RecipientUnableToReceiveException();
      }
      const outstanding = await countEffectivelyPending(
        manager,
        requesterId,
        share.payerUserId,
        now,
      );
      if (outstanding >= maxPendingPerPair) {
        throw new MoneyRequestPairCapExceededException(
          maxPendingPerPair,
          payerById.get(share.payerUserId)!.username,
        );
      }
    }

    const repo = manager.getRepository(MoneyRequest);
    const created = await repo.save(
      shares.map((share) =>
        repo.create({
          requesterUserId: requesterId,
          payerUserId: share.payerUserId,
          amount: BigInt(share.amount),
          currency: NGN,
          note,
          kind: 'group_share',
          status: 'pending',
          expiresAt,
          transactionId: null,
        }),
      ),
    );

    const followed = await Promise.all(
      created.map((request) =>
        this.socialService.isFollowing(request.payerUserId, requesterId),
      ),
    );
    return created.map((request, i) => ({
      id: request.id,
      payerUserId: request.payerUserId,
      amount: request.amount,
      note: request.note,
      currency: request.currency,
      fromFollowed: followed[i],
    }));
  }

  // Live status of the given requests in one query. Ids that don't exist
  // are simply absent from the result.
  async findMoneyRequestsByIds(ids: string[]): Promise<MoneyRequestSummary[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.dataSource
      .getRepository(MoneyRequest)
      .createQueryBuilder('moneyRequest')
      .where('moneyRequest.id = ANY(:ids::uuid[])', { ids })
      .getMany();
    const now = new Date();
    return rows.map((row) => ({
      id: row.id,
      payerUserId: row.payerUserId,
      amount: row.amount,
      status: computeMoneyRequestApiStatus(row.status, row.expiresAt, now),
      transactionId: row.transactionId,
      expiresAt: row.expiresAt,
    }));
  }

  async publishSplitRequestsCreated(
    requesterId: string,
    requests: SplitRequestRecord[],
  ): Promise<void> {
    try {
      const users = await this.usersService.findByIds([
        requesterId,
        ...requests.map((request) => request.payerUserId),
      ]);
      const userById = new Map(users.map((user) => [user.id, user]));
      const requester = userById.get(requesterId);
      if (!requester) {
        return;
      }
      for (const request of requests) {
        const payer = userById.get(request.payerUserId);
        if (payer) {
          await this.publishMoneyRequestCreated(
            request,
            requester,
            payer,
            request.fromFollowed,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `publishSplitRequestsCreated: split requests created successfully, but loading their recipients failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  async publishMoneyRequestCreated(
    moneyRequest: {
      id: string;
      amount: bigint;
      currency: string;
      note: string | null;
    },
    requester: TransferSender,
    payer: TransferSender,
    fromFollowed: boolean,
  ): Promise<void> {
    try {
      await this.eventBus.publish<string, MoneyRequestCreatedEventPayload>({
        name: MONEY_REQUEST_CREATED_EVENT,
        payload: {
          userId: payer.id,
          email: payer.email,
          requesterUserId: requester.id,
          counterpartyUsername: requester.username,
          amount: Money.of(
            moneyRequest.amount,
            moneyRequest.currency,
          ).toDecimalString(),
          currency: moneyRequest.currency,
          note: moneyRequest.note,
          moneyRequestId: moneyRequest.id,
          fromFollowed,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `publishMoneyRequestCreated: money request "${moneyRequest.id}" created successfully, but publishing the notification failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishTransferEvents(
    result: PostTransferResult,
    sender: { email: string; username: string },
    recipientUserId: string,
    note: string | undefined,
  ): Promise<void> {
    try {
      const recipient = await this.usersService.findById(recipientUserId);
      const occurredAt = new Date();
      await this.eventBus.publish<string, TransferSentEventPayload>({
        name: TRANSFER_SENT_EVENT,
        payload: {
          userId: result.senderUserId,
          email: sender.email,
          counterpartyUsername: recipient.username,
          amount: result.amount.toDecimalString(),
          currency: result.amount.currency,
          reference: result.reference,
        },
        occurredAt,
      });
      await this.eventBus.publish<string, TransferReceivedEventPayload>({
        name: TRANSFER_RECEIVED_EVENT,
        payload: {
          userId: result.recipientUserId,
          email: recipient.email,
          counterpartyUsername: sender.username,
          amount: result.amount.toDecimalString(),
          currency: result.amount.currency,
          reference: result.reference,
          ...(note ? { note } : {}),
        },
        occurredAt,
      });
    } catch (error) {
      this.logger.error(
        `publishTransferEvents: transfer posted successfully (reference "${result.reference}"), but publishing the notifications failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}

// A reference belonging to another user must 409 with nothing about the
// other transaction attached (ADR-0010, defect 1). Returns null on 'none'
// so the caller falls through to actually posting the transfer.
function resolveReplayAsPostResult(
  replay: IdempotentReplay,
  prepared: PreparedTransfer,
): PostTransferResult | null {
  switch (replay.outcome) {
    case 'match': {
      const platformFee = replay.transaction.metadata as unknown as {
        platformFee: { amount: string; currency: string };
      };
      return {
        transactionId: replay.transaction.id,
        reference: replay.transaction.reference,
        senderUserId: prepared.senderWallet.userId!,
        recipientUserId: prepared.recipientWallet.userId!,
        amount: Money.of(
          replay.transaction.amount,
          replay.transaction.currency,
        ),
        platformFee: Money.of(
          BigInt(platformFee.platformFee.amount),
          platformFee.platformFee.currency,
        ),
        createdAt: replay.transaction.createdAt,
      };
    }
    case 'foreign':
      throw new ConflictException(
        'This reference has already been used for a different transfer.',
      );
    case 'diverged':
      throw new UnprocessableEntityException(
        'This reference was already used to send a different amount or to a different recipient — use a new reference.',
      );
    case 'none':
      return null;
  }
}
