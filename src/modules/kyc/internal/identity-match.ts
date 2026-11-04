export interface VerifiedIdentity {
  legalName?: string;
  dateOfBirth?: string; // ISO YYYY-MM-DD
}

function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((token) => token.length > 0);
}

// An initial stands in for any token starting with that letter.
function hasToken(tokens: string[], token: string): boolean {
  return token.length === 1
    ? tokens.some((candidate) => candidate.startsWith(token))
    : tokens.includes(token);
}

function covers(shorter: string[], longer: string[]): boolean {
  if (!shorter.every((token) => hasToken(longer, token))) {
    return false;
  }
  return (
    shorter.length === 1 ||
    shorter.filter((token) => token.length > 1).length >= 2
  );
}

function namesMatch(a: string, b: string): boolean {
  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return false;
  }
  if (tokensA.length === tokensB.length) {
    return covers(tokensA, tokensB) || covers(tokensB, tokensA);
  }
  return tokensA.length < tokensB.length
    ? covers(tokensA, tokensB)
    : covers(tokensB, tokensA);
}

// Whether two lookups describe the same person. A missing name fails closed;
// a missing date of birth on either side leaves the names to decide.
export function identitiesMatch(
  a: VerifiedIdentity,
  b: VerifiedIdentity,
): boolean {
  if (!a.legalName || !b.legalName || !namesMatch(a.legalName, b.legalName)) {
    return false;
  }
  if (a.dateOfBirth && b.dateOfBirth) {
    return a.dateOfBirth === b.dateOfBirth;
  }
  return true;
}
