import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import {
  ORIGENS_MOVIMENTACAO,
  SENTIDOS_MOVIMENTACAO,
  TIPOS_MOVIMENTACAO,
  type OrigemMovimentacao,
  type SentidoMovimentacao,
  type TipoMovimentacaoCaixa,
} from "../caixas.constants.js";

/**
 * Contrato alinhado a `MovimentacaoCaixa` (`src/types/caixa.ts`) — registro
 * IMUTÁVEL: não existe endpoint de edição/exclusão. Correções nascem de uma
 * nova movimentação (ver regra de negócio no relatório).
 *
 * `idempotencyKey` é opcional (só quem envia se beneficia da proteção) e
 * único GLOBALMENTE (não mais por caixa — Etapa 10.13) via índice parcial
 * esparso abaixo: uma repetição da mesma chave devolve o movimento já
 * existente em vez de duplicá-lo, mesmo que o caixa ATUALMENTE aberto seja
 * diferente do caixa onde o movimento original foi lançado (ver
 * `CaixasService.registrarMovimento`/`registrarMovimentoDeVenda`).
 *
 * ANTES desta etapa o índice era `{caixaId, idempotencyKey}`: como
 * `receberPagamento`/`baixarParcela`/`cancelar` (Etapas 10.10-10.13) resolvem
 * o caixa de lançamento DINAMICAMENTE (`caixasService.obterAtual()`), um
 * retry chegando depois de o caixa original fechar e outro abrir recalculava
 * um `caixaId` diferente — a chave antiga não colidia com o índice antigo
 * (caixaId mudou) e um SEGUNDO movimento era criado, duplicando o valor nos
 * relatórios do caixa novo. A identidade da operação financeira nunca pode
 * depender de qual caixa está aberto no momento do retry; só o VALOR
 * lançado (`caixaId` no documento) continua refletindo isso. As chaves
 * derivadas em `VendasService` (`${vendaId}:pagamento:N`,
 * `${vendaId}:recebimento:X`, `${vendaId}:parcela:X`,
 * `${vendaId}:cancelamento:X`) já incorporam o id da venda especificamente
 * para sustentar essa unicidade global sem colidir entre vendas diferentes.
 */
@Schema({ collection: "movimentos_caixa", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class MovimentoCaixa {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  caixaId!: Types.ObjectId;

  @Prop({ type: Date, required: true })
  dataHora!: Date;

  @Prop({ type: String, required: true, enum: TIPOS_MOVIMENTACAO })
  tipo!: TipoMovimentacaoCaixa;

  @Prop({ type: String, required: true, enum: ORIGENS_MOVIMENTACAO })
  origem!: OrigemMovimentacao;

  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  descricao!: string;

  @Prop({ type: String, default: null })
  referencia!: string | null;

  /** Referência livre a uma venda futura — sem validação de existência (Vendas ainda não existe). */
  @Prop({ type: String, default: null })
  vendaId!: string | null;

  @Prop({ type: String, default: null })
  vendaCodigo!: string | null;

  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  formaPagamento!: string;

  /** Sempre positivo; o sinal é determinado por `sentido`. */
  @Prop({ type: Number, required: true, min: 0 })
  valor!: number;

  @Prop({ type: String, required: true, enum: SENTIDOS_MOVIMENTACAO })
  sentido!: SentidoMovimentacao;

  /** Referência livre a um Vendedor — snapshot em `responsavelNome`, nunca usado como autoridade. */
  @Prop({ type: String, default: null })
  responsavelId!: string | null;

  @Prop({ type: String, required: true })
  responsavelNome!: string;

  @Prop({ type: String, trim: true, maxlength: 400, default: "" })
  observacao!: string;

  @Prop({ type: String, default: null })
  motivo!: string | null;

  @Prop({ type: String, default: null })
  idempotencyKey!: string | null;

  criadoEm!: Date;
}

export type MovimentoCaixaDocument = HydratedDocument<MovimentoCaixa>;
export const MovimentoCaixaSchema = SchemaFactory.createForClass(MovimentoCaixa);
aplicarSerializacaoPadrao(MovimentoCaixaSchema);

// Histórico paginado de um caixa, mais recente primeiro.
MovimentoCaixaSchema.index({ caixaId: 1, dataHora: -1 });
// Filtro por tipo dentro de um caixa (ex.: só "venda" para calcular resumo).
MovimentoCaixaSchema.index({ caixaId: 1, tipo: 1 });
// Estatísticas do dia, somando todos os caixas.
MovimentoCaixaSchema.index({ dataHora: 1 });
// Deduplicação de retries: única GLOBALMENTE quando informada (esparsa — nem
// todo movimento manda idempotencyKey) — Etapa 10.13, nunca mais escopada
// por caixa (ver comentário da classe acima).
MovimentoCaixaSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
