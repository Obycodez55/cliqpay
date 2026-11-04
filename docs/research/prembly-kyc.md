# Prembly KYC: sandbox research spike

Captured 2026-10-22 against `https://api.prembly.com` with the sandbox keys. Fixtures: `test/fixtures/prembly/<endpoint>.<scenario>.json` (sanitized: keys removed, base64 blobs elided, emails/phones/addresses/org ids masked).       65 API calls were made in total. All REST calls were free sandbox calls (`was_charged: false`); the widget sessions are production (section 8) and nothing was debited (wallet stayed 0.00).

Legend: **[V]** verified by a captured request/response in this spike. **[D]** docs only, not verified.

## 1. Summary: what is verified and what is not

| Area | Status |
|---|---|
| Auth header, test-mode detection, error envelopes (400/401/404) | [V] |
| BVN basic (`bvn_validation`), BVN advance (`bvn`), NIN basic (`vnin-basic`), NIN advance (`vnin`), `nin_w_face`, `bvn_w_face` request/response shapes | [V] |
| Face comparison, REST liveness request/response shapes | [V] |
| Sandbox result *logic* (match vs no-match, liveness pass vs fail, not-found, wallet) | **Not triggerable.** The sandbox returns a fixed canned success for every well-formed request (section 6). |
| Get Verification Status | [V] it returns 404 for every sandbox verification id we hold. Success shape is [D] only. |
| Widget / SDK session flow | **Partly verified, against a production widget (not sandbox).** Session creation, session fetch, the expiry, and the passive face-scan result shape are [V] (section 8). The flow stopped at `pending_payment` (wallet balance 0 against a NGN 60 charge), so the completed-session result, webhook and redirect were not observed. Widgets cannot be created in sandbox (per the account owner), so this flow cannot be tested for free. |
| Webhooks | **No delivery observed.** 4 REST calls with `callback_url` pointing at the ngrok tunnel produced 0 deliveries in about 80 s, and two widget sessions (one abandoned on timeout, one stuck at `pending_payment`) produced none either. Signature scheme is [D] only; no real delivery was captured, so no key could be tested. |
| Rate limit (429), insufficient wallet (03), blocked BVN (07), not found (01), face mismatch | Not triggerable in sandbox. [D] only. |

### Most important surprises

1. **The sandbox ignores the input value.** Any well-formed 11-digit BVN returns the same canned person; the image bytes are ignored by every face endpoint (a synthetic face, random noise and a blank image all "pass" liveness with the identical confidence). The sandbox cannot be used to exercise failure paths for face match or liveness, nor not-found. Failure behaviour has to be faked on our side.
2. **Validation errors are real HTTP 400 with `response_code: "05"`**, a code the docs' code tables do not list. The docs say custom codes (00/01/02/03/07) come inside HTTP 200; that part could not be tested.
3. **Sandbox and live share the host; the only in-band marker is the response**: `is_sandbox: true`, `reference_id` prefixed `SBX-`, `billing_info.note: "No charges in sandbox mode"`. Adapter code should log/alert if `is_sandbox` is true in production.
4. **Two incompatible date formats**: BVN `DD-Mon-YYYY` (`11-May-2004`), NIN `DD-MM-YYYY` (`22-05-1998`). BVN names are camelCase (`firstName`), NIN names are lowercase (`firstname`, `surname`).
5. **The BVN-advance sandbox person and the NIN sandbox persons are different people**, and the BVN record's `nin` is `""`. A BVN-vs-NIN same-person cross-check cannot be exercised with sandbox data.
6. **REST liveness is a single-image call**, with only `confidence` (0-1 float) and `confidence_in_percentage`. There is no pass/fail field and no threshold parameter; `verification.status` is the only verdict, and the sandbox always returns `VERIFIED`. Whether it is active or passive in live mode is unknown.
7. **The widget creates its session with a plain REST call**, made from our backend and verified (section 8). But the widget exists only in production: it demands a funded wallet (session stuck at `pending_payment`, NGN 60 for the BVN step), so it cannot be tested free, and gesture liveness timed out in a manual run.
8. **`GET /api/v1/wallet` worked with a sandbox key** (docs say live only) and returned balance `"0.00"`, a different shape from the docs' sample.

