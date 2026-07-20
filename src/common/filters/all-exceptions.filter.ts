import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { DomainException } from '../exceptions/domain.exception';
import { ApiErrorResponse } from '../interfaces/api-error-response.interface';
import { SentryService } from '../sentry.service';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: PinoLogger,
    private readonly sentry: SentryService,
  ) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, code, message, details } = this.resolve(exception);

    if (statusCode >= Number(HttpStatus.INTERNAL_SERVER_ERROR)) {
      this.logger.error({ err: exception }, 'Unhandled exception');
      this.sentry.captureException(exception);
    } else {
      this.logger.warn({ err: exception }, 'Request rejected');
    }

    const body: ApiErrorResponse = {
      success: false,
      statusCode,
      error: { code, message, details },
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(statusCode).json(body);
  }

  private resolve(exception: unknown): {
    statusCode: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof DomainException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const isValidationError =
        status === Number(HttpStatus.BAD_REQUEST) &&
        typeof response === 'object' &&
        Array.isArray((response as { message?: unknown }).message);

      if (isValidationError) {
        return {
          statusCode: status,
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: (response as { message: string[] }).message,
        };
      }

      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string }).message ?? exception.message);

      return { statusCode: status, code: HttpStatus[status], message };
    }

    // Non-Nest errors that still carry a real HTTP status — e.g. body-parser's
    // PayloadTooLargeError (status 413) fires before Nest's pipeline even
    // sees the request, so it never becomes an HttpException.
    const rawStatus = (exception as { status?: unknown; statusCode?: unknown })
      ?.status;
    const rawStatusCode = (exception as { statusCode?: unknown })?.statusCode;
    const status =
      typeof rawStatus === 'number'
        ? rawStatus
        : typeof rawStatusCode === 'number'
          ? rawStatusCode
          : undefined;

    if (status && status >= 400 && status < 500) {
      return {
        statusCode: status,
        code: HttpStatus[status] ?? 'REQUEST_ERROR',
        message:
          exception instanceof Error
            ? exception.message
            : 'Request could not be processed',
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    };
  }
}
