import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

export type TipoMovimentacaoEstoque = "entrada" | "saida";
export const ORIGENS_MOVIMENTACAO_ESTOQUE = ["manual", "venda", "cancelamento"] as const;
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
}

export type MovimentacaoEstoqueDocument = HydratedDocument<MovimentacaoEstoque>;
export const MovimentacaoEstoqueSchema = SchemaFactory.createForClass(MovimentacaoEstoque);
aplicarSerializacaoPadrao(MovimentacaoEstoqueSchema);
