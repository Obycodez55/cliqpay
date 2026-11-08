import { UpdateScheduledPaymentDto } from '../dto/update-scheduled-payment.dto';
import { ScheduledPayment } from '../entities/scheduled-payment.entity';
import {
  ScheduleEditLeavesNoRunException,
  ScheduleNextRunDateInvalidException,
  ScheduleNextRunDateRequiredException,
  ScheduleNoUpcomingRunException,
  ScheduleRecurrenceInvalidException,
} from './errors';
import {
  RunCursor,
  findNextRun,
  isValidIsoDate,
  lagosToday,
  startDateBounds,
} from './run-time';

export const PIN_GATED_FIELDS = [
  'amount',
  'interval',
  'nextRunDate',
  'endDate',
  'maxRuns',
] as const;

export type EditedField =
  | (typeof PIN_GATED_FIELDS)[number]
  | 'note'
  | 'visibility';

export interface EditPlan {
  changes: Partial<Record<EditedField, { from: unknown; to: unknown }>>;
  values: Pick<
    ScheduledPayment,
    | 'amount'
    | 'note'
    | 'visibility'
    | 'startDate'
    | 'anchorRunNumber'
    | 'intervalUnit'
    | 'intervalCount'
    | 'endDate'
    | 'maxRuns'
    | 'nextRunAt'
  >;
}

export function needsPin(dto: UpdateScheduledPaymentDto): boolean {
  return PIN_GATED_FIELDS.some((field) => dto[field] !== undefined);
}

export function pinGatedChanged(plan: EditPlan): boolean {
  return PIN_GATED_FIELDS.some((field) => plan.changes[field]);
}

function intervalOf(
  unit: ScheduledPayment['intervalUnit'],
  count: number | null,
): { unit: string; count: number } | null {
  return unit && count ? { unit, count } : null;
}

// Pure: the schedule row must already be locked by the caller, and
// `runsCreated` read under that lock.
export function planEdit(
  current: ScheduledPayment,
  runsCreated: number,
  dto: UpdateScheduledPaymentDto,
  now: Date,
  windowStart: string,
): EditPlan {
  const currentInterval = intervalOf(
    current.intervalUnit,
    current.intervalCount,
  );
  const interval =
    dto.interval === undefined
      ? currentInterval
      : dto.interval && { unit: dto.interval.unit, count: dto.interval.count };
  const endDate = dto.endDate === undefined ? current.endDate : dto.endDate;
  const maxRuns = dto.maxRuns === undefined ? current.maxRuns : dto.maxRuns;

  if (!interval && (endDate !== null || maxRuns !== null)) {
    throw new ScheduleRecurrenceInvalidException(
      'endDate and maxRuns need an interval; clear them to make this a one-time payment',
    );
  }
  if (endDate !== null && maxRuns !== null) {
    throw new ScheduleRecurrenceInvalidException(
      'Set at most one of endDate and maxRuns; send null for the other to clear it',
    );
  }
  if (dto.endDate && !isValidIsoDate(dto.endDate)) {
    throw new ScheduleRecurrenceInvalidException('endDate must be a real date');
  }
  if (dto.maxRuns != null && dto.maxRuns < runsCreated) {
    throw new ScheduleRecurrenceInvalidException(
      `maxRuns must be at least ${runsCreated}, the runs already created`,
    );
  }
  if (dto.nextRunDate !== undefined) {
    const { min, max } = startDateBounds(now);
    if (
      !isValidIsoDate(dto.nextRunDate) ||
      dto.nextRunDate < min ||
      dto.nextRunDate > max
    ) {
      throw new ScheduleNextRunDateInvalidException(min, max);
    }
  }

  const currentNextDate = current.nextRunAt
    ? lagosToday(current.nextRunAt)
    : null;
  const intervalChanged =
    dto.interval !== undefined &&
    JSON.stringify(interval) !== JSON.stringify(currentInterval);
  const dateChanged =
    dto.nextRunDate !== undefined && dto.nextRunDate !== currentNextDate;

  // A change of rhythm restarts it at a run: the requested date, or the run
  // that was going to happen next.
  let anchorDate: string | null = null;
  if (dateChanged || intervalChanged) {
    if (current.status === 'active' && currentNextDate === null) {
      throw new ScheduleNoUpcomingRunException();
    }
    anchorDate = dateChanged ? dto.nextRunDate! : currentNextDate;
    if (anchorDate === null) {
      throw new ScheduleNextRunDateRequiredException();
    }
  }

  const nextDate = anchorDate ?? currentNextDate;
  if (endDate !== null && nextDate !== null && endDate < nextDate) {
    throw new ScheduleRecurrenceInvalidException(
      `endDate must be on or after the next run date, ${nextDate}`,
    );
  }

  const cursor: RunCursor = {
    startDate: anchorDate ?? current.startDate,
    anchorRunNumber: anchorDate
      ? current.nextRunNumber
      : current.anchorRunNumber,
    intervalUnit: (interval?.unit as RunCursor['intervalUnit']) ?? null,
    intervalCount: interval?.count ?? null,
    endDate,
    maxRuns,
    nextRunNumber: current.nextRunNumber,
    runOffsetMinutes: current.runOffsetMinutes,
  };

  let nextRunAt: Date | null = null;
  if (current.status === 'active') {
    const next = findNextRun(cursor, runsCreated, windowStart);
    nextRunAt = next?.dueAt ?? null;
    const exhausted = maxRuns !== null && runsCreated >= maxRuns;
    if (!next && !exhausted && current.nextRunAt !== null) {
      throw new ScheduleEditLeavesNoRunException();
    }
  } else if (
    (dto.interval !== undefined ||
      dto.nextRunDate !== undefined ||
      dto.endDate !== undefined ||
      dto.maxRuns !== undefined) &&
    !findNextRun(cursor, runsCreated, windowStart, now)
  ) {
    throw new ScheduleEditLeavesNoRunException();
  }

  const changes: EditPlan['changes'] = {};
  if (dto.amount !== undefined && BigInt(dto.amount) !== current.amount) {
    changes.amount = {
      from: current.amount.toString(),
      to: String(dto.amount),
    };
  }
  if (intervalChanged) {
    changes.interval = { from: currentInterval, to: interval };
  }
  if (dateChanged) {
    changes.nextRunDate = { from: currentNextDate, to: dto.nextRunDate };
  }
  if (dto.endDate !== undefined && dto.endDate !== current.endDate) {
    changes.endDate = { from: current.endDate, to: dto.endDate };
  }
  if (dto.maxRuns !== undefined && dto.maxRuns !== current.maxRuns) {
    changes.maxRuns = { from: current.maxRuns, to: dto.maxRuns };
  }
  if (dto.note !== undefined && dto.note !== current.note) {
    changes.note = { from: current.note, to: dto.note };
  }
  if (dto.visibility !== undefined && dto.visibility !== current.visibility) {
    changes.visibility = { from: current.visibility, to: dto.visibility };
  }

  return {
    changes,
    values: {
      amount: changes.amount ? BigInt(dto.amount!) : current.amount,
      note: dto.note === undefined ? current.note : dto.note,
      visibility: dto.visibility ?? current.visibility,
      startDate: cursor.startDate,
      anchorRunNumber: cursor.anchorRunNumber,
      intervalUnit: cursor.intervalUnit,
      intervalCount: cursor.intervalCount,
      endDate,
      maxRuns,
      nextRunAt: current.status === 'active' ? nextRunAt : null,
    },
  };
}
