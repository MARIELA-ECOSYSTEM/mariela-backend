import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

export type TipoMovimentacaoEstoque = "entrada" | "saida";
/** Fase 22.3 — `cadastro`: saldo inicial informado ao cadastrar um tamanho (`POST /produtos/:id/variantes/:vid/tamanhos`). */
export const ORIGENS_MOVIMENTACAO_ESTOQUE = ["manual", "venda", "cancelamento", "cadastro"] as const;
export type OrigemMovimentacaoEstoque = (typeof ORIGENS_MOVIMENTACAO_ESTOQUE)[number];

/**
 * Collection própria (decisão de negócio já aprovada) — o estoque em si
 * continua vivendo no produto (`variantes[].tamanhos[].quantidade`); isto é
 * só o HISTÓRICO append-only de cada ajuste, para auditoria e conferência de
 * inventário. Nunca é a fonte de verdade da quantidade atual.
 */
@Schema({ collection: "movimentacoes_estoque", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class MovimentacaoEstoque {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  produtoId!: Types.ObjectId;

  @Prop({ type: String, required: true })
  varianteId!: string;

  @Prop({ type: String, required: true })
  tamanhoId!: string;

  @Prop({ type: String, required: true, enum: ["entrada", "saida"] })
  tipo!: TipoMovimentacaoEstoque;

  @Prop({ type: Number, required: true, min: 1 })
  quantidade!: number;

  @Prop({ type: Number, required: true, min: 0 })
  saldoResultante!: number;

  /** Obrigatório só para saída — a validação em si vive no DTO/service. */
  @Prop({ type: String, default: null })
  motivo!: string | null;

  /** `null` enquanto a autenticação não existir — nunca inventar identidade. */
  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  /**
   * Fase 60.4.3.4.15 (F04) — rastreabilidade do saldo: de onde veio a movimentação. `manual` = entrada/saída do
   * módulo Estoque (padrão — registros anteriores a esta fase não têm o campo e são lidos como manuais); `venda` e
   * `cancelamento` são gravados NA MESMA TRANSAÇÃO que altera o saldo do produto, então saldo e histórico nunca
   * divergem por falha parcial.
   */
  @Prop({ type: String, enum: ORIGENS_MOVIMENTACAO_ESTOQUE, default: "manual" })
  origem!: OrigemMovimentacaoEstoque;

  /** Venda que originou a movimentação (`origem` = `venda` ou `cancelamento`); `null` nas manuais. */
  @Prop({ type: String, default: null, index: true })
  vendaId!: string | null;

  /**
   * Fase 22.1 — chave de idempotência OPCIONAL das movimentações MANUAIS (`POST /estoque/entrada|saida`). Sem
   * `default`: movimentações sem chave (inclusive as de venda/cancelamento) continuam gravadas sem o campo, como antes.
   * Unicidade garantida pelo índice parcial abaixo — persiste entre reinicializações e entre instâncias.
   */
  @Prop({ type: String, required: false })
  idempotencyKey?: string;

  /**
   * Fase 22.1 — "assinatura" da operação manual que usou `idempotencyKey` (operação, produto, variante, tamanho,
   * quantidade e motivo, em JSON canônico). Uma repetição da chave só é aceita como replay se a assinatura for igual;
   * diferente → 409. Nunca contém dado sensível.
   */
  @Prop({ type: String, required: false })
  idempotencyAssinatura?: string;
}

export type MovimentacaoEstoqueDocument = HydratedDocument<MovimentacaoEstoque>;
export const MovimentacaoEstoqueSchema = SchemaFactory.createForClass(MovimentacaoEstoque);
aplicarSerializacaoPadrao(MovimentacaoEstoqueSchema);
// Fase 22.1 — mesmo padrão de `movimentos_caixa` (Etapa 10.13): único só entre os documentos que TÊM chave (string);
// os demais (sem o campo) ficam fora do índice. Nenhum documento existente tem o campo, então a criação é segura.
MovimentacaoEstoqueSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } }, name: "idempotencyKey_unico_parcial" },
);
