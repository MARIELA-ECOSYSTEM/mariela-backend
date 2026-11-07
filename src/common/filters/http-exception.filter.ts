import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiException } from "../exceptions/api.exception.js";
import { ERROR_CODES } from "../constants/error-codes.constant.js";
import type { ApiErrorResponse, ApiFieldError } from "../types/api-response.interface.js";

/**
 * Único ponto de tradução de exceções para o envelope público de erro.
 * Nenhuma mensagem interna do Mongoose, do Express ou uma stack trace deve
 * vazar para o cliente — em produção, erros não mapeados viram uma mensagem
 * genérica (o detalhe vai apenas para o log do servidor).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const producao = process.env["NODE_ENV"] === "production";

    const payload = this.paraEnvelope(exception, producao);

    // Fase 60.4.3.4.12 (F07) — UMA linha por erro 5xx, com método e caminho da requisição (sem a query string, que pode
    // conter termos de busca com dados pessoais) e a mensagem REAL da exceção (a resposta ao cliente continua genérica
    // em produção). Antes, erros não mapeados eram logados duas vezes e nenhuma linha dizia qual rota falhou.
    if (payload.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const mensagemInterna = exception instanceof Error ? exception.message : payload.message;
      this.logger.error(
        `${this.descreverRequisicao(ctx.getRequest<Request | undefined>())} → ${payload.statusCode} ${payload.code}: ${mensagemInterna}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(payload.statusCode).json(payload);
  }

  /** `MÉTODO /caminho` sem query string; tolera contextos sem requisição HTTP. */
  private descreverRequisicao(request: Request | undefined): string {
    if (!request?.method) return "(sem requisição HTTP)";
    const caminho = (request.originalUrl ?? request.url ?? "").split("?")[0] || "/";
    return `${request.method} ${caminho}`;
  }

  private paraEnvelope(exception: unknown, producao: boolean): ApiErrorResponse {
    if (exception instanceof ApiException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        errors: exception.errors,
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      return {
        statusCode,
        code: this.codigoParaStatus(statusCode),
        message: exception.message,
        errors: this.errosDaResposta(exception.getResponse()),
      };
    }

    // O log deste erro não mapeado é feito em `catch` (uma única linha, com a rota) — nunca aqui também.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: producao
        ? "Erro interno do servidor."
        : exception instanceof Error
          ? exception.message
          : "Erro interno do servidor.",
    };
  }

  private codigoParaStatus(statusCode: number): (typeof ERROR_CODES)[keyof typeof ERROR_CODES] {
    switch (statusCode) {
      case HttpStatus.BAD_REQUEST:
        return ERROR_CODES.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ERROR_CODES.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ERROR_CODES.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ERROR_CODES.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ERROR_CODES.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ERROR_CODES.TOO_MANY_REQUESTS;
      default:
        return ERROR_CODES.HTTP_ERROR;
    }
  }

  /** `HttpException` nativas (ex.: guards, 404 de rota inexistente) não têm `errors[]` estruturado. */
  private errosDaResposta(resposta: string | object): ApiFieldError[] | undefined {
    if (typeof resposta === "object" && resposta !== null && "errors" in resposta) {
      const { errors } = resposta as { errors?: ApiFieldError[] };
      return errors;
    }
    return undefined;
  }
}
