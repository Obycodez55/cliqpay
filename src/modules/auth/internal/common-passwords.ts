import { readFileSync } from 'fs';
import { join } from 'path';

// Loaded once at module load, not per check — see
// common-passwords.txt for provenance (SecLists' top-10k list).
const COMMON_PASSWORDS = new Set(
  readFileSync(join(__dirname, 'common-passwords.txt'), 'utf-8')
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean),
);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}
