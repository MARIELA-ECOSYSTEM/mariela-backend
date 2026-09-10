import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import { STATUS_CAIXA, type CaixaStatus } from "../caixas.constants.js";

/**
 * Etapa 18.2 — CAIXA GERAL DA LOJA: modelo simplificado, sem nenhum vínculo
 * de vendedor/responsável (removidos `abertura.responsavelId`/
 * `responsavelNome`, `fechamento.responsavelId`/`responsavelNome` do
 * domínio persistido — ver `CaixasService.paraRespostaPublica` para como a
 * resposta pública reconstrói o formato aninhado `abertura`/`fechamento`
 * ainda esperado pelo Backoffice, preservando compatibilidade de contrato
 * sem reintroduzir o conceito no domínio). Existe NO MÁXIMO um Caixa aberto
 * em toda a loja — nunca por vendedor, nunca por usuário, nunca por PDV.
 *
 * `resumo`/saldo continuam NUNCA persistidos aqui: sempre calculados em
 * tempo de leitura a partir de `movimentos_caixa` (ver `CaixasService`).
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

  @Prop({ type: Number, required: true })
  valorInicial!: number;

  @Prop({ type: Date, required: true })
  dataAbertura!: Date;

  @Prop({ type: String, trim: true, maxlength: 400, default: "" })
  observacaoAbertura!: string;

  @Prop({ type: Date, default: null })
  dataFechamento!: Date | null;

  /** Valor contado fisicamente na gaveta no fechamento — `null` enquanto aberto. */
  @Prop({ type: Number, default: null })
  valorInformado!: number | null;

  /** Sempre recalculado pelo backend a partir de `movimentos_caixa` no momento do fechamento — nunca aceito do cliente. */
  @Prop({ type: Number, default: null })
  valorEsperado!: number | null;

  /** `valorInformado - valorEsperado`: pode ser negativo (falta) ou positivo (sobra). */
  @Prop({ type: Number, default: null })
  diferenca!: number | null;

  @Prop({ type: String, trim: true, maxlength: 400, default: "" })
  observacaoFechamento!: string;

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
CaixaSchema.index({ dataAbertura: 1 });
