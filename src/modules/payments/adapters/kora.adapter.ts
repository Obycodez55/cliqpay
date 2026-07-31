import { createHmac, timingSafeEqual } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../config';
import { Money } from '../../../shared/primitives/money';
import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  PaymentProviderAdapter,
  VerifyChargeResult,
} from './payment-provider.interface';
import { extractTopLevelJsonField } from '../internal/raw-json';

const KORA_BASE_URL = 'https://api.korapay.com/merchant/api/v1';

// Without this, a hung Kora connection hangs the request handling it
// indefinitely — there's no other timeout upstream that's guaranteed to
// apply.
const KORA_TIMEOUT_MS = 15_000;

interface KoraInitializeResponse {
  status: boolean;
  message: string;
  data?: {
    reference: string;
    checkout_url: string;
  };
}

interface KoraVerifyChargeResponse {
  status: boolean;
  message: string;
  data?: {
    reference: string;
    status: string;
    amount: string;
    fee: number;
    currency: string;
  };
}

// Ground truth for GET /balances confirmed against the real sandbox during
// #15's design (not guessed from docs) — one call returns every currency the
// merchant holds, keyed by currency code, in major units like the charge
// endpoints.
interface KoraBalancesResponse {
  status: boolean;
  message: string;
  data?: Record<string, { pending_balance: number; available_balance: number }>;
}

// Ground truth for the request/response shapes below: docs/adr/0007, backed
// by a real sandbox charge (POST /charges/initialize, then GET
// /charges/{reference}) run during design — not guessed from Kora's docs.
// `notification_url`/`redirect_url` are both optional per that sandbox
// check, but sending them explicitly pins this backend's webhook and the
// customer's post-checkout destination in code (reviewable, per-environment
// config) instead of depending entirely on whatever's set in Kora's
// dashboard, which nothing in this repo could confirm (Phase 2 audit, M2).
@Injectable()
export class KoraAdapter implements PaymentProviderAdapter {
  private readonly secretKey: string;
  private readonly webhookUrl: string;
  private readonly redirectUrl: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.secretKey = config.payments.kora.secretKey!;
    this.webhookUrl = config.payments.kora.webhookUrl!;
    this.redirectUrl = config.payments.kora.redirectUrl!;
  }

  async initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult> {
    let response: Response;
    try {
      response = await fetch(`${KORA_BASE_URL}/charges/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // Kora's amount is major units (naira), not minor units — the
          // one place that conversion happens, right at the provider
          // boundary. Sent as a decimal string, not a float, to avoid any
          // binary-float round-off on the way out.
          amount: params.amount.toDecimalString(),
          currency: params.amount.currency,
          reference: params.reference,
          customer: { email: params.customerEmail },
          notification_url: this.webhookUrl,
          redirect_url: this.redirectUrl,
        }),
        signal: AbortSignal.timeout(KORA_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `KoraAdapter: network error (${(error as Error).message})`,
      );
    }

    const body = (await response.json()) as KoraInitializeResponse;
    if (!response.ok || !body.status || !body.data) {
      throw new Error(
        `KoraAdapter: ${response.status} ${body.message ?? 'unknown error'}`,
      );
    }

    return { checkoutUrl: body.data.checkout_url };
  }

  // The self-verify poll path (issue #14) — called only for transactions
  // whose webhook never arrived within the normal window, so this doesn't
  // run per-request.
  async verifyCharge(reference: string): Promise<VerifyChargeResult> {
    let response: Response;
    try {
      response = await fetch(`${KORA_BASE_URL}/charges/${reference}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.secretKey}` },
        signal: AbortSignal.timeout(KORA_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `KoraAdapter: network error (${(error as Error).message})`,
      );
    }

    const body = (await response.json()) as KoraVerifyChargeResponse;
    if (!response.ok || !body.status || !body.data) {
      throw new Error(
        `KoraAdapter: ${response.status} ${body.message ?? 'unknown error'}`,
      );
    }

    if (body.data.status === 'success') {
      return {
        status: 'success',
        netAmount: Money.fromDecimalString(
          body.data.amount,
          body.data.currency,
        ),
        providerFee: Money.fromDecimalString(
          String(body.data.fee),
          body.data.currency,
        ),
      };
    }
    if (body.data.status === 'failed') {
      return { status: 'failed' };
    }
    return { status: 'pending' };
  }

  // The external reconciliation path (issue #15). Sums `available_balance`
  // AND `pending_balance` — `float_ngn` is credited the moment a charge
  // succeeds (postFunding runs off the webhook/poll result, not off Kora's
  // own settlement), so it reflects money Kora owes us regardless of
  // whether Kora has settled it yet. Comparing against `available_balance`
  // alone (an earlier version of this method did) undercounts by whatever's
  // still mid-settlement (T+1 in Nigeria) and produces a mismatch alert on
  // every successful funding until it settles — a false positive by
  // construction, not a real drift.
  async getBalance(currency: string): Promise<Money> {
    let response: Response;
    try {
      response = await fetch(`${KORA_BASE_URL}/balances`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.secretKey}` },
        signal: AbortSignal.timeout(KORA_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `KoraAdapter: network error (${(error as Error).message})`,
      );
    }

    const body = (await response.json()) as KoraBalancesResponse;
    if (!response.ok || !body.status || !body.data) {
      throw new Error(
        `KoraAdapter: ${response.status} ${body.message ?? 'unknown error'}`,
      );
    }

    const currencyBalance = body.data[currency];
    if (!currencyBalance) {
      throw new Error(
        `KoraAdapter: no balance reported for currency "${currency}"`,
      );
    }

    const available = Money.fromDecimalString(
      String(currencyBalance.available_balance),
      currency,
    );
    const pending = Money.fromDecimalString(
      String(currencyBalance.pending_balance),
      currency,
    );
    return available.add(pending);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const rawData = extractTopLevelJsonField(rawBody, 'data');
    if (!rawData) {
      return false;
    }
    const expected = createHmac('sha256', this.secretKey)
      .update(rawData)
      .digest('hex');

    const expectedBuffer = Buffer.from(expected, 'hex');
    const signatureBuffer = Buffer.from(signature, 'hex');
    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }
    return timingSafeEqual(expectedBuffer, signatureBuffer);
  }
}
