/**
 * Grupos de facetas de Campanhas — mesmo esquema de seleção múltipla (CSV) já
 * usado por Produtos/Clientes/Fornecedores/Coleções, aplicado aos filtros que
 * a tela de Campanhas já expõe (`src/routes/_backoffice/campanhas/index.tsx`).
 * Campanha é estruturalmente idêntica a Coleção (mesmos componentes
 * compartilhados `PeriodoCard`/`PeriodoDialog`/`statusVigencia`) — só muda o
 * uso semântico (ação de comunicação/venda vs. agrupamento de catálogo).
 */
export const FACETAS_CAMPANHA = {
  situacao: "situacao",
  destaque: "destaque",
  banner: "banner",
  produtos: "produtos",
} as const;

export type ChaveFacetaCampanha = (typeof FACETAS_CAMPANHA)[keyof typeof FACETAS_CAMPANHA];

/** Situação derivada de `inicio`/`fim`/`ativo` — mesma regra de `utils/vitrine.ts#statusVigencia` no frontend. */
export const VALORES_SITUACAO = ["ativa", "agendada", "encerrada", "inativa"] as const;
export type ValorSituacao = (typeof VALORES_SITUACAO)[number];

export const VALORES_DESTAQUE = ["sim", "nao"] as const;
export const VALORES_BANNER = ["sim", "nao"] as const;
export const VALORES_PRODUTOS = ["com", "sem"] as const;

export const PREFIXO_CODIGO_CAMPANHA = "CAM";
export const CHAVE_SEQUENCIA_CAMPANHA = "campanha";
export const DIGITOS_CODIGO_CAMPANHA = 4;

export const PAGINA_PADRAO = 1;
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;

export type OrdenarCampanhaPor = "nome" | "criadoEm" | "inicio" | "fim";
export type Ordem = "asc" | "desc";
