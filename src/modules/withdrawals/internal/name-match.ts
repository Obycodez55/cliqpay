function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((token) => token.length > 0);
}

const MIN_TRUNCATED_PREFIX = 3;

// Banks cut long names at a fixed width, so the holder name's last word may
// be only the start of the real one.
function holderCovers(
  holder: string[],
  index: number,
  legalToken: string,
): boolean {
  const token = holder[index];
  if (token === legalToken) {
    return true;
  }
  return (
    index === holder.length - 1 &&
    token.length >= MIN_TRUNCATED_PREFIX &&
    legalToken.startsWith(token)
  );
}

// The KYC legal name is stored first, middle, last, so its last word is the
// surname. A holder name matches when it carries that surname and at least
// one other word of the legal name, whatever the order or punctuation.
// Initials never count, and each holder word is used once.
export function holderNameMatchesLegalName(
  holderName: string,
  legalName: string | null,
): boolean {
  if (!legalName) {
    return false;
  }
  const legal = nameTokens(legalName);
  const holder = nameTokens(holderName);
  if (legal.length < 2 || holder.length < 2) {
    return false;
  }
  const surname = legal[legal.length - 1];
  const others = legal.slice(0, -1).filter((token) => token.length > 1);
  if (surname.length < 2) {
    return false;
  }

  const used = new Set<number>();
  const take = (legalToken: string): boolean => {
    const exact = holder.findIndex(
      (token, i) => !used.has(i) && token === legalToken,
    );
    const index =
      exact >= 0
        ? exact
        : holder.findIndex(
            (_, i) => !used.has(i) && holderCovers(holder, i, legalToken),
          );
    if (index < 0) {
      return false;
    }
    used.add(index);
    return true;
  };

  return take(surname) && others.some((token) => take(token));
}
