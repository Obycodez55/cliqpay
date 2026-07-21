import { Request, Response } from 'express';

// Web-first, no mobile client yet (issue #4) — a full cookie-parsing
// dependency for one cookie this module owns isn't worth adding; reading
// the raw `Cookie` header is a few lines. Writing needs no such helper —
// Express's `res.cookie()` doesn't require `cookie-parser`, only reading
// `req.cookies` does.
export const TRUSTED_DEVICE_COOKIE_NAME = 'cliqpay_trusted_device';

export function readTrustedDeviceCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    if (name === TRUSTED_DEVICE_COOKIE_NAME) {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    }
  }
  return null;
}

export function setTrustedDeviceCookie(
  res: Response,
  token: string,
  maxAgeMs: number,
  secure: boolean,
): void {
  res.cookie(TRUSTED_DEVICE_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: maxAgeMs,
  });
}
