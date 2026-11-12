import { holderNameMatchesLegalName } from '../internal/name-match';

const LEGAL = 'Adebayo Olusegun Obikoya';

describe('holderNameMatchesLegalName', () => {
  it.each([
    ['the same name', 'Adebayo Olusegun Obikoya'],
    ['bank order, surname first', 'OBIKOYA ADEBAYO OLUSEGUN'],
    ['upper case', 'ADEBAYO OLUSEGUN OBIKOYA'],
    ['surname and first name only', 'OBIKOYA ADEBAYO'],
    ['surname and middle name only', 'Obikoya Olusegun'],
    ['stray punctuation', 'OBIKOYA, ADEBAYO.'],
    ['extra whitespace', '  Obikoya    Adebayo '],
    ['an extra word the legal name lacks', 'OBIKOYA ADEBAYO MR'],
    ['accents', 'Ádebayo Obikóya'],
  ])('matches %s', (_label, holder) => {
    expect(holderNameMatchesLegalName(holder, LEGAL)).toBe(true);
  });

  it.each([
    ['a different surname', 'ADEBAYO OLUSEGUN SMITH'],
    ['the surname alone', 'OBIKOYA'],
    ['a first name alone', 'ADEBAYO OLUSEGUN'],
    ['an unrelated person', 'Grace Hopper'],
    ['an initial standing for the other name', 'OBIKOYA A'],
    ['a business account', 'OBIKOYA VENTURES LTD'],
  ])('rejects %s', (_label, holder) => {
    expect(holderNameMatchesLegalName(holder, LEGAL)).toBe(false);
  });

  describe('truncation', () => {
    it('accepts a surname cut short at the end of the holder name', () => {
      expect(holderNameMatchesLegalName('ADEBAYO OLUSEGUN OBIKO', LEGAL)).toBe(
        true,
      );
    });

    it('accepts a middle name cut short at the end of the holder name', () => {
      expect(holderNameMatchesLegalName('OBIKOYA ADEBAYO OLUSE', LEGAL)).toBe(
        true,
      );
    });

    it('does not accept a truncated word that is not last', () => {
      expect(holderNameMatchesLegalName('OBIKO ADEBAYO OLUSEGUN', LEGAL)).toBe(
        false,
      );
    });

    it('does not accept a cut shorter than three letters', () => {
      expect(holderNameMatchesLegalName('ADEBAYO OB', LEGAL)).toBe(false);
    });
  });

  describe('middle names', () => {
    it('matches on the first name when the legal name has no middle name', () => {
      expect(
        holderNameMatchesLegalName('Obikoya Adebayo', 'Adebayo Obikoya'),
      ).toBe(true);
    });

    it('matches any one of several other names', () => {
      expect(
        holderNameMatchesLegalName(
          'Obikoya Temitope',
          'Adebayo Temitope Olusegun Obikoya',
        ),
      ).toBe(true);
    });
  });

  describe('punctuation in names', () => {
    it('treats a hyphen as a separator', () => {
      expect(
        holderNameMatchesLegalName(
          'ADEYEMI-SMITH JOHN',
          'John Olu Adeyemi Smith',
        ),
      ).toBe(true);
    });

    it('drops apostrophes', () => {
      expect(
        holderNameMatchesLegalName("O'BRIEN SEAN", 'Sean Patrick OBrien'),
      ).toBe(true);
    });
  });

  it('fails closed without a verified legal name', () => {
    expect(holderNameMatchesLegalName('OBIKOYA ADEBAYO', null)).toBe(false);
  });

  it('fails closed on a single-word legal name', () => {
    expect(holderNameMatchesLegalName('OBIKOYA ADEBAYO', 'Obikoya')).toBe(
      false,
    );
  });

  it('does not count one holder word for two legal names', () => {
    expect(holderNameMatchesLegalName('OBIKOYA', 'Obikoya Obikoya')).toBe(
      false,
    );
  });
});
