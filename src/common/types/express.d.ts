// Populated by the `verify` callback on the global json() body parser (see
// main.ts) — the exact bytes of the request body, captured before
// body-parser reformats anything. Only the webhook route reads it; every
// other route ignores it.
declare namespace Express {
  export interface Request {
    rawBody?: Buffer;
  }
}
