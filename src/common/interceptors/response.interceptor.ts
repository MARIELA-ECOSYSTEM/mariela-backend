import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { ApiResponse } from "../types/api-response.interface.js";

function jaEnvelopado(valor: unknown): boolean {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor) && "data" in valor;
}

/**
 * Envelopa toda resposta de sucesso em `{ data }`. Um handler que já precisa
 * de `meta`/`facets` (listagens paginadas) pode devolver `{ data, meta, facets }`
 * diretamente — o interceptor não envelopa de novo.
 *
 * O cast abaixo é seguro: quando `jaEnvelopado` é verdadeiro, o próprio
 * handler já construiu o valor como `ApiResponse<T>` (é o único formato de
 * retorno com uma chave `data`); não há como expressar essa relação apenas
 * com o predicado de tipo, já que `T` é genérico e não estruturalmente ligado a `ApiResponse<T>`.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    return next
      .handle()
      .pipe(map((valor) => (jaEnvelopado(valor) ? (valor as ApiResponse<T>) : { data: valor })));
  }
}