## 2. Environment and auth

| Item | Finding |
|---|---|
| Base URL | `https://api.prembly.com` for sandbox and live. [V] sandbox. The widget script also uses `backend.prembly.com` for the same `/api/v1/checker-widget/...` path (from SDK source). |
| Auth header | `x-api-key: <secret key>` [V]. No other header is needed; no app/organisation id for `/verification/*` [V]. |
| `Authorization: Bearer <x>` | Does not authenticate (401, `authentication_failed`) [V]. |
| Test vs live | Different keys, same URL [D docs "Getting the live API keys"]. In-band markers on every verification response [V]: `is_sandbox: true`, `reference_id` prefix `SBX-`, `billing_info.note: "No charges in sandbox mode"`, `verification_status: "sandbox"` (on most endpoints). Note `verification_status` is `"verified"` on `bvn` and `vnin-basic`, so do not rely on it. |
| Content-Type | JSON body works [V]. Fields must be strings (`number: 54651333604` as int gives 400 "Expected string, got int") [V]. |
| Docs say `x-organisation-id` is needed for the SDK session fetch | The `GET .../sdk/sessions/{id}/` returned the same 404 "Session not found" with and without it, so not proven either way [V]. |
| Response headers | `x-request-id` is present on every response [V]; no idempotency or rate-limit headers were seen. |

Test-mode guard (done first): `bvn_validation` with the documented test BVN returned the documented placeholder person, `is_sandbox: true`, no charge.

## 3. Response envelope and error matrix

Two envelope families exist.

**Family A: verification endpoints (`/verification/*`)**

Success (HTTP 200):
```json
{ "status": true, "response_code": "00", "message": "...", "detail": "...",
  "data": { ... }, "meta": {},
  "billing_info": { "was_charged": false, "amount": 0, "currency": "NGN", "note": "No charges in sandbox mode" },
  "verification": { "status": "VERIFIED", "reference": "<uuid>", "verification_id": "<uuid>" },
  "reference_id": "SBX-BVN_BASIC-XXXXXXXXXX", "is_sandbox": true, "account_verified": true,
  "verification_status": "sandbox", "metadata": {} }
```
Validation failure (HTTP 400): `status: false`, `response_code: "05"`, `message/detail: "Invalid request data"`, `data: {}`, `verification.status: "NOT-VERIFIED"` (with a fresh `reference` and `verification_id`), and `errors: { "<field>": ["<message>"] }`.

**Family B: platform/auth/session/status endpoints**
```json
{ "status": false, "message": "...", "data": null, "errors": { "code": "authentication_failed" } | null, "meta": { "timestamp": "...", "version": "v1" } }
```
No `response_code`, no `detail`.

| Scenario | HTTP | Body | Evidence |
|---|---|---|---|
| Success | 200 | `status: true`, `response_code: "00"` | all success fixtures |
| Malformed BVN (`123`, `abcdefghijk`) | 400 | `response_code: "05"`, `errors.number: ["BVN must be exactly 11 digits"]` | `bvn_validation.malformed_short/alpha` |
| Missing field | 400 | `errors.number: ["This field is required"]` | `bvn_validation.missing_field`, `nin_w_face.missing_image`, `liveness.missing_image` |
| Wrong type | 400 | `errors.number: ["Expected string, got int"]` | `bvn_validation.number_as_int` |
| Wrong field name (`number` instead of `number_nin`) | 400 | `errors.number_nin: ["This field is required"]` | `vnin.wrong_field_name` |
| Bad image string on liveness | 400 | `errors.image: ["Facial image must be base64 encoded (JPEG or PNG) or a valid URL"]` | `liveness.bad_image` |
| Bad key | 401 | Family B: `message: "Invalid API key or inactive organisation."`, `errors.code: "authentication_failed"` | `auth.bad_key` |
| No key | 401 | `message: "Authentication credentials were not provided."` | `auth.no_key` |
| Bearer instead of `x-api-key` | 401 | message is a stringified Python `ErrorDetail` dict | (raw only, not a fixture) |
| Verification status id unknown | 404 | Family B: `message: "Verification '<id>' could not be found"`, `errors.error_code: "01"` | `status.get_unknown_id` |
| Session not found | 404 | Family B: `message: "Session not found"` | `session.get_fake` |
| Invalid widget id/key | 401 | `message: "Invalid widget ID or key"` | `widget.initiate_*` |
| Unrouted path | 404 | HTML page, not JSON | raw only |
| Record not found (01), service unavailable (02), insufficient wallet (03), blocked BVN (07) | docs: HTTP 200 with that `response_code` | **[D] only, not triggerable** | |
| 429 rate limit | docs only | not triggered (intentionally gentle) | |
| Face mismatch | docs: `data.face_data.status: false`, `response_code: "01"`, "Face does not match." | **[D] only** | |
| Liveness failure | undocumented | **not triggerable** | |

