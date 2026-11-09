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

// req.ip is the socket address unless TRUST_PROXY is set, in which case
// Express resolves it from X-Forwarded-For through the trusted hops only, so
// a client can't spoof it.
export function extractDeviceMetadata(req: Request): DeviceMetadata {
  return {
    ipAddress: req.ip ?? req.socket.remoteAddress ?? 'unknown',
    userAgent: req.headers['user-agent'] ?? null,
  };
}
