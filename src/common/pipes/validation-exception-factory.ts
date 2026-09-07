import type { ValidationError } from "@nestjs/common";
import { ApiException } from "../exceptions/api.exception.js";
import type { ApiFieldError } from "../types/api-response.interface.js";

/** Achata erros aninhados do class-validator (`endereco.cep`, `itens[0].quantidade`…). */
function achatarErros(erros: ValidationError[], caminho = ""): ApiFieldError[] {
  return erros.flatMap((erro) => {
    const campo = caminho ? `${caminho}.${erro.property}` : erro.property;
    const proprios = Object.values(erro.constraints ?? {}).map((message) => ({ field: campo, message }));
    const filhos = erro.children?.length ? achatarErros(erro.children, campo) : [];
    return [...proprios, ...filhos];
  });
}

/**
 * `exceptionFactory` do `ValidationPipe` global — traduz os erros do
 * class-validator para o envelope público de erro, no lugar da resposta
 * padrão do NestJS (`{ statusCode, message: string[], error }`).
 */
export function validationExceptionFactory(erros: ValidationError[]): ApiException {
  return ApiException.validation("Dados inválidos.", achatarErros(erros));
}
