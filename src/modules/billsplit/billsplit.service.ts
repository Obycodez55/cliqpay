import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { Money } from '../../shared/primitives/money';
import { toIdentitySummary } from '../../common/dto/identity-summary.dto';
import { isUniqueViolation } from '../../database/postgres-errors.util';
import { runInTransaction } from '../../database/transaction.util';
import {
  SplitRequestRecord,
  TransfersService,
} from '../transfers/transfers.service';
import { UsersService } from '../users/users.service';
import { CreateBillSplitDto } from './dto/create-bill-split.dto';
import {
  BillSplitApiStatus,
  BillSplitResponseDto,
} from './dto/bill-split-response.dto';
import { BillSplit } from './entities/bill-split.entity';
import { BillSplitParticipant } from './entities/bill-split-participant.entity';
import {
  BillSplitNotFoundException,
  BillSplitParticipantsInvalidException,
  BillSplitReferenceReusedException,
} from './internal/errors';
import { ComputedShares, computeShares } from './internal/shares';

const NGN = 'NGN';
const DAY_MS = 24 * 60 * 60 * 1000;
const UNIQUE_REFERENCE = 'UQ_bill_splits_initiator_user_id_reference';

interface WriteSplitParams {
  initiatorId: string;
  dto: CreateBillSplitDto;
  computed: ComputedShares;
  expiresAt: Date;
  now: Date;
}

