import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import { STATUS_CAIXA, type CaixaStatus } from "../caixas.constants.js";

export interface AberturaCaixaSub {
  dataHora: Date;
  responsavelId: string | null;
  responsavelNome: string;
  valorInicial: number;
  observacao: string;
}

export interface FechamentoCaixaSub {
  dataHora: Date;
  responsavelId: string | null;
  responsavelNome: string;
  valorInformado: number;
  valorEsperado: number;
  diferenca: number;
  observacao: string;
}

/**
 * Contrato alinhado ao tipo `Caixa` já consumido pelo Backoffice
 * (`src/types/caixa.ts`). `resumo` NÃO é um campo deste schema: é SEMPRE
 * calculado em tempo de leitura a partir de `movimentos_caixa` (ver
 * `CaixasService`/`caixas.lancamentos.ts` no frontend, que já documenta essa
 * mesma regra) — nunca persistido aqui, para nunca dessincronizar do
 * histórico real de movimentações.
 */
@Schema({
  collection: "caixas",
  versionKey: "__v",
  // Sem isto, Mongoose NUNCA lança VersionError em .save() concorrente (o
  // default e apenas incrementar __v, nao checa-lo) -- salvarComRetentativa
  // dependia disto para funcionar de verdade; sem ele, dois saves
  // concorrentes se sobrescreviam silenciosamente (ultimo escreve vence).
  optimisticConcurrency: true,
  timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" },
})
export class Caixa {
  @Prop({ type: String, required: true, unique: true })
  codigo!: string;

  @Prop({ type: String, required: true, enum: STATUS_CAIXA, default: "aberto" })
  status!: CaixaStatus;

  @Prop({
    type: {
      dataHora: { type: Date, required: true },
      responsavelId: { type: String, default: null },
      responsavelNome: { type: String, required: true },
      valorInicial: { type: Number, required: true },
      observacao: { type: String, default: "" },
    },
    required: true,
    _id: false,
  })
  abertura!: AberturaCaixaSub;

  @Prop({
    type: {
      dataHora: { type: Date, required: true },
      responsavelId: { type: String, default: null },
      responsavelNome: { type: String, required: true },
      valorInformado: { type: Number, required: true },
      valorEsperado: { type: Number, required: true },
      diferenca: { type: Number, required: true },
      observacao: { type: String, default: "" },
    },
    default: null,
    _id: false,
  })
  fechamento!: FechamentoCaixaSub | null;

  criadoEm!: Date;
  atualizadoEm!: Date;
}

export type CaixaDocument = HydratedDocument<Caixa>;
export const CaixaSchema = SchemaFactory.createForClass(Caixa);

aplicarSerializacaoPadrao(CaixaSchema);

// Garante "só um caixa aberto por vez" no BANCO, não só na aplicação: duas
// tentativas concorrentes de abrir caixa só permitem UM insert bem-sucedido —
// a segunda recebe erro de chave duplicada, traduzido pelo service em 409.
CaixaSchema.index({ status: 1 }, { unique: true, partialFilterExpression: { status: "aberto" } });
// Ordenação/filtro por período de abertura.
CaixaSchema.index({ "abertura.dataHora": 1 });
