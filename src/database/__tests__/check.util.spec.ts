import { inList } from '../check.util';

describe('inList', () => {
  it('builds a quoted IN expression', () => {
    expect(inList('status', ['active', 'revoked'])).toBe(
      `"status" IN ('active', 'revoked')`,
    );
  });

  it('escapes single quotes in values', () => {
    expect(inList('name', ["o'brien"])).toBe(`"name" IN ('o''brien')`);
  });
});
