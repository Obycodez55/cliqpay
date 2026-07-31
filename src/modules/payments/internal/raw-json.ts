// Kora signs `JSON.stringify(data)` over their own server-side object, not
// the whole webhook body — parsing the raw body then re-serializing
// `body.data` ourselves risks a byte mismatch against what Kora actually
// hashed (number reformatting, key order) even though it usually matches.
// Slicing the raw bytes directly out of the body for the top-level "data"
// field sidesteps that: whatever Kora wrote there is exactly what gets
// hashed, no round trip through JSON.parse/JSON.stringify.
export function extractTopLevelJsonField(
  raw: Buffer,
  key: string,
): Buffer | null {
  const text = raw.toString('utf8');
  const keyIndex = findTopLevelKey(text, key);
  if (keyIndex === null) {
    return null;
  }

  let i = keyIndex;
  while (i < text.length && /\s/.test(text[i])) i++;

  const start = i;
  const ch = text[i];
  if (ch === '{' || ch === '[') {
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') {
          i++;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
      } else if (c === open) {
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return Buffer.from(text.slice(start, i), 'utf8');
  }

  // Scalar or string value — not the shape Kora's payload uses for `data`,
  // but handled for completeness rather than assuming an object.
  if (ch === '"') {
    i++;
    for (; i < text.length; i++) {
      if (text[i] === '\\') {
        i++;
      } else if (text[i] === '"') {
        i++;
        break;
      }
    }
    return Buffer.from(text.slice(start, i), 'utf8');
  }
  while (i < text.length && !',}]'.includes(text[i]) && !/\s/.test(text[i])) {
    i++;
  }
  return Buffer.from(text.slice(start, i), 'utf8');
}

// Finds `"key"` followed by `:` while only tracking string state at the
// top level of the object (depth 0) — good enough to avoid matching the
// substring inside a nested string value, and a wrong match only ever
// causes a signature mismatch (fail closed), never a security hole.
function findTopLevelKey(text: string, key: string): number | null {
  const needle = `"${key}"`;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      if (depth === 1 && text.startsWith(needle, i)) {
        let j = i + needle.length;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === ':') {
          return j + 1;
        }
      }
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
    }
  }
  return null;
}
