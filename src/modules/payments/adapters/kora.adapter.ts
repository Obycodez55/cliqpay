import { createHmac, timingSafeEqual } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../config';
import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  PaymentProviderAdapter,
} from './payment-provider.interface';

const KORA_BASE_URL = 'https://api.korapay.com/merchant/api/v1';

interface KoraInitializeResponse {
  status: boolean;
  message: string;
  data?: {
    reference: string;
    checkout_url: string;
  };
}

// Ground truth for the request/response shapes below: docs/adr/0007, backed
// by a real sandbox charge (POST /charges/initialize, then GET
// /charges/{reference}) run during design — not guessed from Kora's docs.
// `notification_url` is deliberately omitted: it's optional (confirmed via
// the same sandbox check), and the webhook receiver it would point at isn't
// built until a later issue.
@Injectable()
export class KoraAdapter implements PaymentProviderAdapter {
  private readonly secretKey: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.secretKey = config.payments.kora.secretKey!;
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
        }),
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

  // Per Kora's docs: HMAC-SHA256 of the JSON-stringified `data` object,
  // signed with the secret key, hex-encoded — compared against the
  // `x-korapay-signature` header (the caller passes that header's value in
  // as `signature`). timingSafeEqual over the raw bytes rather than `===`
  // on the hex strings, so an invalid signature doesn't leak timing
  // information about how much of it matched.
  verifyWebhookSignature(data: unknown, signature: string): boolean {
    const expected = createHmac('sha256', this.secretKey)
      .update(JSON.stringify(data))
      .digest('hex');

    const expectedBuffer = Buffer.from(expected, 'hex');
    const signatureBuffer = Buffer.from(signature, 'hex');
    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }
    return timingSafeEqual(expectedBuffer, signatureBuffer);
  }
}
