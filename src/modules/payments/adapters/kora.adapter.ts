import { createHmac, timingSafeEqual } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../../config';
import {
  JsonResult,
  ProviderHttpError,
  requestJson,
} from '../../../shared/http/request-json';
import { Money } from '../../../shared/primitives/money';
import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  InitiatePayoutParams,
  InitiatePayoutResult,
  InitiateRefundParams,
  InitiateRefundResult,
  PaymentProviderAdapter,
  ResolveBankAccountResult,
  VerifyChargeResult,
  VerifyPayoutResult,
  VerifyRefundResult,
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

// Ground truth: a real sandbox call to POST /misc/banks/resolve, run during
// issue #27's design (not guessed from docs), per the same discipline as
// ADR-0007. A resolvable account returns `status: true` with
// `data.account_name`; both an unknown account number and an invalid bank
// code come back as `status: false` over a 400/404 respectively, with no
// distinct field distinguishing the two cases from each other — Kora
// exposes both as one flavor of "couldn't resolve this."
interface KoraResolveBankAccountResponse {
  status: boolean;
  message: string;
  data?: {
    bank_name: string;
    bank_code: string;
    account_number: string;
    account_name: string;
  };
}

interface KoraDisburseResponse {
  status: boolean;
  message: string;
  error?: string;
  data?: {
    status: string; // 'processing' | 'failed' | ... — only these two observed
    message: string;
    reference: string;
  };
}

interface KoraPayoutStatusResponse {
  status: boolean;
  message: string;
  data?: {
    status: string; // 'success' | 'failed' | 'processing' | ...
    message: string;
    reference: string;
    amount: string;
    currency: string;
  };
}

// Ground truth: docs/research/kora-refunds.md and test/fixtures/kora-refunds.
// Failures carry a Kora `code` (AA021 conflict, AA025 invalid amount, AA026
// not found); only the status and `message` are relied on here.
interface KoraRefundInitiateResponse {
  status: boolean;
  message: string;
  code?: string;
  data?: { status: string; refund_reference: string } | null;
}

