/**
 * Formatos de ENTRADA para criação de documentos/subdocumentos — deliberadamente
 * simples (não reutilizam as classes decoradas `@Schema`, que descrevem o
 * formato PERSISTIDO/lido, com `Types.DocumentArray` etc.). Evita casts
 * artificiais no service só para satisfazer o tipo de subdocumento do Mongoose.
 */

import type { Types } from "mongoose";
import type { Variante } from "./schemas/variante.schema.js";

export interface DadosCriarProduto {
  codProduto: string;
  nome: string;
  descricao: string;
  categoria: string;
  colecaoId: string | null;
  campanhaId: string | null;
  fornecedorId: string | null;
  precoCusto: number;
  precoVenda: number;
  margemLucro: number;
  ehNovidade: boolean;
  ehPromocao: false;
  precoPromocional: null;
  quantidadeTotal: 0;
  fotoPrincipalVarianteId: null;
  estoqueZeradoEm: null;
  excluidoEm: null;
  variantes: [];
}

export interface DadosNovaVariante {
  cor: string;
  corNormalizada: string;
  codVariante: string;
  quantidadeVariante: 0;
  foto: string | null;
  video: string | null;
  tamanhos: [];
}

/**
 * Fase 55.8 — tipo de RETORNO (não de entrada): o elemento exato de
 * `Produto.variantes` (`Types.DocumentArray<Variante>`), um subdocumento com
 * `_id`. Não é `VarianteDocument` (`HydratedDocument<Variante>`), que declara
 * `__v` — subdocumentos não têm `__v`, então atribuir um ao outro exigiria cast.
 */
export type VarianteSubdocumento = Types.Subdocument<Types.ObjectId, unknown, Variante> & Variante;
