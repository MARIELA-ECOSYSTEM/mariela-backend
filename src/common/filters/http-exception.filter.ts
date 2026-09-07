import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
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

    if (payload.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(payload.message, exception instanceof Error ? exception.stack : undefined);
    }

    response.status(payload.statusCode).json(payload);
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

    this.logger.error(
      exception instanceof Error ? exception.message : "Erro desconhecido.",
      exception instanceof Error ? exception.stack : undefined,
    );
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
