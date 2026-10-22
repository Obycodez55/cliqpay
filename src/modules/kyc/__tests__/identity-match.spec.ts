import { identitiesMatch } from '../internal/identity-match';

const match = (a: string, b: string) =>
  identitiesMatch({ legalName: a }, { legalName: b });

describe('identitiesMatch', () => {
  describe('names', () => {
    it.each([
      ['identical names', 'Ada Lovelace', 'Ada Lovelace'],
      ['swapped order', 'Ada Obi Lovelace', 'Lovelace Ada Obi'],
      ['a missing middle name', 'Ada Lovelace', 'Ada Obi Lovelace'],
      ['an extra middle name', 'Ada Obi Lovelace', 'Ada Lovelace'],
      ['case and spacing', '  ADA   lovelace ', 'ada Lovelace'],
      ['diacritics', 'Adé Ọlá Okonkwo', 'Ade Ola Okonkwo'],
      ['a hyphenated surname', 'Ada Smith-Jones', 'Ada Smith Jones'],
      ['an apostrophe', "Chidi O'Brien", 'Chidi O Brien'],
      ['an initial for a middle name', 'Ada O Lovelace', 'Ada Obi Lovelace'],
      ['a single-token name present in the other', 'Lovelace', 'Ada Lovelace'],
    ])('matches %s', (_label, a, b) => {
      expect(match(a, b)).toBe(true);
      expect(match(b, a)).toBe(true);
    });

    it.each([
      ['completely different names', 'Ada Lovelace', 'Grace Hopper'],
      ['only one shared token', 'Ada Lovelace', 'Ada Hopper'],
      ['a shared token plus a different one', 'Ada Obi', 'Ada Okafor'],
      [
        'an initial not backed by a shared name',
        'A Lovelace',
        'Grace Lovelace',
      ],
      ['two initials only', 'A B', 'Ada Bola Obi'],
      ['a single token absent from the other', 'Hopper', 'Ada Lovelace'],
    ])('does not match %s', (_label, a, b) => {
      expect(match(a, b)).toBe(false);
      expect(match(b, a)).toBe(false);
    });

    it('fails closed when either name is missing or blank', () => {
      expect(identitiesMatch({}, { legalName: 'Ada Lovelace' })).toBe(false);
      expect(identitiesMatch({ legalName: 'Ada Lovelace' }, {})).toBe(false);
      expect(identitiesMatch({ legalName: '  ' }, { legalName: '' })).toBe(
        false,
      );
      expect(identitiesMatch({}, {})).toBe(false);
    });
  });

  describe('date of birth', () => {
    const names = { legalName: 'Ada Lovelace' };

    it('requires equal dates when both sides have one', () => {
      expect(
        identitiesMatch(
          { ...names, dateOfBirth: '1990-01-02' },
          { ...names, dateOfBirth: '1990-01-02' },
        ),
      ).toBe(true);
      expect(
        identitiesMatch(
          { ...names, dateOfBirth: '1990-01-02' },
          { ...names, dateOfBirth: '1990-02-01' },
        ),
      ).toBe(false);
    });

    it('lets the names decide when either side has no date', () => {
      expect(
        identitiesMatch({ ...names, dateOfBirth: '1990-01-02' }, names),
      ).toBe(true);
      expect(
        identitiesMatch(names, { ...names, dateOfBirth: '1990-01-02' }),
      ).toBe(true);
    });

    it('does not let a matching date rescue different names', () => {
      expect(
        identitiesMatch(
          { legalName: 'Ada Lovelace', dateOfBirth: '1990-01-02' },
          { legalName: 'Grace Hopper', dateOfBirth: '1990-01-02' },
        ),
      ).toBe(false);
    });
  });
});