Adapter implications:
- Treat the combination `(httpStatus, status, response_code, verification.status)` as the verdict; never `detail` text (docs show `"Verification Successfull"`, live shows `"Verification success…"`).
- Two documented code tables disagree (one maps them to HTTP 200 with `status` true for 01/02, the other lists no HTTP mapping). Validation errors use a code (05) that neither lists.
- Failure can arrive as HTTP 4xx (Family A or B), as HTTP 200 + non-00 code ([D]), and, for face endpoints, possibly as HTTP 200 + `00` with an inner `face_data.status: false` ([D]). All three need handling.

## 4. Identity lookups

All were called with sandbox keys. The sandbox returns fixed persons regardless of input.

| Endpoint | Request body | Persons returned |
|---|---|---|
| `POST /verification/bvn_validation` (BVN basic) | `{ "number": "<11 digits>" }` | John Doe Jane, any valid 11-digit number [V] |
| `POST /verification/bvn` (BVN advance) | `{ "number": "..." }` | Fixed full record (below) [V] |
| `POST /verification/vnin-basic` (NIN basic) | `{ "number": "..." }` | GRACE CHIMAMANDA AMANDA, any value tried (`12345678909`, a BVN-like value) [V] |
| `POST /verification/vnin` ("NIN advance"/virtual NIN) | `{ "number_nin": "..." }` | CHIDERA ANITA JOHNSON, nin echoed as `12345678901` [V] |

Field availability for the same-person cross-check:

| | BVN basic | BVN advance | NIN basic | NIN advance (`vnin`) |
|---|---|---|---|---|
| first name | `firstName` | `firstName` | `firstname` | `firstname` |
| middle name | `middleName` | `middleName` | `middlename` | `middlename` |
| last name | `lastName` | `lastName` | `surname` | `surname` |
| date of birth | `dateOfBirth` `01-Jan-2000` | `dateOfBirth` `11-May-2004` | `birthdate` `23-05-1999` | `birthdate` `22-05-1998` |
| phone | `phoneNumber` | `phoneNumber1`, `phoneNumber2` | `telephoneno` | `telephoneno` |
| gender | no | `gender` ("Male") | `gender` ("f"/"m") | `gender` |
| address | no | `residentialAddress`, `stateOfResidence`, `lgaOfResidence` | `residence_address` | `residence_address`, `residence_state`, `residence_town` |
| photo | no | `base64Image` (placeholder text `"base64 image content"`) | `photo` (data-URI JPEG, ~200 KB) | `photo` (same) |
| linked NIN | no | `nin` (`""` in sandbox) | n/a | `nin`, `vnin` |
| extras | | `watchListed` is the string `"False"`, `levelOfAccount`, `registrationDate`, `enrollmentBank` | | many empty-string fields; typo key `heigth` |

Notes:
- All values are strings, including booleans-as-strings (`watchListed: "False"`) and empty strings for absent data.
- `data` is the only copy in `vnin-basic`/`vnin` live responses. The docs show both `data` and `nin_data`.
- `nin_w_face` and `bvn_w_face` return the identity record too (next section).
- Same-person cross-check: fields exist on both sides (names, DOB), but DOB formats differ (`DD-Mon-YYYY` vs `DD-MM-YYYY`), name keys differ in case and the surname key differs, and the sandbox BVN and NIN persons are different people with `nin` empty, so this cannot be exercised in sandbox. Which format and name order live data uses is unverified.

## 5. Face-match endpoints

Request (both): `{ "number": "...", "image": "<base64 | URL>", "face_confidence_threshold": 70-100 }`.

