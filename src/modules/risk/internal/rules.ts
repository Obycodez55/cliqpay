export interface RuleHit {
  evidence: Record<string, unknown>;
}

export interface MuleFanInParams {
  minDistinctSenders: number;
  windowHours: number;
  minWithdrawalSharePercent: number;
}

export interface NewAccountLargeWithdrawalParams {
  maxAccountAgeDays: number;
  minAmountMinor: number;
}

export interface TaintedInflowParams {
  minAmountMinor: number;
  windowHours: number;
}

export interface SendBurstParams {
  burstSends: number;
  burstWindowMinutes: number;
  newRecipients: number;
  newRecipientWindowMinutes: number;
}

export interface SharedDeviceParams {
  minUsers: number;
  windowDays: number;
}

export interface Inflow {
  senderUserId: string;
  total: bigint;
}

export function muleFanIn(
  params: MuleFanInParams,
  withdrawalMinor: bigint,
  inflows: Inflow[],
): RuleHit | null {
  const inflowMinor = inflows.reduce((sum, i) => sum + i.total, 0n);
  if (inflows.length < params.minDistinctSenders) {
    return null;
  }
  if (
    withdrawalMinor * 100n <
    inflowMinor * BigInt(params.minWithdrawalSharePercent)
  ) {
    return null;
  }
  return {
    evidence: {
      distinctSenders: inflows.length,
      inflowMinor: inflowMinor.toString(),
      withdrawalMinor: withdrawalMinor.toString(),
    },
  };
}

export function newAccountLargeWithdrawal(
  params: NewAccountLargeWithdrawalParams,
  withdrawalMinor: bigint,
  accountAgeMs: number,
): RuleHit | null {
  const maxAgeMs = params.maxAccountAgeDays * 24 * 60 * 60 * 1000;
  if (
    accountAgeMs >= maxAgeMs ||
    withdrawalMinor < BigInt(params.minAmountMinor)
  ) {
    return null;
  }
  return {
    evidence: {
      accountAgeHours: Math.floor(accountAgeMs / (60 * 60 * 1000)),
      withdrawalMinor: withdrawalMinor.toString(),
    },
  };
}

export function taintedInflow(
  params: TaintedInflowParams,
  inflows: Inflow[],
  taintedSenderIds: ReadonlySet<string>,
): RuleHit | null {
  const tainted = inflows.filter((i) => taintedSenderIds.has(i.senderUserId));
  const totalMinor = tainted.reduce((sum, i) => sum + i.total, 0n);
  if (totalMinor < BigInt(params.minAmountMinor)) {
    return null;
  }
  return {
    evidence: {
      taintedSenders: tainted.map((i) => i.senderUserId),
      taintedInflowMinor: totalMinor.toString(),
    },
  };
}

export function sendBurst(
  params: SendBurstParams,
  velocity: { sends: number; firstTimeRecipients: number },
): RuleHit | null {
  if (
    velocity.sends < params.burstSends &&
    velocity.firstTimeRecipients < params.newRecipients
  ) {
    return null;
  }
  return { evidence: { ...velocity } };
}

export function sharedDevice(
  params: SharedDeviceParams,
  deviceId: string,
  usersOnDevice: number,
): RuleHit | null {
  if (usersOnDevice < params.minUsers) {
    return null;
  }
  return { evidence: { deviceId, usersOnDevice } };
}

export function deviceIntegrity(
  deviceId: string,
  attestationResult: string,
): RuleHit | null {
  return attestationResult === 'failed'
    ? { evidence: { deviceId, attestationResult } }
    : null;
}
