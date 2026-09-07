import type { AberturaCaixaSub, FechamentoCaixaSub } from "./schemas/caixa.schema.js";
import type {
  OrigemMovimentacao,
  SentidoMovimentacao,
  TipoMovimentacaoCaixa,
} from "./caixas.constants.js";

/** Formato de entrada do repository — deliberadamente não reusa a classe `@Schema`. */
export interface DadosCriarCaixa {
  codigo: string;
  status: "aberto";
  abertura: AberturaCaixaSub;
  fechamento: null;
}

export interface DadosCriarMovimento {
  caixaId: string;
  dataHora: Date;
  tipo: TipoMovimentacaoCaixa;
  origem: OrigemMovimentacao;
  descricao: string;
  referencia: string | null;
  vendaId: string | null;
  vendaCodigo: string | null;
  formaPagamento: string;
  valor: number;
  sentido: SentidoMovimentacao;
  responsavelId: string | null;
  responsavelNome: string;
  observacao: string;
  motivo: string | null;
  idempotencyKey: string | null;
}

export interface ResumoCaixaCalculado {
  valorAbertura: number;
  totalVendas: number;
  recebimentos: number;
  entradasManuais: number;
  totalEntradas: number;
  saidasManuais: number;
  devolucoes: number;
  totalSaidas: number;
  saldoEsperado: number;
  quantidadeVendas: number;
  quantidadeMovimentacoes: number;
}

export type { FechamentoCaixaSub };