| Observation | Evidence |
|---|---|
| `image` accepted as a documented sample URL, raw base64 JPEG, random-noise JPEG; a non-image string on `bvn_w_face` is still accepted (200, "Fatch Match") | `bvn_w_face.url_match`, `.b64_synthetic`, `.b64_noise`, `.bad_image` |
| `face_confidence_threshold` of 50 (outside 70-100) is accepted; omitting it is accepted | `.threshold_out_of_range`, `.no_threshold` |
| `bvn_w_face` response is canned and identical for every input: `data.face_data = { status: true, message: "Fatch Match", confidence: 0.0404…, response_code: "00" }`, plus a different fixed BVN record in `data` (`dateOfBirth: "11-May-1992"`) | fixtures above |
| `confidence` is `0.0404` while the match is "true", so the scale is not meaningful in sandbox (docs show `1`, `90`, and `100` for the same field across pages) | |
| `nin_w_face` response is canned, with `nin_data` filled with placeholders (`"string"`, `"base64_string"`, `birthdate: "01-01-1990"`), and `face_data.confidence: 99.98` appearing **twice** (`data.face_data` and `data.nin_data.face_data`) | `nin_w_face.url_match` |
| `nin_w_face` missing `image` gives 400 `errors.image` | `nin_w_face.missing_image` |
| Structure differs between the two: BVN puts `face_data` inside `data`; NIN nests identity under `data.nin_data` and `face_data` under both `data` and `data.nin_data`; docs show `face_data`/`nin_data` at top level | |
| Face comparison (`/verification/biometrics/face/comparison`) | always `data: { message: "Fatch Match", confidence: 100 }`, even for face-vs-noise and for non-image strings. `message` carries the sandbox sentence. Docs show `confidence` and `threshold` at top level; live they are inside `data`. |

Match vs no-match logic: **not observable.** No mismatch response was produced by any input; the failure shape is [D] only.

## 6. REST liveness (`POST /verification/biometrics/face/liveliness_check`)

Request: `{ "image": "<base64 JPEG/PNG | URL>" }`. A `data:image/jpeg;base64,` prefix is accepted [V].

Response (identical for a synthetic face, noise, a blank image, a documented URL): `data: { confidence: 0.9999910736083985, confidence_in_percentage: 99.99910736083984 }`, `verification.status: "VERIFIED"`, `reference_id: SBX-LIVELINESS_CHECK-…` [V]. This matches the docs' sample number exactly, which indicates a hard-coded sandbox response.

| Question | Answer |
|---|---|
| Active or passive? | Unknown. A single image is submitted; the docs say only that liveness via the SDK adds a live-camera challenge. |
| Pass/fail field | None. `verification.status` is the only verdict; no threshold parameter exists. |
| Scale | `confidence` 0-1 float plus a percent copy. |
| Spoof handling | Not observable in sandbox. |
| Compare to SDK | Docs: the widget runs a camera challenge and returns biometric results including a confidence score; not verified. |

## 7. Result retrieval

`GET`/`POST /verification/{id}/status` [D: "live only"; method inconsistent in docs]:
- Both methods exist and behave the same.
- Ids tried: `verification.verification_id`, `verification.reference`, `reference_id` and an all-zero uuid. All return 404 "Verification '<id>' could not be found", `errors.error_code: "01"` [V].
- So sandbox verifications are not retrievable. The success shape (docs: `reference`, `response_code`, `price`, `endpoint`, `request_data`, `response_data`, `verification_status`, `billing_status`, `created_at`) is [D] and cannot be reproduced here.
- Passing `reference` in the request body is silently dropped; `metadata: { userId: "u1" }` is echoed in the response `metadata` [V] (`bvn_validation.metadata_reference`). There was no client-reference field that comes back; the only identifiers are Prembly's `verification.reference`, `verification.verification_id`, `reference_id`.
- SDK sessions: `GET /api/v1/checker-widget/sdk/sessions/{session_id}/` exists (404 "Session not found" for an unknown id) [V]; the success shape is [D] and not seen.

## 8. Widget / SDK (async) flow

What is known:

