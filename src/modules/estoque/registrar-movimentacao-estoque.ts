import type { ClientSession, Model } from "mongoose";
import type {
  MovimentacaoEstoqueDocument,
  OrigemMovimentacaoEstoque,
  TipoMovimentacaoEstoque,
} from "./schemas/movimentacao-estoque.schema.js";

/**
 * Fase 22.3 — linha do ledger `movimentacoes_estoque` já resolvida (o saldo foi ajustado antes, por
 * `ProdutosService.ajustarQuantidadeTamanho`, na MESMA sessão). `idempotencyKey`/`idempotencyAssinatura` só são gravadas
 * quando informadas — sem elas o documento fica idêntico ao de antes da Fase 22.1.
 */
export interface LinhaDoLedger {
  produtoId: string;
  varianteId: string;
  tamanhoId: string;
  tipo: TipoMovimentacaoEstoque;
  quantidade: number;
  saldoResultante: number;
  motivo: string | null;
  usuarioId: string | null;
  origem: OrigemMovimentacaoEstoque;
  vendaId?: string | null;
  idempotencyKey?: string;
  idempotencyAssinatura?: string;
}

/**
 * Fase 22.3 — ÚNICO ponto de montagem/gravação de uma linha do ledger para a porta de estoque (`EstoqueService.movimentar`)
 * e para o cadastro de tamanho (`ProdutosService.adicionarTamanho`). A sessão é obrigatória: a linha só existe se a
 * transação de quem chama for confirmada. Uma função (não um provider) para não criar dependência entre módulos —
 * quem usa só precisa do model registrado no próprio `forFeature`.
 */
export async function registrarMovimentacaoEstoque(
  model: Model<MovimentacaoEstoqueDocument>,
  linha: LinhaDoLedger,
  sessao: ClientSession,
): Promise<MovimentacaoEstoqueDocument> {
  const [movimentacao] = await model.create(
    [
      {
        produtoId: linha.produtoId,
        varianteId: linha.varianteId,
        tamanhoId: linha.tamanhoId,
        tipo: linha.tipo,
        quantidade: linha.quantidade,
        saldoResultante: linha.saldoResultante,
        motivo: linha.motivo,
        usuarioId: linha.usuarioId,
        origem: linha.origem,
        vendaId: linha.vendaId ?? null,
        ...(linha.idempotencyKey ? { idempotencyKey: linha.idempotencyKey, idempotencyAssinatura: linha.idempotencyAssinatura } : {}),
      },
    ],
    { session: sessao },
  );
  return movimentacao!;
}
