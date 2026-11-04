import { KycTier } from '../../users/users.service';

const TIER_ORDER: KycTier[] = ['tier0', 'tier1', 'tier2', 'tier3'];

export function tierRank(tier: KycTier): number {
  return TIER_ORDER.indexOf(tier);
}

export interface VerifiedState {
  bvnVerified: boolean;
  ninVerified: boolean;
  livenessVerified: boolean;
}

export function deriveTier(state: VerifiedState): KycTier {
  if (state.bvnVerified && state.ninVerified && state.livenessVerified) {
    return 'tier3';
  }
  if (state.bvnVerified && state.ninVerified) {
    return 'tier2';
  }
  if (state.bvnVerified || state.ninVerified) {
    return 'tier1';
  }
  return 'tier0';
}
