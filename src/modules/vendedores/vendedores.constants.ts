/**
 * Grupos de facetas de Vendedores — mesmo esquema de seleção múltipla (CSV) já
 * usado por Clientes/Fornecedores/Coleções/Campanhas, aplicado aos filtros que
 * a tela de Vendedores já expõe (`src/routes/_backoffice/vendedores.tsx`):
 * status, faixa de vendas, faixa de valor vendido, última venda, aniversário
 * e presença de observação.
 */
export const FACETAS_VENDEDOR = {
  status: "status",
  vendas: "vendas",
  valor: "valor",
  ultimaVenda: "ultimaVenda",
  nascimento: "nascimento",
  observacao: "observacao",
} as const;

export type ChaveFacetaVendedor = (typeof FACETAS_VENDEDOR)[keyof typeof FACETAS_VENDEDOR];

export const VALORES_STATUS = ["ativos", "inativos"] as const;
export type ValorStatus = (typeof VALORES_STATUS)[number];

/** Mesmas faixas de `OPCOES_FAIXA_VENDAS` no frontend (`src/utils/vendedor.ts`). */
export const VALORES_FAIXA_VENDAS = ["sem", "1-5", "6-20", "21+"] as const;
export type ValorFaixaVendas = (typeof VALORES_FAIXA_VENDAS)[number];

/** Mesmas faixas de `OPCOES_FAIXA_VALOR` no frontend. */
export const VALORES_FAIXA_VALOR = ["ate-500", "500-2000", "2000-10000", "10000+"] as const;
export type ValorFaixaValor = (typeof VALORES_FAIXA_VALOR)[number];

/** Mesmos períodos de `OPCOES_ULTIMA_VENDA` no frontend. */
export const VALORES_ULTIMA_VENDA = ["7", "30", "90", "nunca"] as const;
export type ValorUltimaVenda = (typeof VALORES_ULTIMA_VENDA)[number];

export const VALORES_NASCIMENTO = ["mes", "com", "sem"] as const;
export type ValorNascimento = (typeof VALORES_NASCIMENTO)[number];

export const VALORES_OBSERVACAO = ["com", "sem"] as const;
export type ValorObservacao = (typeof VALORES_OBSERVACAO)[number];

export const PREFIXO_CODIGO_VENDEDOR = "VEN";
export const CHAVE_SEQUENCIA_VENDEDOR = "vendedor";
export const DIGITOS_CODIGO_VENDEDOR = 4;

export const PAGINA_PADRAO = 1;
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;

export type OrdenarVendedorPor = "nome" | "vendas" | "totalVendido" | "ultimaVenda" | "dataNascimento" | "criadoEm";
export type Ordem = "asc" | "desc";

/** Quantidade de dígitos válida para um telefone brasileiro com DDD (fixo ou celular) — mesma regra de Clientes. */
export const TELEFONE_DIGITOS_VALIDOS = [10, 11];

export const SENHA_TAMANHO_MINIMO = 6;

/**
 * Parâmetros do Argon2id (via `Bun.password`) — mesmos valores de
 * `auth.constants.ts`, duplicados aqui de propósito: `Vendedor` NÃO é
 * `Usuario` (identidades de domínios de autorização completamente
 * separados — ver `role.type.ts`), então este módulo não importa nada do
 * módulo Auth além de replicar o mesmo padrão de hashing.
 */
export const ARGON2_MEMORY_COST = 19_456;
export const ARGON2_TIME_COST = 2;
