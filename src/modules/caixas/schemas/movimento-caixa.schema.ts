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
 * nova movimentação (ver regra de negócio no relatório da Etapa 18.2).
 *
 * Etapa 18.2 — CAIXA GERAL DA LOJA: `responsavelId`/`responsavelNome` foram
 * REMOVIDOS do domínio (o Caixa não tem mais vínculo de vendedor). Quando o
 * Backoffice quiser saber QUEM vendeu (`tipo: "venda"`/`"cancelamento"`),
 * consulta a Venda via `vendaId` — o vendedor vem de lá, nunca de um
 * snapshot duplicado aqui (ver `CaixasService`, camada de consulta).
 *
 * `idempotencyKey` é opcional (só quem envia se beneficia da proteção) e
 * único GLOBALMENTE (não por caixa — Etapa 10.13) via índice parcial
 * esparso abaixo: uma repetição da mesma chave devolve o movimento já
 * existente em vez de duplicá-lo, mesmo que o caixa ATUALMENTE aberto seja
 * diferente do caixa onde o movimento original foi lançado (ver
 * `CaixasService.registrarMovimento`/`registrarMovimentoDeVenda`).
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

  /** Obrigatório para `venda`/`cancelamento`; sempre `null` para `injecao`/`sangria` — nunca validado quanto à existência aqui (a Venda já foi validada por quem chamou, ver `VendasService`). */
  @Prop({ type: String, default: null })
  vendaId!: string | null;

  @Prop({ type: String, default: null })
  vendaCodigo!: string | null;

  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  formaPagamento!: string;

  /** Sempre positivo; o sinal é determinado por `sentido`. */
  @Prop({ type: Number, required: true, min: 0 })
  valor!: number;

  /** Derivado deterministicamente de `tipo` (`SENTIDO_POR_TIPO`) — nunca escolhido pelo chamador. */
  @Prop({ type: String, required: true, enum: SENTIDOS_MOVIMENTACAO })
  sentido!: SentidoMovimentacao;

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
// Filtro por tipo dentro de um caixa.
MovimentoCaixaSchema.index({ caixaId: 1, tipo: 1 });
// Estatísticas do dia, somando todos os caixas.
MovimentoCaixaSchema.index({ dataHora: 1 });
// Deduplicação de retries: única GLOBALMENTE quando informada (esparsa — nem
// todo movimento manda idempotencyKey) — Etapa 10.13, nunca mais escopada
// por caixa (ver comentário da classe acima e `MovimentosCaixaRepository.onModuleInit`
// para a rotina de auto-cura que migra bancos com o índice antigo).
MovimentoCaixaSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
