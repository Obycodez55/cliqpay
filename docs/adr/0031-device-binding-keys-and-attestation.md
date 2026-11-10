# ADR-0031: One bound device per user, proven by a hardware-held key, with attestation in shadow mode

**Status:** accepted
**Date:** 2026-11-09

## Context

Cliqpay's only customer client is a React Native app (§9); the admin panel is
a separate web app with its own auth. The backend, though, was built as if
web-first: the trusted-device token travels in a cookie, any number of devices
and sessions can be active at once, and the only device fingerprint is IP plus
user agent (ADR-0003).

The CBN's instant-payment circular (12 March 2026, compliance 1 July 2026)
requires a mobile banking app to be active on one device at a time, with a
device switch deactivating the old device and requiring re-authentication.
Account takeover in Nigeria runs through SIM swap, phished credentials and
social engineering; a refresh token or a device id copied off one phone
should not work from another.

The mobile app does not exist yet. The server side should be complete and
fixed as a contract, so the app only has to integrate.

## Decision

**Device id.** The app generates a stable install id, keeps it in
Keychain/Keystore, and sends it as `X-Device-Id` on login, MFA verification,
token refresh and every authenticated request. Each session and trusted device
stores its `deviceId`; a refresh presenting a different one is treated like
refresh-token reuse (§3.7): the session is revoked and a security alert sent.

**One device per user.** Trusting a new device revokes every other trusted
device, session and device key for the user, alerts the old device by push and
email, and starts the security cooldown (ADR-0034).

**The trusted-device token moves to a header.** The cookie path is removed.

**A device key.** When a device becomes trusted, the app generates an ECDSA
P-256 key in the Secure Enclave / Android Keystore and registers the public
key. Both raw 65-byte uncompressed (iOS) and X.509 SPKI (Android) encodings
are accepted and stored as SPKI.

- **Login and refresh** need a signed challenge: the app fetches a single-use
  nonce (2-minute life, bound to `deviceId` and purpose), signs
  `purpose ‖ nonce ‖ deviceId`, and sends the DER signature. A bad signature
  is a theft signal, handled like a device-id mismatch.
- **Money actions** are signed without a round trip: P2P send, paying a money
  request, withdrawal, creating or changing a schedule, saving a bank account,
  and changing or resetting the PIN sign
  `action ‖ reference ‖ amount ‖ target ‖ timestamp`. The timestamp must be
  within 2 minutes; the client `reference` already makes a replay a no-op, and
  changing amount or target breaks the signature.

**Attestation.** Registration accepts an `attestation` payload, verified by a
`DeviceAttestationVerifier` with Apple App Attest, Google Play Integrity and
fake implementations. Results (`passed` | `failed` | `unavailable`) are stored
per device. `DEVICE_ATTESTATION_MODE` (`off` | `shadow` | `enforce`, default
`shadow`): in shadow a failure raises a `device_integrity` flag instead of
blocking. The Apple and Google verifiers are implemented against their docs
but cannot be proven without real tokens, our Team ID/bundle id and a Google
Cloud project; they stay unproven until the mobile integration pass.

**A switch for testing.** `DEVICE_KEY_REQUIRED` (default `true`). When
`false`, signature checks are skipped on login, refresh and money actions;
`X-Device-Id` is still required, so binding and the shared-device rule behave
as in production. Boot is refused with `false` under `NODE_ENV=production`,
the same guard as the fake payment adapter.

**Cutover.** No real users exist. The migration adding the columns revokes all
sessions and trusted devices and makes `deviceId` non-null; everyone logs in
once.

## Alternatives considered

- **Binding by device id alone.** The id is a header: a stolen password plus
  MFA could present any id from a script. The key makes a copied token or id
  useless without the hardware.
- **One device per client kind (web vs mobile).** Moot with a mobile-only
  customer client.
- **Deferring keys and attestation to the mobile build.** The protocol would
  then be designed under app-release pressure; building it now makes it a
  contract the app implements.
- **Enforcing attestation now.** Older and rooted Android devices fail it
  routinely; blocking them is a launch-time product decision.
- **A challenge round trip for money actions.** The idempotency reference and
  a short timestamp window give the same replay protection without one.

## Consequences

- Login and refresh cost one extra request (the challenge).
- A phone change means login, MFA, the old device signed out, and the ₦20,000
  24-hour cooldown. That is the CBN's intent.
- The OpenAPI spec documents the key formats, signing strings and attestation
  payloads exactly; the app team builds against it.
- `shared_device` (≥3 users on one `deviceId` in 30 days) runs in shadow in
  `risk` (ADR-0032).
- The attestation verifiers carry untested-against-reality risk until the
  mobile pass checks them with real tokens.

## Wire format