| Step | Evidence |
|---|---|
| Dashboard: SDK Setup → Add New Widget gives `widget_id` and `widget_key` ("public key") | [D] |
| Web SDK (`prembly-react-kyc` v1.0.3) loads `https://js.prembly.com/v1/inline/widget-v3.js` and calls `window.IdentityKYC.verify({ first_name, last_name, email, phone, widget_id, widget_key, metadata, callback })` | SDK source read via unpkg; `config_id` is accepted as an alias of `widget_id`, `merchant_key` of `widget_key` |
| The script POSTs `{first_name, last_name, email, phone, widget_id, widget_key, metadata}` to `https://backend.prembly.com/api/v1/checker-widget/sdk/sessions/initiate/` and reads `session_id`. The same path on `api.prembly.com` answers too | script source; `widget.initiate_*` fixtures: 401 `Invalid widget ID or key`; missing fields give 400 listing `first_name, last_name, email, widget_id, widget_key` as required |
| The script opens an iframe at `https://sdk-live.prembly.com/?session=<session_id>&has_callback=<bool>` with `allow="camera; microphone; ..."` | script source |
| The widget reports through `window.postMessage` with `eventInstance: "identity_verification_event"`; statuses `failed` (E01), `cancelled` (E02), otherwise success (`code: "00"`); the script does not check `event.origin` | script source |
| The script has no `is_test`, `sandbox` or environment switch. Sandbox is decided by the widget configuration in the dashboard (docs also mention `is_test: true` in metadata; the web script ignores it) | script source vs docs |
| Callback statuses from the React docs: `success`, `failed`, `closed`, `error` | [D] |
| Result delivery to the server: webhook to the dashboard URL (`event: "verification.completed"`, `session_id`, `data`) or `callback_url`; or backend fetch of the session | [D] |

### Live findings (widget in production, sandbox keys unused)

The widget configured in the dashboard is a **production** widget; widgets cannot be created in sandbox. The session calls need only `widget_id` and `widget_key` in the body (no `x-api-key`), so nothing in the request marks the environment, and the responses contain no `is_sandbox` field. Treat all of this as live-environment behaviour with a zero-balance wallet.

| Finding | Evidence |
|---|---|
| `POST /api/v1/checker-widget/sdk/sessions/initiate/` works from our backend (HTTP 201) and returns a `session_id` (`sdk_session_<32 hex>`), the full `widget_config`, `expires_at` (**24 hours** after creation), `liveness: { status: "not_started", process_id: null }` | `sdk-session.initiate.gesture_on/off` |
| `metadata` we send returns on the session (`metadata.user_ref`, `is_test`) | same |
| The widget config is copied into the session at creation: `enable_face_scan`, `use_gesture_liveness`, `face_confidence_level` (dashboard slider showed 75, session showed 70), `enable_fraud_scan`, `selected_channels` (BVN, NIN), `redirect_url`, `brand_*`, `metadata.welcome_message`. Changing the dashboard after creation does not affect an existing session. | `gesture_on` vs `gesture_off` |
| Price per channel shown on the session: BVN NGN 60, NIN NGN 100 (also KES and USD) | same |
| The widget's purpose here is `data_verification`: the user enters a BVN or NIN, then does the face scan. It is not a liveness-only flow. | same |
| `GET /api/v1/checker-widget/sdk/sessions/{session_id}/` with `x-api-key` returns the session (HTTP 200), including `status`, `overall_result`, `failure_reason`, `verification_steps`, `verification_data`, `face_scan_result`, `liveness`, `addon_results`, `is_used`, `completed_at`, `redirect_url`. `x-organisation-id` was not needed (not sent). | `sdk-session.get.pending_payment_after_passive_face_scan` |
| Gesture liveness ON: a manual run **timed out in the final capture step** ("you took too long") while the capture was still running; the timer expired earlier than the capture completed. The session stayed `initiated`; `verification_steps` empty and `liveness.status: "not_started"`. A timed-out attempt is indistinguishable from "never started" through the session endpoint. | manual run, session kept as `initiated` |
| Gesture liveness OFF (passive face scan): the capture succeeded without a gesture. | manual run |
| After the passive scan the session is `status: "pending_payment"`, `overall_result: null`, `completed_at: null`, with `verification_data.insufficient_balance_reason: "Data collected, awaiting payment"`, `required_amount: "60.00"`, `current_balance: "0.00"`, and a `pending_payment_data_url` (a stored-data link). The BVN check does not run until the wallet can pay. The wallet remained `0.00`. | same session; `wallet.get_after_widget` |
| Face scan result: `face_scan_result.liveness = { status: "passed", is_live: true, confidence: 99, provider_state: "3", provider_result: "1", full_provider_response: { id, status: 3, liveness: 1, idFace: { result: "FOUND", personId }, riskLevel: { result: "inconclusive" } } }` and `comparison: { status: "pending" }`, `is_match: null` (Face Comparison was off). `confidence` is an integer out of 100 here, with a top-level `face_scan_result.confidence: 0`. | same |
| `idFace.result: "FOUND"` with a `personId` means the provider matched the face to an identity it already held, probably from the earlier abandoned attempt. This indicates faces are stored and searched across attempts. | same |
| No webhook and no redirect request reached the capture server for either session. For the stuck session this may be because it never completed. | capture log (0 requests) |

