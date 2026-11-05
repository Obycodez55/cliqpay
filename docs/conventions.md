# API Conventions

Decisions that `docs/architecture.md` calls for (§7 API Design: versioned routes, consistent envelope, pagination on all list endpoints) but doesn't pin down the exact shape of. This doc is that shape — every controller should follow it without re-deciding per endpoint.

## Versioning

URI versioning, applied globally with a default version so individual controllers don't need to opt in:

```ts
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
```

Every route is `/v1/...` unless a controller explicitly declares a different `version`. When a breaking change is needed for one resource, bump that controller's version rather than the whole app's.

## Response envelope

Every response — success or error — has the same top-level shape, applied by a global interceptor (success) and the global exception filter (error), not per-controller:

```jsonc
// success — ResponseEnvelopeInterceptor
{
  "success": true,
  "statusCode": 200,
  "data": { /* whatever the handler returned */ },
  "path": "/v1/wallets/me",
  "timestamp": "2026-07-20T16:00:00.000Z"
}

// error — AllExceptionsFilter
{
  "success": false,
  "statusCode": 400,
  "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed", "details": [...] },
  "path": "/v1/wallets/me",
  "timestamp": "2026-07-20T16:00:00.000Z"
}
```

`success` is always the discriminant a client checks first. Never hand-roll a response shape in a controller — return the raw payload and let the interceptor wrap it.

## Pagination

**Cursor-based, not offset**, for every list endpoint. Chosen because the two heaviest list endpoints in this system — transaction history and the social feed — are both append-mostly, high-write tables: offset pagination re-numbers every page as new rows land between requests (a transaction lands while a user is on page 2, and page 3 either repeats or skips a row), and `OFFSET n` gets slower as `n` grows. Cursor pagination has neither problem.

Convention:

- Query params: `cursor` (opaque string, optional) and `limit` (1–100, default 20) — see `CursorPaginationQueryDto` in `src/common/dto/`.
- Response shape: `{ items: T[], nextCursor: string | null }` — see `PaginatedResult<T>` in `src/common/interfaces/`.
- The cursor is opaque to the client — encode whatever the query needs (typically the last row's `id` or `created_at`), don't expose raw offsets or internal IDs as a contract.

## CORS

Configured via `CORS_ALLOWED_ORIGINS` (comma-separated). Empty in dev reflects that no browser client exists yet — set it before the admin panel or any browser-based client is wired up (see architecture.md §9). `credentials: true` is on by default since cookie-based refresh-token handling is the likely direction once a web client exists; revisit if that changes.

## Graceful shutdown

On SIGTERM/SIGINT the app closes gracefully, with a 10 s in-process force-exit timer and a worker-thread watchdog that SIGKILLs the process shortly after if the event loop is starved (see [ADR-0024](adr/0024-shutdown-watchdog-thread.md)). Set the orchestrator's termination grace period to at least 15 s so the platform does not kill the process before those backstops run.

## Integration-test database

Integration specs never start Postgres or run migrations themselves. Jest's `globalSetup` starts one container per run, applies every migration once through the real migration runner, and keeps the result as a template database; each spec file's context clones it for an isolated database and drops it on destroy (see [ADR-0023](adr/0023-shared-integration-test-database.md)). A new migration needs no change under `test/integration/support/`. Contexts hold only module wiring and seed helpers. Redis is still one container per context.

Contexts also register the real exception filter and response interceptor (`buildTestPipelineModules()`), so specs see the same envelope as clients: read success bodies with `dataOf<T>(res)` and error bodies with `errorOf(res)` from `test/integration/support/api-response.ts`, never `res.body` directly. A new domain error gets an HTTP-level test asserting its `error.code` (and `error.details` if it has any).
