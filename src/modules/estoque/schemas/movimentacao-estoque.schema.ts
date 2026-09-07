import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

export type TipoMovimentacaoEstoque = "entrada" | "saida";

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
}

export type MovimentacaoEstoqueDocument = HydratedDocument<MovimentacaoEstoque>;
export const MovimentacaoEstoqueSchema = SchemaFactory.createForClass(MovimentacaoEstoque);
aplicarSerializacaoPadrao(MovimentacaoEstoqueSchema);