Not tested: a **completed** session (BVN checked, `overall_result` set), the webhook payload, headers and signature, the redirect request, the React Native component, and Face Comparison.

## 9. Webhooks

| Question | Result |
|---|---|
| Does the sandbox deliver webhooks for REST calls with `callback_url`? | **No delivery observed.** 4 calls (`bvn_validation`, `liveliness_check`, `bvn_w_face`, `vnin`) with `callback_url` set to the ngrok tunnel were accepted with HTTP 200; the capture server (self-tested through the tunnel) recorded nothing after about 80 s. |
| Does the dashboard-level webhook matter? | Untested (needs a dashboard change, section 11). |
| Headers | [D] `x-prembly-signature` (HMAC-SHA256, base64, over the raw body) and `token` (unique id). Not observed. |
| Which key signs | [D] docs say the **public key** is the HMAC key (the Node example reads `PREMBLY_PUBLIC_KEY`) while the page text calls it a "secret". **Not verified**; no delivery to test against. |
| Retries, timing | Unobserved. [D] says "Prembly may retry on 500". |
| Payload shapes | [D] SDK: `status, detail, response_code, data{verification_response, biometric_results, widget_info{widget_id, first_name, last_name, email, user_ref, environment}}, verification{status}`. API: `status, detail, response_code, data`. A different docs page shows `event`, `session_id`, `data`. Three shapes in the docs; none observed. |

The tunnel and capture server were shut down afterwards.

## 10. Timing and idempotency

Observed latency (sandbox REST calls, one location, sequential):

| Endpoint | n | avg | max |
|---|---|---|---|
| `bvn_validation` | 15 | 466 ms | 1032 ms |
| `bvn` (advance) | 2 | 1047 ms | 1213 ms |
| `vnin-basic` | 2 | 397 ms | 399 ms |
| `vnin` | 3 | 520 ms | 798 ms |
| `bvn_w_face` | 7 | 406 ms | 459 ms |
| `nin_w_face` | 4 | 629 ms | 974 ms |
| `liveliness_check` | 8 | 540 ms | 1180 ms |
| `face/comparison` | 4 | 397 ms | 461 ms |
| `/verification/{id}/status` | 5 | ~800 ms | 1143 ms |
| sessions `initiate` | 3 | 690 ms | 1318 ms |

These are canned-response timings; live latency (which calls NIBSS/NIMC) is unknown. Async result timing and session/job expiry: not observed.

Idempotency [V]: the same request sent twice returns different `verification.reference`, `verification_id` and `reference_id` each time. An `idempotency-key` header was ignored (two sends, two different references). There is no client-supplied reference field. Billing under duplicates cannot be observed in sandbox (no charges). Our own dedupe has to be on our side.

## 11. Manual steps needed from the user

Done so far: a production widget exists (widgets cannot be made in sandbox), keys are in `.env`, the dashboard webhook points at the tunnel's `/wh/dash` path and the redirect URL at `/wh/redirect`. The two manual runs are described in section 8.

