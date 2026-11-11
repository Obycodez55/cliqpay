import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { Money } from '../../../shared/primitives/money';
import {
  ScamCase,
  ScamCaseStatus,
  ScamCategory,
} from '../entities/scam-case.entity';

export const SCAM_REPORT_NEXT_STEPS = [
  'We are holding the reported amount from the recipient while we review.',
  'The recipient is asked for their side of what happened.',
  'A reviewer decides within 14 working days. We will tell you the outcome and, if it is not in your favour, why.',
  'Do not send more money to this person. If you are in danger or are being threatened, contact the police.',
];

export class ScamReportAckDto {
  @ApiProperty({ example: 'SCM-000123' })
  reference: string;

  @ApiProperty({ enum: ['open', 'upheld', 'rejected', 'withdrawn'] })
  status: ScamCaseStatus;

  @ApiProperty({
    description: 'Reported more than 72 hours after the transfer.',
  })
  late: boolean;

  @ApiProperty({
    description: 'When the investigation is due (14 working days).',
  })
  dueAt: string;

  @ApiProperty({ type: MoneyDto })
  reportedAmount: MoneyDto;

  @ApiProperty({ type: [String] })
  nextSteps: string[];
}

export class ScamReportViewDto extends ScamReportAckDto {
  @ApiProperty({ type: MoneyDto, description: 'Returned to you so far.' })
  recoveredAmount: MoneyDto;

  @ApiProperty({ nullable: true })
  decisionReason: string | null;

  @ApiProperty({ nullable: true })
  decidedAt: string | null;

  @ApiProperty({
    enum: [
      'impersonation',
      'fake_goods_or_services',
      'investment',
      'romance',
      'other',
    ],
  })
  category: ScamCategory;

  @ApiProperty()
  createdAt: string;
}

export function toScamReportAck(scamCase: ScamCase): ScamReportAckDto {
  return {
    reference: scamCase.reference,
    status: scamCase.status,
    late: scamCase.late,
    dueAt: scamCase.dueAt.toISOString(),
    reportedAmount: Money.of(
      scamCase.reportedAmount,
      scamCase.currency,
    ).toJSON(),
    nextSteps: SCAM_REPORT_NEXT_STEPS,
  };
}

export function toScamReportView(scamCase: ScamCase): ScamReportViewDto {
  return {
    ...toScamReportAck(scamCase),
    recoveredAmount: Money.of(
      scamCase.recoveredAmount,
      scamCase.currency,
    ).toJSON(),
    decisionReason:
      scamCase.status === 'rejected' ? scamCase.decisionReason : null,
    decidedAt: scamCase.decidedAt?.toISOString() ?? null,
    category: scamCase.category,
    createdAt: scamCase.createdAt.toISOString(),
  };
}

export function displayAmount(minor: bigint, currency: string): string {
  return Money.of(minor, currency).toDecimalString();
}

export function toScamCaseReviewView(scamCase: ScamCase) {
  const money = (minor: bigint) => Money.of(minor, scamCase.currency).toJSON();
  return {
    id: scamCase.id,
    reference: scamCase.reference,
    status: scamCase.status,
    transactionId: scamCase.transactionId,
    reporterUserId: scamCase.reporterUserId,
    recipientUserId: scamCase.recipientUserId,
    category: scamCase.category,
    description: scamCase.description,
    contactChannel: scamCase.contactChannel,
    late: scamCase.late,
    dueAt: scamCase.dueAt.toISOString(),
    reportedAmount: money(scamCase.reportedAmount),
    heldAmount: money(scamCase.heldAmount),
    shortfall: money(scamCase.reportedAmount - scamCase.heldAmount),
    recoveredAmount: money(scamCase.recoveredAmount),
    reimbursedAmount:
      scamCase.reimbursedAmount === null
        ? null
        : money(scamCase.reimbursedAmount),
    recipientResponse: scamCase.recipientResponse,
    recipientRespondedAt: scamCase.recipientRespondedAt?.toISOString() ?? null,
    restrictionAdded: scamCase.restrictionAdded,
    decisionReason: scamCase.decisionReason,
    decidedBy: scamCase.decidedBy,
    decidedAt: scamCase.decidedAt?.toISOString() ?? null,
    createdAt: scamCase.createdAt.toISOString(),
  };
}