@Injectable()
export class BillSplitService {
  constructor(
    // @InjectDataSource: creation writes the split, its participants and
    // all its money requests in one transaction.
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transfersService: TransfersService,
    private readonly usersService: UsersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createSplit(
    initiatorId: string,
    dto: CreateBillSplitDto,
  ): Promise<BillSplitResponseDto> {
    const participantIds = dto.participants.map((p) => p.userId);
    if (participantIds.includes(initiatorId)) {
      throw new BillSplitParticipantsInvalidException(
        'You cannot be a participant in your own split; your share is counted automatically',
      );
    }
    if (new Set(participantIds).size !== participantIds.length) {
      throw new BillSplitParticipantsInvalidException(
        'Participants must be distinct',
      );
    }
    const { maxParticipants } = this.config.billSplits;
    if (participantIds.length > maxParticipants) {
      throw new BillSplitParticipantsInvalidException(
        `A split can have at most ${maxParticipants} participants`,
      );
    }

    const computed = computeShares(
      dto.mode,
      Money.of(dto.total, NGN),
      dto.participants,
      Money.of(this.config.transfers.minAmount, NGN),
    );

    const replayed = await this.findReplay(initiatorId, dto, computed);
    if (replayed) {
      return this.loadView(replayed);
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.moneyRequests.expiryDays * DAY_MS,
    );

    let created: { splitId: string; requests: SplitRequestRecord[] };
    try {
      created = await runInTransaction(this.dataSource, (manager) =>
        this.writeSplit(manager, {
          initiatorId,
          dto,
          computed,
          expiresAt,
          now,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, UNIQUE_REFERENCE)) {
        const raced = await this.findReplay(initiatorId, dto, computed);
        if (raced) {
          return this.loadView(raced);
        }
      }
      throw error;
    }

    await this.transfersService.publishSplitRequestsCreated(
      initiatorId,
      created.requests,
    );
    return this.loadView(created.splitId);
  }

  // Visible to the initiator and the participants; everyone else, and a
  // missing id, get the same 404.
  async getSplit(
    viewerId: string,
    splitId: string,
  ): Promise<BillSplitResponseDto> {
    const view = await this.loadView(splitId);
    const isMember =
      view.initiator.userId === viewerId ||
      view.participants.some((p) => p.userId === viewerId);
    if (!isMember) {
      throw new BillSplitNotFoundException();
    }
    return view;
  }

  private async writeSplit(
    manager: EntityManager,
    params: WriteSplitParams,
  ): Promise<{ splitId: string; requests: SplitRequestRecord[] }> {
    const { initiatorId, dto, computed } = params;
    const splitRepo = manager.getRepository(BillSplit);
    const split = await splitRepo.save(
      splitRepo.create({
        initiatorUserId: initiatorId,
        reference: dto.reference,
        description: dto.description,
        mode: dto.mode,
        totalAmount: BigInt(dto.total),
        initiatorShare: computed.initiatorShare.amount,
        currency: NGN,
        expiresAt: params.expiresAt,
      }),
    );

    const requests = await this.transfersService.createSplitRequests(manager, {
      requesterId: initiatorId,
      shares: computed.shares.map((share) => ({
        payerUserId: share.userId,
        amount: Number(share.amount.amount),
      })),
      note: dto.description,
      expiresAt: params.expiresAt,
      now: params.now,
    });

    await manager.getRepository(BillSplitParticipant).insert(
      requests.map((request) => ({
        billSplitId: split.id,
        userId: request.payerUserId,
        amount: request.amount,
        moneyRequestId: request.id,
      })),
    );
    return { splitId: split.id, requests };
  }

  // The original split's id when this initiator already used `reference`
  // with the same contents, null when the reference is new, and a 409 when
  // the contents differ.
  private async findReplay(
    initiatorId: string,
    dto: CreateBillSplitDto,
    computed: ComputedShares,
  ): Promise<string | null> {
    const existing = await this.dataSource.getRepository(BillSplit).findOneBy({
      initiatorUserId: initiatorId,
      reference: dto.reference,
    });
    if (!existing) {
      return null;
    }
    const stored = await this.dataSource
      .getRepository(BillSplitParticipant)
      .findBy({ billSplitId: existing.id });
    const storedShares = new Map(stored.map((p) => [p.userId, p.amount]));
    const same =
      existing.mode === dto.mode &&
      existing.totalAmount === BigInt(dto.total) &&
      existing.description === dto.description &&
      storedShares.size === computed.shares.length &&
      computed.shares.every(
        (share) => storedShares.get(share.userId) === share.amount.amount,
      );
    if (!same) {
      throw new BillSplitReferenceReusedException();
    }
    return existing.id;
  }

  private async loadView(splitId: string): Promise<BillSplitResponseDto> {
    const split = await this.dataSource
      .getRepository(BillSplit)
      .findOneBy({ id: splitId });
    if (!split) {
      throw new BillSplitNotFoundException();
    }
    const participants = await this.dataSource
      .getRepository(BillSplitParticipant)
      .findBy({ billSplitId: splitId });
    participants.sort((a, b) => (a.userId < b.userId ? -1 : 1));

    const [requests, users] = await Promise.all([
      this.transfersService.findMoneyRequestsByIds(
        participants.map((p) => p.moneyRequestId),
      ),
      this.usersService.findByIds([
        split.initiatorUserId,
        ...participants.map((p) => p.userId),
      ]),
    ]);
    const requestById = new Map(requests.map((r) => [r.id, r]));
    const userById = new Map(users.map((u) => [u.id, u]));

    const initiator = userById.get(split.initiatorUserId);
    if (!initiator) {
      throw new Error(
        `BillSplitService.loadView: initiator ${split.initiatorUserId} not found for split ${split.id}`,
      );
    }

    const rows = participants.map((participant) => {
      const user = userById.get(participant.userId);
      const request = requestById.get(participant.moneyRequestId);
      if (!user || !request) {
        throw new Error(
          `BillSplitService.loadView: participant ${participant.userId} or request ${participant.moneyRequestId} not found for split ${split.id}`,
        );
      }
      return {
        ...toIdentitySummary(user),
        share: Money.of(participant.amount, split.currency).toJSON(),
        moneyRequestId: participant.moneyRequestId,
        status: request.status,
      };
    });

    const anyUnpaid = rows.some((row) => row.status !== 'paid');
    const status: BillSplitApiStatus =
      new Date() > split.expiresAt && anyUnpaid ? 'expired' : 'open';

    return {
      id: split.id,
      description: split.description,
      mode: split.mode,
      total: Money.of(split.totalAmount, split.currency).toJSON(),
      initiatorShare: Money.of(split.initiatorShare, split.currency).toJSON(),
      initiator: toIdentitySummary(initiator),
      status,
      participants: rows,
      expiresAt: split.expiresAt.toISOString(),
      createdAt: split.createdAt.toISOString(),
    };
  }
}