Still needed to finish the widget/webhook verification (paused; this is a paid step):
1. Decide whether to fund the production wallet (the BVN check is NGN 60 per verification) or get Prembly support to confirm a free test route (questions 12 and 13).
2. A manual run with a camera, with a funded wallet and the tunnel and capture server running (the scratch scripts are in the session scratchpad; the ngrok command is `ngrok http --url=<reserved domain> 127.0.0.1:<port>`).
3. Then capture the webhook (payload, `x-prembly-signature`, `token`), test the signature with the public and secret keys, capture the redirect request, and fetch the completed session.

## 12. Documentation inconsistencies found

- Test BVN `54651333604` is documented as returning BVN `22289000017` ("JU OYI KEE"); live sandbox returns a different person for `bvn`, and John Doe Jane for `bvn_validation`.
- `dateOfBirth` documented as `YYYY-MM-DD`; actual `DD-Mon-YYYY` (BVN) and `DD-MM-YYYY` (NIN).
- BVN-with-face docs call `phoneNumber1` a date of birth.
- Two response-code pages disagree (HTTP mapping, `status` for 01/02); code 05 (validation) and a 404 with `error_code: "01"` are in neither.
- `vnin` response documented with top-level `nin_data`; live has `data` only. `nin_w_face` documented with top-level `face_data`/`nin_data`; live nests them under `data`, with `face_data` duplicated.
- `nin_w_face` test data labelled `number_nin` on one page, field is `number`; `vnin` uses `number_nin`.
- NIN Basic "TEST DATA" is empty.
- Face comparison docs show `confidence`/`threshold` at top level and `Fatch Match` typo; typo persists in live (`"Fatch Match"`, also in `bvn_w_face`).
- `Get verification status` labelled POST and "live only"; GET and POST both route (sandbox 404).
- `Get wallet balance` labelled live only; works with a sandbox key and returns a different shape (`balance` is a string; org fields present) from the docs' sample.
- Widget docs: React uses `widget_key/widget_id`, `advanced-features` uses `configId/widgetKey` where `widgetKey` is described as the widget id; the web script never reads `is_test`.
- Signature page calls the key "public key" yet uses it as an HMAC secret.
- Confidence scale for face endpoints differs per page (1, 100, 0-1) and in sandbox (0.04 for a "match").
- `verification_status` is `"sandbox"` on some endpoints and `"verified"` on others in sandbox; docs list PENDING/NOT-VERIFIED/VERIFIED.
- Docs example JSON is invalid in places (trailing commas, a missing closing brace).

## 13. Questions for Prembly support

