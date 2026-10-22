import { Logger } from '@nestjs/common';

export type ProviderHttpFailure = 'network' | 'timeout' | 'invalid_body';

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderHttpFailure,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ProviderHttpError';
  }
}

export interface RequestJsonOptions {
  provider: string;
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown; // FormData is sent as multipart, anything else as JSON
  timeoutMs: number;
}

export interface JsonResult<T> {
  status: number;
  ok: boolean;
  body: T;
}

const logger = new Logger('ProviderHttp');

// Metadata only: headers carry credentials and bodies carry BVNs, account
// numbers and emails, so neither is ever logged.
function describeTarget(url: string): string {
  const { host, pathname } = new URL(url);
  return `${host}${pathname}`;
}

function transportFailure(
  provider: string,
  error: unknown,
  status?: number,
): ProviderHttpError {
  const cause = error as Error;
  return new ProviderHttpError(
    provider,
    cause.name === 'TimeoutError' ? 'timeout' : 'network',
    `${provider}: network error (${cause.message})`,
    status,
    error,
  );
}

export async function requestJson<T>(
  options: RequestJsonOptions,
): Promise<JsonResult<T>> {
  const { provider, url, method, timeoutMs } = options;
  const startedAt = Date.now();
  const target = `${method} ${describeTarget(url)}`;

  try {
    const result = await send<T>(options);
    logger.debug(
      `${provider} ${target} -> ${result.status} (${Date.now() - startedAt}ms)`,
    );
    return result;
  } catch (error) {
    const failure = error as ProviderHttpError;
    logger.warn(
      `${provider} ${target} failed: ${failure.kind} after ${Date.now() - startedAt}ms (timeout ${timeoutMs}ms)`,
    );
    throw error;
  }
}

async function send<T>({
  provider,
  url,
  method,
  headers,
  body,
  timeoutMs,
}: RequestJsonOptions): Promise<JsonResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers:
        body === undefined || body instanceof FormData
          ? headers
          : { ...headers, 'Content-Type': 'application/json' },
      body:
        body === undefined || body instanceof FormData
          ? body
          : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw transportFailure(provider, error);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ProviderHttpError(
        provider,
        'invalid_body',
        `${provider}: invalid response body (${response.status})`,
        response.status,
        error,
      );
    }
    throw transportFailure(provider, error, response.status);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new ProviderHttpError(
      provider,
      'invalid_body',
      `${provider}: invalid response body (${response.status})`,
      response.status,
    );
  }

  return { status: response.status, ok: response.ok, body: parsed as T };
}
