# Cliqpay

A peer-to-peer wallet platform for Africa (Nigeria first), built with NestJS, PostgreSQL and TypeORM. The design lives in [docs/architecture.md](docs/architecture.md).

## Local development

### Prerequisites

- Node.js 22.23.2 (pinned in `package.json` `engines`)
- pnpm
- PostgreSQL 15 or newer (migrations use `NULLS NOT DISTINCT`)
- Redis (cache and BullMQ queues)
- Docker, for the integration tests only

### Setup

```bash
pnpm install
cp .env.example .env
```

Fill in `DATABASE_URL`, `REDIS_URL` and the empty secrets in `.env`. The comments in `.env.example` say how to generate each one. Then:

```bash
pnpm migration:run
pnpm start:dev
```

The server listens on `PORT` (default 3000).

### Fake providers

To run without any third-party accounts, set every provider to `fake`:

```bash
EMAIL_PROVIDER=fake SMS_PROVIDER=fake PUSH_PROVIDER=fake \
PAYMENT_PROVIDER=fake KYC_PROVIDER=fake pnpm start:dev
```

`.env.example` already defaults them to `fake`. Variables set in the shell win over `.env`, because dotenv never overrides a variable that's already set. That makes the command above the way to force fakes when your `.env` points at real providers.

### Routes

API routes are versioned under `/v1/`, for example `POST /v1/transfers`. The exceptions are:

- `GET /health`;
- the OpenAPI document at `/doc` and its reference UI at `/reference`;
- the provider webhooks, `POST /wallet/webhook/kora` and `POST /kyc/webhook`.

### Tests

```bash
pnpm test
```

```bash
pnpm test:integration
```

`pnpm test` runs the unit tests. `pnpm test:integration` runs against real Postgres and Redis containers through Testcontainers, so Docker must be running.
