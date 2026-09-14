import type { ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerLimitDetail } from "@nestjs/throttler";
import { ApiException } from "../exceptions/api.exception.js";

/**
 * Etapa 24 — `ThrottlerGuard` padrão lança `ThrottlerException` (mensagem em
 * inglês, sem `code` estável), o que criaria um SEGUNDO formato de erro só
 * para 429, divergente do envelope `{statusCode, code, message, errors}` que
 * `HttpExceptionFilter` já usa para todo o resto da API. `ApiException
 * .tooManyRequests()` já existe desde a Etapa 18.23 exatamente para este
 * caso (código `TOO_MANY_REQUESTS`), mas nunca tinha sido lançada em lugar
 * nenhum — este guard é o único ponto de ajuste necessário: o rastreamento
 * (`getTracker`/`generateKey`), a contagem e os headers `Retry-After`/
 * `X-RateLimit-*` continuam exatamente o comportamento padrão da biblioteca
 * (`handleRequest`, não sobrescrito aqui).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    _context: ExecutionContext,
    _throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw ApiException.tooManyRequests();
  }
}
