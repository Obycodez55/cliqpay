// Decoder for the CBOR subset in an App Attest attestation object: unsigned
// integers, byte strings, text strings, arrays and maps with string keys.
export function decodeCbor(buffer: Buffer): unknown {
  const reader = { offset: 0 };
  const value = readItem(buffer, reader);
  if (reader.offset !== buffer.length) {
    throw new Error('Trailing bytes after CBOR item');
  }
  return value;
}

function readLength(
  buffer: Buffer,
  reader: { offset: number },
  info: number,
): number {
  if (info < 24) return info;
  const size = { 24: 1, 25: 2, 26: 4 }[info];
  if (!size) throw new Error('Unsupported CBOR length');
  const bytes = buffer.subarray(reader.offset, reader.offset + size);
  if (bytes.length !== size) throw new Error('Truncated CBOR');
  reader.offset += size;
  return bytes.readUIntBE(0, size);
}

function readItem(buffer: Buffer, reader: { offset: number }): unknown {
  if (reader.offset >= buffer.length) throw new Error('Truncated CBOR');
  const initial = buffer[reader.offset++];
  const major = initial >> 5;
  const length = readLength(buffer, reader, initial & 0x1f);

  switch (major) {
    case 0:
      return length;
    case 2:
    case 3: {
      const bytes = buffer.subarray(reader.offset, reader.offset + length);
      if (bytes.length !== length) throw new Error('Truncated CBOR');
      reader.offset += length;
      return major === 2 ? Buffer.from(bytes) : bytes.toString('utf8');
    }
    case 4: {
      const items: unknown[] = [];
      for (let i = 0; i < length; i++) items.push(readItem(buffer, reader));
      return items;
    }
    case 5: {
      const map = new Map<string, unknown>();
      for (let i = 0; i < length; i++) {
        const key = readItem(buffer, reader);
        if (typeof key !== 'string') throw new Error('Non-string CBOR key');
        map.set(key, readItem(buffer, reader));
      }
      return map;
    }
    default:
      throw new Error('Unsupported CBOR type');
  }
}
