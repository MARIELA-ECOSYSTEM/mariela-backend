/** Contagem de uma opção de faceta (filtro), com o total de itens que a satisfazem. */
export interface FacetOption {
  valor: string;
  count: number;
}

/** Contagens de filtros por grupo — mesmo formato consumido hoje pelo mock do frontend. */
export type ApiFacets = Record<string, FacetOption[]>;

export interface ApiMeta {
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
}

/** Envelope de sucesso — todo endpoint de negócio responde neste formato. */
export interface ApiResponse<T> {
  data: T;
  meta?: ApiMeta;
  facets?: ApiFacets;
}

export interface ApiFieldError {
  field: string;
  message: string;
}

/** Envelope de erro — corresponde a `ApiError` no frontend (`src/types/api.ts`). */
export interface ApiErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  errors?: ApiFieldError[];
}
