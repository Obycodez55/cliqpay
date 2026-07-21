import { Request } from 'express';

// Stored as-is in the `device` jsonb column on both Session and TrustedDevice
// — same shape, captured independently at different moments, see ADR-0003.
// A fixed, known shape (not a heterogeneous provider payload like
// transactions.metadata), so it's typed concretely rather than
// Record<string, unknown> even though Postgres itself won't enforce it.
export interface DeviceMetadata {
  ipAddress: string;
  userAgent: string | null;
}

// No trust-proxy config exists yet, so this reads the socket-level address
// (req.ip) rather than trusting an X-Forwarded-For header a client could
// spoof; revisit once the app actually sits behind a configured proxy.
export function extractDeviceMetadata(req: Request): DeviceMetadata {
  return {
    ipAddress: req.ip ?? req.socket.remoteAddress ?? 'unknown',
    userAgent: req.headers['user-agent'] ?? null,
  };
}