interface KoraRefundStatusResponse {
  status: boolean;
  message: string;
  code?: string;
  data?: {
    status: string;
    amount: string;
    currency: string;
    reference: string;
  } | null;
}

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
    const { ok, status, body } = await this.request<KoraInitializeResponse>(
      'POST',
      '/charges/initialize',
      {
        amount: params.amount.toDecimalString(),
        currency: params.amount.currency,
        reference: params.reference,
        customer: { email: params.customerEmail },
        notification_url: this.webhookUrl,
        redirect_url: this.redirectUrl,
        // The funding posting assumes the payer bears Kora's fee
        merchant_bears_cost: false,
      },
    );
    if (!ok || !body.status || !body.data) {
      throw new Error(
        `KoraAdapter: ${status} ${body.message ?? 'unknown error'}`,
      );
    }

    return { checkoutUrl: body.data.checkout_url };
  }

  // The self-verify poll path — called only for transactions
  // whose webhook never arrived within the normal window, so this doesn't
  // run per-request.
  async verifyCharge(reference: string): Promise<VerifyChargeResult> {
    const { ok, status, body } = await this.request<KoraVerifyChargeResponse>(
      'GET',
      `/charges/${reference}`,
    );
    if (!ok || !body.status || !body.data) {
      throw new Error(
        `KoraAdapter: ${status} ${body.message ?? 'unknown error'}`,
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

  async getBalance(currency: string): Promise<Money> {
    const { ok, status, body } = await this.request<KoraBalancesResponse>(
      'GET',
      '/balances',
    );
    if (!ok || !body.status || !body.data) {
      throw new Error(
        `KoraAdapter: ${status} ${body.message ?? 'unknown error'}`,
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

  async resolveBankAccount(
    bankCode: string,
    accountNumber: string,
  ): Promise<ResolveBankAccountResult> {
    const { ok, status, body } =
      await this.request<KoraResolveBankAccountResponse>(
        'POST',
        '/misc/banks/resolve',
        { bank: bankCode, account: accountNumber },
      );

    if (ok && body.status && body.data) {
      return {
        status: 'resolved',
        bankName: body.data.bank_name,
        accountName: body.data.account_name,
      };
    }
    if (status === 400 || status === 404) {
      return { status: 'not_found' };
    }
    throw new Error(
      `KoraAdapter: ${status} ${body.message ?? 'unknown error'}`,
    );
  }

  // Any non-2xx other than the documented 409-rejection shape (see
  // KoraDisburseResponse) is a genuine system failure and still throws, same
  // as every other adapter method — only a *recognized* synchronous
  // rejection becomes the typed `rejected` result the caller reverses on.
  async initiatePayout(
    params: InitiatePayoutParams,
  ): Promise<InitiatePayoutResult> {
    let response: JsonResult<KoraDisburseResponse>;
    try {
      response = await this.request<KoraDisburseResponse>(
        'POST',
        '/transactions/disburse',
        {
          reference: params.reference,
          destination: {
            type: 'bank_account',
            amount: params.amount.toDecimalString(),
            currency: params.amount.currency,
            narration: `Cliqpay withdrawal ${params.reference}`,
            bank_account: {
              bank: params.bankCode,
              account: params.accountNumber,
            },
            customer: { name: params.accountName, email: params.customerEmail },
          },
        },
      );
    } catch (error) {
      // Whatever went wrong getting or reading the response — network error,
      // timeout, unreadable body — Kora's receipt of the request is genuinely
      // unknown.
      if (error instanceof ProviderHttpError) {
        return { status: 'unknown', detail: error.message };
      }
      throw error;
    }
    const { ok, status, body } = response;

    if (ok && body.status && body.data?.status === 'processing') {
      return { status: 'accepted' };
    }
    if (status === 409 && body.data?.status === 'failed') {
      return { status: 'rejected', reason: body.data.message };
    }
    // Any other shape (5xx, an unrecognized 2xx/4xx body) is not a
    // confirmed rejection either — same `unknown` reasoning as the network
    // error above.
    return {
      status: 'unknown',
      detail: `${status} ${body.message ?? 'unknown error'}`,
    };
  }

  // The self-verify poll path for withdrawals (issue #31) — called only for
  // payouts whose webhook never arrived within the normal window, mirroring
  // verifyCharge's role and status mapping for funding.
  async verifyPayout(reference: string): Promise<VerifyPayoutResult> {
    const { ok, status, body } = await this.request<KoraPayoutStatusResponse>(
      'GET',
      `/transactions/${reference}`,
    );
    if (!ok || !body.status || !body.data) {
      throw new Error(
        `KoraAdapter: ${status} ${body.message ?? 'unknown error'}`,
      );
    }

    if (body.data.status === 'success') {
      return {
        status: 'success',
        amount: Money.fromDecimalString(body.data.amount, body.data.currency),
      };
    }
    if (body.data.status === 'failed') {
      return { status: 'failed', reason: body.data.message };
    }
    return { status: 'pending' };
  }

  // No `webhook_url`: the dashboard URL already reaches the one verified
  // endpoint, and `amount` is always sent so Kora refunds exactly the
  // credited principal rather than the payer's gross.
  async initiateRefund(
    params: InitiateRefundParams,
  ): Promise<InitiateRefundResult> {
    let response: JsonResult<KoraRefundInitiateResponse>;
    try {
      response = await this.request<KoraRefundInitiateResponse>(
        'POST',
        '/refunds/initiate',
        {
          payment_reference: params.paymentReference,
          reference: params.reference,
          amount: params.amount.toDecimalString(),
          reason: params.reason,
        },
      );
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        return { status: 'unknown', detail: error.message };
      }
      throw error;
    }
    const { ok, status, body } = response;

    if (ok && body.status) {
      return { status: 'accepted' };
    }
    if (status === 409 && body.message?.startsWith('Refund already exists')) {
      return { status: 'already_exists' };
    }
    if (status >= 400 && status < 500 && body.message) {
      return { status: 'rejected', reason: body.message };
    }
    return {
      status: 'unknown',
      detail: `${status} ${body.message ?? 'unknown error'}`,
    };
  }

  async verifyRefund(reference: string): Promise<VerifyRefundResult> {
    const { ok, status, body } = await this.request<KoraRefundStatusResponse>(
      'GET',
      `/refunds/${reference}`,
    );
    if (status === 404 && body.code === 'AA026') {
      return { status: 'not_found' };
    }
    if (!ok || !body.status || !body.data) {
      throw new Error(
        `KoraAdapter: ${status} ${body.message ?? 'unknown error'}`,
      );
    }

    if (body.data.status === 'success') {
      return {
        status: 'success',
        amount: Money.fromDecimalString(body.data.amount, body.data.currency),
      };
    }
    if (body.data.status === 'failed') {
      return { status: 'failed', reason: 'Refund failed at the provider' };
    }
    return { status: 'pending' };
  }

  private request<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
    return requestJson<T>({
      provider: 'KoraAdapter',
      url: `${KORA_BASE_URL}${path}`,
      method,
      headers: { Authorization: `Bearer ${this.secretKey}` },
      body,
      timeoutMs: KORA_TIMEOUT_MS,
    });
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