- **Device id:** `X-Device-Id`, 8–128 characters of `A–Z a–z 0–9 . _ -`. Access tokens carry it as the `did` claim and every authenticated request must send the same value.
- **Trusted-device token:** `X-Trusted-Device-Token` request header on login; returned in the `X-Trusted-Device-Token` response header of `POST /mfa/verify`.
- **Challenge:** `POST /auth/device-challenge` `{ purpose: "login" | "refresh" | "register" }` returns a 43-character base64url `nonce` and `expiresAt` (2 minutes). Single use, bound to `X-Device-Id` and purpose.
- **Signing string:** the parts joined by LF (0x0A), UTF-8. The nonce is signed as the received string, not decoded. Login: `login\n<nonce>\n<deviceId>`; refresh: `refresh\n<nonce>\n<deviceId>`. Signature: ECDSA P-256 over SHA-256, ASN.1 DER, standard base64, sent as `signature` beside `nonce`. The shared helpers are `buildSigningString` and `verifyDeviceSignature` in `src/shared/crypto/device-signature.util.ts`; money actions reuse them.
- **Key registration:** `devicePublicKey` on `POST /mfa/verify`, base64 of the raw 65-byte uncompressed point or of X.509 SPKI.
- **Attestation:** `attestation: { platform: "ios" | "android", nonce (a `register` nonce), keyId (iOS), token }`. The attested client data is `attest\n<nonce>\n<deviceId>\n<base64 of the 65-byte uncompressed point>`. iOS: App Attest `clientDataHash` is its SHA-256, `token` is the base64 attestation object. Android: the Play Integrity nonce is `base64url(SHA-256(client data))`, `token` is the integrity token, verified locally with the Play Console response-encryption keys.
- **Money-action signature:** headers `X-Device-Signature` (ASN.1 DER ECDSA P-256 / SHA-256, standard base64) and `X-Signature-Timestamp` (Unix seconds, decimal). The signed string is `action \n reference \n amount \n target \n timestamp` (LF-joined, UTF-8; an empty part stays an empty line). The key is the one registered on the caller's trusted device for the request's `X-Device-Id`. Checked by one guard before the handler runs, so nothing is posted or changed on failure. Errors, all 401: `ACTION_SIGNATURE_REQUIRED` (a header missing), `ACTION_SIGNATURE_STALE` (timestamp not a Unix-seconds integer, or more than 120 s from server time either way), `ACTION_SIGNATURE_INVALID` (bad signature, including a tampered field), `DEVICE_KEY_NOT_REGISTERED` (no live trusted device with a key for this device id). `amount` is minor units as a decimal integer string, `""` where the action has no client-supplied amount.

  | Endpoint | `action` | `reference` | `amount` | `target` |
  |---|---|---|---|---|
  | `POST /transfers` | `transfer.send` | body `reference` | body `amount` | body `recipientUserId` |
  | `POST /money-requests/:id/pay` | `money_request.pay` | body `reference` | `""` (fixed by the request) | the request id from the path |
  | `POST /withdrawals` | `withdrawal.initiate` | body `reference` | body `amount` | body `bankAccountId` |
  | `POST /withdrawals/bank-accounts` | `bank_account.save` | body `challengeId` (the single-use step-up) | `""` | `<bankCode>:<accountNumber>` from the body (the account has no id yet) |
  | `POST /scheduled-payments` | `schedule.create` | body `reference` | body `amount` | body `target.userId`, or `target.bankAccountId` |
  | `PATCH /scheduled-payments/:id` | `schedule.update` | lowercase hex SHA-256 of `<interval>\|<nextRunDate>\|<endDate>\|<maxRuns>` | body `amount`, or `""` if absent | the schedule id from the path |
  | `POST /scheduled-payments/:id/resume` | `schedule.resume` | the schedule id from the path | `""` | the schedule id from the path |
  | `POST /auth/transaction-pin/change` | `pin.change` | body `challengeId` | `""` | the caller's user id |
  | `POST /auth/transaction-pin/reset` | `pin.reset` | body `challengeId` | `""` | the caller's user id |

  For `schedule.update` the signature is required only when the body contains `amount`, `interval`, `nextRunDate`, `endDate` or `maxRuns`; note/visibility-only edits need none. In the digest, an absent field is `""`, an explicit `null` is `null`, `interval` is `<unit>:<count>` (for example `day:2`), numbers are decimal integers; so `{ amount, interval: day/2 }` hashes `day:2|||`.
- **Key lifetime:** a device key stays valid for as long as its device does: until the device is replaced, self-locked or revoked for a mismatch. The trusted device's `expiresAt` only decides whether its token skips MFA at login; it never invalidates the key for refresh or signed actions.
- **Replay:** a repeated request is authorised afresh: it needs its own signature with a timestamp inside the window, so an old captured request fails with `ACTION_SIGNATURE_STALE`. A fresh signature over the same `reference` passes the guard and the endpoint's idempotency then returns the original result without posting again.
- **Unproven:** the Apple and Google verifiers are covered by synthetic tests only (Google round trip with locally generated keys; Apple's CBOR decoder), not against real tokens.
