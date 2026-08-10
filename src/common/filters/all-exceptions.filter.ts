import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId: string;
}

/**
 * Catches everything (not just HttpException) so an unhandled error — a
 * Prisma error, a null-deref, whatever — never reaches the client as a raw
 * stack trace. Unhandled errors are logged in full server-side, keyed by
 * requestId, and reduced to a generic message on the wire.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Reuse an inbound id if a client/proxy already set one, so traces stay
    // joined across services — otherwise mint one so every error is findable
    // in logs even when the caller didn't send anything.
    const requestId =
      (request.headers['x-request-id'] as string | undefined) || randomUUID();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const { error, message } = this.resolveBody(exception, isHttpException);

    const body: ErrorResponseBody = {
      statusCode: status,
      error,
      message,
      path: request.originalUrl ?? request.url,
      timestamp: new Date().toISOString(),
      requestId,
    };

    if (!isHttpException) {
      this.logger.error(
        `[${requestId}] Unhandled exception on ${request.method} ${body.path}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status >= 500) {
      this.logger.error(
        `[${requestId}] ${request.method} ${body.path} -> ${status}: ${JSON.stringify(message)}`,
      );
    }

    response.setHeader('x-request-id', requestId);
    response.status(status).json(body);
  }

  private resolveBody(
    exception: unknown,
    isHttpException: boolean,
  ): { error: string; message: string | string[] } {
    if (isHttpException) {
      const httpException = exception as HttpException;
      const res = httpException.getResponse();
      if (typeof res === 'string') {
        return { error: httpException.name, message: res };
      }
      const resObj = res as { message?: string | string[]; error?: string };
      return {
        error: resObj.error ?? httpException.name,
        message: resObj.message ?? httpException.message,
      };
    }

    // Deliberately generic — an unhandled error's message can contain
    // internal details (DB constraints, file paths, library internals) that
    // have no business reaching a client.
    return {
      error: 'Internal Server Error',
      message: 'Something went wrong. Please try again later.',
    };
  }
}
