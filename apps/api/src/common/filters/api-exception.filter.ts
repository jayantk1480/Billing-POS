import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ApiError } from '@pos/types';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { REQUEST_ID_HEADER } from '../middleware/request-id.middleware.js';

/** A business-rule failure with a stable machine-readable code. */
export class DomainError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
    public readonly details?: unknown,
  ) {
    super(message, status);
  }
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 422: 'UNPROCESSABLE', 429: 'RATE_LIMITED',
};

const PRISMA_ERRORS: Record<string, ApiError> = {
  P2002: { statusCode: 409, code: 'DUPLICATE', message: 'That value is already in use.' },
  P2003: { statusCode: 409, code: 'IN_USE', message: 'This record is used elsewhere and cannot be changed this way.' },
  P2025: { statusCode: 404, code: 'NOT_FOUND', message: 'Record not found.' },
  P2034: { statusCode: 409, code: 'BUSY', message: 'Someone else changed this at the same moment. Please try again.' },
};

/** Turns every thrown error into the one error shape clients rely on. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = req.headers[REQUEST_ID_HEADER] as string | undefined;

    let body: ApiError;
    if (exception instanceof DomainError) {
      body = { statusCode: exception.getStatus(), code: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof ZodError) {
      body = {
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        message: 'Some fields are invalid',
        details: exception.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      };
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string' ? response : ((response as { message?: string | string[] }).message ?? exception.message);
      body = {
        statusCode: status,
        code: STATUS_CODES[status] ?? 'HTTP_ERROR',
        message: Array.isArray(message) ? message.join('; ') : message,
      };
    } else if (PRISMA_ERRORS[(exception as { code?: string })?.code ?? '']) {
      // A database rule caught something the service did not check first (usually a race).
      body = PRISMA_ERRORS[(exception as { code: string }).code]!;
    } else {
      // Unknown failure: log everything, tell the client nothing internal.
      this.logger.error(
        `Unhandled error on ${req.method} ${req.url} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      body = { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };
    }

    res.status(body.statusCode).json({ ...body, requestId });
  }
}
