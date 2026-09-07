import { HttpException, HttpStatus } from "@nestjs/common";
import { ERROR_CODES, type ErrorCode } from "../constants/error-codes.constant.js";
import type { ApiFieldError } from "../types/api-response.interface.js";

interface ApiExceptionPayload {
  statusCode: number;
  code: ErrorCode;
  message: string;
  errors?: ApiFieldError[];
}

/**
 * Exceção de domínio/API — única forma pela qual services e controllers devem
 * sinalizar erros de negócio. O `HttpExceptionFilter` a traduz para o envelope
 * público `{ statusCode, code, message, errors }`, com o mesmo formato e os
 * mesmos códigos que o frontend já espera em `ApiError` (`src/types/api.ts`).
 */
export class ApiException extends HttpException {
  readonly code: ErrorCode;
  readonly errors: ApiFieldError[];

  constructor({ statusCode, code, message, errors = [] }: ApiExceptionPayload) {
    super({ statusCode, code, message, errors }, statusCode);
    this.code = code;
    this.errors = errors;
  }

  static validation(message = "Dados inválidos.", errors: ApiFieldError[] = []): ApiException {
    return new ApiException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.VALIDATION_ERROR,
      message,
      errors,
    });
  }

  static notFound(message = "Registro não encontrado."): ApiException {
    return new ApiException({ statusCode: HttpStatus.NOT_FOUND, code: ERROR_CODES.NOT_FOUND, message });
  }

  static unauthorized(message = "Credenciais inválidas."): ApiException {
    return new ApiException({
      statusCode: HttpStatus.UNAUTHORIZED,
      code: ERROR_CODES.UNAUTHORIZED,
      message,
    });
  }

  static forbidden(message = "Acesso não permitido."): ApiException {
    return new ApiException({ statusCode: HttpStatus.FORBIDDEN, code: ERROR_CODES.FORBIDDEN, message });
  }

  static conflict(message = "Conflito com o estado atual do recurso."): ApiException {
    return new ApiException({ statusCode: HttpStatus.CONFLICT, code: ERROR_CODES.CONFLICT, message });
  }

  static tooManyRequests(message = "Muitas tentativas. Tente novamente mais tarde."): ApiException {
    return new ApiException({ statusCode: HttpStatus.TOO_MANY_REQUESTS, code: ERROR_CODES.TOO_MANY_REQUESTS, message });
  }

  /**
   * Único erro para email inexistente, senha incorreta OU usuário inativo no
   * LOGIN — nunca diferencie a mensagem entre esses três casos (permitiria
   * enumerar contas cadastradas).
   */
  static invalidCredentials(message = "Usuário ou senha inválidos."): ApiException {
    return new ApiException({ statusCode: HttpStatus.UNAUTHORIZED, code: ERROR_CODES.INVALID_CREDENTIALS, message });
  }

  static refreshTokenInvalid(message = "Sessão expirada. Faça login novamente."): ApiException {
    return new ApiException({
      statusCode: HttpStatus.UNAUTHORIZED,
      code: ERROR_CODES.REFRESH_TOKEN_INVALID,
      message,
    });
  }

  /** Um refresh token já revogado foi reapresentado — trate como possível comprometimento da sessão. */
  static refreshTokenReused(message = "Sessão inválida. Faça login novamente."): ApiException {
    return new ApiException({
      statusCode: HttpStatus.UNAUTHORIZED,
      code: ERROR_CODES.REFRESH_TOKEN_REUSED,
      message,
    });
  }

  static userInactive(message = "Este usuário foi desativado."): ApiException {
    return new ApiException({ statusCode: HttpStatus.UNAUTHORIZED, code: ERROR_CODES.USER_INACTIVE, message });
  }
}
