# Running `/e2e-test-local` against real providers (Kora sandbox + Brevo)

Companion to `docs/phase-playbook.md` step 8. That playbook step defaults to fake providers — this doc is for the times a phase's design leans on provider-specific behavior worth confirming for real (a new webhook shape, a new adapter method, anything ADR-0007-shaped), and `.env` already has real credentials configured.

## Prerequisites

- `.env` has `BREVO_API_KEY`/`BREVO_SENDER_EMAIL` and `KORA_SECRET_KEY` (a sandbox `sk_test_...` key) set, with `EMAIL_PROVIDER=brevo` and `PAYMENTS_PROVIDER=kora` (or whichever provider config the phase under test needs).
- `KORA_WEBHOOK_URL` in `.env` is already pinned to a **reserved** ngrok domain (`https://<name>.ngrok-free.dev`) — Kora's dashboard doesn't need updating per run, only the tunnel needs to bind to the same reserved domain each time.
- ngrok is authenticated on the machine (`ngrok config check`) with a plan that supports reserved domains.
- The dev database has every migration applied: **`pnpm run migration:run`**. The Testcontainers-backed integration suite provisions its own schema from scratch on every run and will never surface a missing dev-DB migration — this is exactly the kind of environment-shaped gap this whole exercise exists to catch, and it did, in Phase 4's own run (see Findings below).

## Procedure

1. **Start the dev server**: `preview_start` with the `cliqpay-dev` launch config (`pnpm run start:dev`), not raw `pnpm` in a bare terminal — this is what gives log access via `preview_logs`.
2. **Start the tunnel**, bound to the exact reserved domain `KORA_WEBHOOK_URL` already points at:
   ```bash
   ngrok http --domain=<your-reserved-domain>.ngrok-free.dev 3000
   ```
   Confirm both the tunnel (`curl http://127.0.0.1:4040/api/tunnels`) and the app (`curl https://<domain>/health -H "ngrok-skip-browser-warning: true"`) are actually reachable before issuing real requests — the header is required or ngrok's free-tier interstitial page intercepts the response.
3. **Mind API versioning**: this app uses URI versioning (`app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`) — every route needs a `/v1/` prefix. A bare `/auth/register` 404s; `/v1/auth/register` doesn't. Easy to forget when working from route-mapping log lines, which don't show the prefix.
4. **Register a disposable test identity** via a Mailinator address (`<name>@mailinator.com`) so verification/MFA/notification emails are readable without a real inbox.
5. **Reading OTP/step-up codes from Mailinator**: navigate to `https://www.mailinator.com/v4/public/inboxes.jsp?to=<name>`, `read_page` (interactive filter) to find the newest matching subject row (topmost = newest), click it, then click the `TEXT` tab (`HTML` renders in an iframe `get_page_text`/`javascript_tool` won't reach reliably — a `screenshot` after clicking `TEXT` is the dependable path). **Match the email by its `Received` timestamp against the challenge's request timestamp** when more than one email shares a subject (e.g. two "Your Cliqpay sign-in code" emails from a login MFA challenge and a separate step-up challenge in quick succession) — clicking the wrong one burns a real MFA attempt and the challenge has to be re-requested.
6. **Access tokens expire fast** (15 minutes here) — a `401` mid-run after a real gap (reading Kora sandbox docs, deciphering a checkout flow) usually means refresh, not re-auth: `POST /v1/auth/refresh` with the stored `refreshToken`, which rotates on every use — always persist the new one.
7. **Completing a Kora sandbox checkout**: the hosted checkout page marks itself `TEST MODE`. "Pay with Debit Card" shows a labeled list of test scenarios (Success, with PIN/OTP/3DS/AVS, etc.) but does **not** auto-fill a test card number — the fastest deterministic path is **"Pay with Bank Transfer"**: check the instructions box, click Continue, and the sandbox mints a one-time virtual account that auto-credits within under a minute, no card numbers needed.
8. **The real webhook lands on its own** — no manual trigger needed once the tunnel and dev server are both up; Kora delivers to `KORA_WEBHOOK_URL` like it would in production. Confirm via `preview_logs` (search `"webhook"` or `"kora"`) rather than assuming.
9. **Capturing the exact raw payload** (for documenting a real response shape, ADR-0007-style): ngrok's local inspector at `http://127.0.0.1:4040/api/requests/http` returns every proxied request, base64-encoded, including headers and body — decode `request.raw` with `base64.b64decode(...).decode()`. This is the reliable way to get the byte-exact payload Kora sent, rather than relying on what the app chose to log.
10. **Tear down**: stop the ngrok process and `preview_stop` the dev server when done. Nothing here is disposable-safe by default — the tunnel exposes a real local server to the internet for as long as it runs.

## Findings this method has actually caught

Real, not hypothetical — kept here so the next run knows what to look for:

- **A phase's migrations were never applied to the dev database.** Testcontainers-backed integration tests provision a fresh schema every run and can't catch this; only running against the actual dev Postgres instance surfaced `relation "bank_accounts" does not exist` on the very first real request. Always `migration:run` before a real-provider pass.
- **Kora's real payout webhook fee didn't match the app's assumption.** The app charges withdrawal users a fixed, config-driven `WITHDRAWAL_PROVIDER_FEE` (₦30 default) rather than Kora's actual reported fee — a real sandbox payout came back with `fee: 32.25`. This is a deliberate simplification in the current design (unlike funding, which does use the provider-reported fee for its expense/recovery pair), not a bug, but it means the flat fee can diverge from what Kora actually charges on any given payout. Worth a design conversation if this needs tightening before real payouts move real money.
- **A shared exception message leaked wrong context.** `InsufficientFundsException` (in `ledger.service.ts`, shared between transfers and withdrawals) hardcodes "Insufficient funds to complete this **transfer**" — surfaced verbatim to a withdrawal caller. Cosmetic, but visible to a real user in a way no automated test checks for message wording.