1. Can sandbox be made to return not-found (01), face mismatch, liveness failure, 03, 07, 429? Is there a test-data table (the docs' "TEST DATA" boxes are empty or incomplete)?
2. Is the BVN-advance sandbox data synthetic? (It differs from the docs sample and looks like a realistic record.)
3. Is REST liveness active or passive, how is `verification.status` decided, and what threshold applies? Is the SDK result stronger than REST?
4. Webhook: exact payload and headers per path (dashboard vs `callback_url`), which key signs it, retry schedule, does `callback_url` fire in sandbox at all, and does it support REST (non-SDK) endpoints?
5. Is there an idempotency or client-reference mechanism, and are duplicate calls billed?
6. Are live verifications retrievable by `verification_id` or `reference` (which one), and for how long? Does Get Verification Status return the biometric result?
7. How long does an SDK session live, and what does `GET .../sdk/sessions/{id}/` return (and does it need `x-organisation-id`)?
8. Pricing per endpoint (the docs sample shows NGN 50 and 100 for NIN calls), minimum wallet balance behaviour, and how live activation (business verification) works.
9. Retention of selfies/images and the BVN/NIN photos, and data residency (Nigeria? NDPR).
10. Rate limits per key.
11. Can the widget be driven by our backend alone? (The initiate call works from our backend [V]; what is unconfirmed is whether we can render the iframe ourselves at `sdk-live.prembly.com/?session=...` in a mobile webview, and whether the React Native component is needed.)
12. Can a widget be created in sandbox, or is there a free test mode for widget sessions? Today the widget is production only, so every session needs a funded wallet (the session sat at `pending_payment`).
13. Does a session deliver webhooks and the redirect only after it completes (payment included)? What exact events and statuses exist (`pending_payment`, `completed`, `failed`, `expired`)?
14. Gesture liveness: the capture-step timer expired before the capture finished in a normal run on a laptop. Is the timeout configurable, and what does a timed-out session report?
15. The provider result shows `idFace.result: "FOUND"` and a `personId`. What face data is stored, for how long, where, and who can match against it? Is the Fraud Signal option ("same face on other IDs") a cross-customer search? What is the NDPR basis?
16. What does `face_confidence_level` control (comparison only, or also liveness), and why did the session carry 70 while the dashboard slider showed 75?

## 14. Mapping onto Cliqpay's `KycProvider`

`KycProvider` has `verifyBvn`, `verifyNin`, and an async liveness job model (`submitLiveness`, `getLivenessResult`, `parseWebhookJobId`).

| Interface need | Prembly mapping | Fit |
|---|---|---|
| `verifyBvn` | `bvn_validation` (name + DOB + phone) or `bvn` (adds gender, address, `nin`, photo). Output needs normalizing: names camelCase, DOB `DD-Mon-YYYY` | Clean after DOB parsing. |
| `verifyNin` | `vnin-basic` (name, DOB, phone, address, photo) or `vnin` (more fields, `number_nin`) | Clean after normalizing names (`surname`) and DOB (`DD-MM-YYYY`). Different field name per endpoint. |
| BVN/NIN same-person check | DOB and names exist on both | Possible, but formats differ, and sandbox cannot be used to test it. |
| Errors | 400 validation (`05`) and 401 as HTTP errors; not-found/03/07 as 200+code [D]; face failures possibly nested [D] | Adapter must interpret HTTP status, `status`, `response_code` and `verification.status` together. |
| Idempotency | None provided | Cliqpay dedupes before calling. |
| Provider reference | `verification.reference`, `verification_id`, `reference_id` | Need to choose one to store; which one the status endpoint accepts in live is unknown. |
| `submitLiveness` / `getLivenessResult` | REST liveness is **synchronous** (one image, immediate answer), so there is no job to submit or poll. | **Does not fit** the job model. Widget flow is async (session, webhook, status fetch) and would fit it, but its payload, webhook and fetch shapes are unverified. |
| `parseWebhookJobId` | The webhook payload's id field is unknown; docs show `session_id`, `widget_info.user_ref`, `verification.reference` in different pages | Unverified. |

### Recommendation on liveness

Evidence supports only part of a decision:

- REST liveness (frames from our API) is fully verified for request/response shape but the sandbox gives no signal about quality. It takes one still image, returns a score with no pass/fail field, and nothing shows it detects replay or spoofing; the docs mention the camera challenge only for the SDK. For a wallet platform, a single still posted from our own API is a weak control and the response cannot be tested in sandbox.
- The widget path matches the existing async job model (create a session, the user completes it on the client, the result arrives by webhook and can be fetched by session). The session-create call can be made from our backend (verified to the "invalid widget" error), but the result payloads, webhook headers and signature, and the fetch response are not verified.

Updated after the widget run (section 8):

- Verified for the widget path: sessions can be created from our backend, `metadata` round-trips, the session lives 24 hours, the session can be fetched by `session_id` with the secret key, and a passive face scan returned `liveness: passed` with a confidence out of 100.
- Not verified: the webhook and redirect, the completed result, and the signature. Also, the widget cannot be tested without paying (production only, per-verification price, balance 0 left the session in `pending_payment`), and the data-check step is part of the widget flow (it is not liveness-only).
- Gesture (active) liveness timed out in a manual run before the capture finished. Passive worked first time. Active liveness is the stronger control but has a usability risk until support explains the timer.

Recommendation stays: the widget path, with the session fetch (`GET .../sessions/{session_id}/`) as the source of truth and the webhook as a trigger, because the fetch is verified and the webhook is not. It maps onto the job model as: `submitLiveness` creates a session and returns `session_id` plus the iframe URL; `getLivenessResult` fetches the session and reads `face_scan_result.liveness`; `parseWebhookJobId` stays unimplemented until a real webhook payload is captured. REST liveness remains a weaker fallback. Two caveats must be settled with Prembly before committing: the cost and billing flow of the widget (paid before the BVN step runs, `pending_payment`) and the face retention and cross-matching behaviour (question 15).
