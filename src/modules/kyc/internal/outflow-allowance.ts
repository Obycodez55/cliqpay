import { SecurityControls } from '../../users/users.service';

export const NEW_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const COOLDOWN_WINDOW_MS = 24 * 60 * 60 * 1000;

export type OutflowTerm = 'tier' | 'user' | 'cooldown';

export interface OutflowInputs {
  dailyLimit: bigint;
  debitedToday: bigint;
  userLimit: bigint | null;
  cooldown: { cap: bigint; debitedRolling: bigint } | null;
}

function remainingBelow(limit: bigint, used: bigint): bigint {
  return limit > used ? limit - used : 0n;
}

// The binding term is the tightest one; on a tie the earlier of tier, user,
// cooldown wins, which is also the order a breach is reported in.
export function effectiveOutflow(inputs: OutflowInputs): {
  remaining: bigint;
  binding: OutflowTerm;
} {
  let remaining = remainingBelow(inputs.dailyLimit, inputs.debitedToday);
  let binding: OutflowTerm = 'tier';
  if (inputs.userLimit !== null) {
    const user = remainingBelow(inputs.userLimit, inputs.debitedToday);
    if (user < remaining) {
      remaining = user;
      binding = 'user';
    }
  }
  if (inputs.cooldown) {
    const cooldown = remainingBelow(
      inputs.cooldown.cap,
      inputs.cooldown.debitedRolling,
    );
    if (cooldown < remaining) {
      remaining = cooldown;
      binding = 'cooldown';
    }
  }
  return { remaining, binding };
}

// A schedule created before the cooldown began is a standing mandate from
// before any takeover, so the cap does not touch it.
export function cooldownApplies(
  controls: Pick<
    SecurityControls,
    'securityCooldownUntil' | 'securityCooldownStartedAt'
  >,
  now: Date,
  scheduleCreatedAt?: Date,
): boolean {
  if (
    controls.securityCooldownUntil === null ||
    controls.securityCooldownUntil <= now
  ) {
    return false;
  }
  return !(
    scheduleCreatedAt &&
    controls.securityCooldownStartedAt &&
    scheduleCreatedAt < controls.securityCooldownStartedAt
  );
}

export function newAccountCapEndsAt(
  controls: Pick<SecurityControls, 'tier1ReachedAt'>,
  now: Date,
): Date | null {
  if (!controls.tier1ReachedAt) {
    return null;
  }
  const endsAt = new Date(
    controls.tier1ReachedAt.getTime() + NEW_ACCOUNT_WINDOW_MS,
  );
  return endsAt > now ? endsAt : null;
}
