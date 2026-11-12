import { decodeCbor } from '../cbor.util';

describe('decodeCbor', () => {
  it('decodes maps, arrays, byte strings, text and integers', () => {
    // {"fmt": "x", "n": 300, "b": h'0102', "a": [1, 2]}
    const encoded = Buffer.from(
      'a4' +
        '63666d74' +
        '6178' +
        '616e' +
        '19012c' +
        '6162' +
        '420102' +
        '6161' +
        '820102',
      'hex',
    );

    const decoded = decodeCbor(encoded) as Map<string, unknown>;

    expect(decoded.get('fmt')).toBe('x');
    expect(decoded.get('n')).toBe(300);
    expect(decoded.get('b')).toEqual(Buffer.from([1, 2]));
    expect(decoded.get('a')).toEqual([1, 2]);
  });

  it('rejects truncated input and unsupported types', () => {
    expect(() => decodeCbor(Buffer.from('a1', 'hex'))).toThrow();
    expect(() => decodeCbor(Buffer.from('f5', 'hex'))).toThrow();
  });
});
