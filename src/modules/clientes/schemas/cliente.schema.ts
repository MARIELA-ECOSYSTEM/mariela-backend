import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Contrato alinhado ao tipo `Cliente` já consumido pelo Backoffice
 * (`src/types/cliente.ts`) — nomes de campo em PT-BR preservados de propósito.
 * Não existem campos `email`/`cpf`/`endereco`/`status`: não fazem parte do
 * contrato hoje usado pelo frontend (auditado antes de implementar) e seriam
 * campos inventados sem consumidor.
 */
@Schema({
  collection: "clientes",
  versionKey: "__v",
  // Sem isto, Mongoose NUNCA lança VersionError em .save() concorrente (o
  // default e apenas incrementar __v, nao checa-lo) -- salvarComRetentativa
  // dependia disto para funcionar de verdade; sem ele, dois saves
  // concorrentes se sobrescreviam silenciosamente (ultimo escreve vence).
  optimisticConcurrency: true,
  timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" },
})
export class Cliente {
  @Prop({ type: String, required: true, unique: true })
  codigo!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  nome!: string;

  @Prop({ type: String, default: null })
  foto!: string | null;

  /** Como veio do formulário (ex.: "(83) 99999-9999") — é o valor exibido/reenviado ao frontend. */
  @Prop({ type: String, required: true, trim: true, maxlength: 20 })
  telefone!: string;

  /**
   * Só dígitos — existe SOMENTE para checar duplicidade (duas máscaras do
   * mesmo número não podem virar dois cadastros). Nunca serializada: a
   * representação pública do telefone é sempre `telefone`, tal como já
   * consumida pelo Backoffice hoje. A unicidade é um índice parcial (ver
   * abaixo), não `unique: true` aqui — um cliente excluído não pode bloquear
   * para sempre o reaproveitamento do próprio telefone por outro cadastro.
   */
  @Prop({ type: String, required: true })
  telefoneNormalizado!: string;

  @Prop({ type: Date, default: null })
  dataNascimento!: Date | null;

  @Prop({ type: String, trim: true, maxlength: 400, default: "" })
  observacao!: string;

  /**
   * Agregados de compras — SEMPRE calculados e escritos por `VendasService`
   * (`atualizarAgregadosNaCriacao`/`reverterAgregados`), nunca por Clientes.
   * Nascem zerados; existem aqui porque fazem parte do contrato consumido
   * pelo Backoffice (`Cliente.compras/totalComprado/ultimaCompra`).
   */
  @Prop({ type: Number, default: 0 })
  compras!: number;

  @Prop({ type: Number, default: 0 })
  totalComprado!: number;

  @Prop({ type: Date, default: null })
  ultimaCompra!: Date | null;

  /** Soft delete — nunca serializado na resposta pública. `null` = ativo. */
  @Prop({ type: Date, default: null })
  excluidoEm!: Date | null;

  criadoEm!: Date;
  atualizadoEm!: Date;
}

export type ClienteDocument = HydratedDocument<Cliente>;
export const ClienteSchema = SchemaFactory.createForClass(Cliente);

aplicarSerializacaoPadrao(ClienteSchema, ["excluidoEm", "telefoneNormalizado"]);

// Unicidade de `codigo` já vem do `unique: true` do `@Prop` acima (nunca reaproveitado, mesmo excluído).
// `telefoneNormalizado` usa índice PARCIAL: único somente entre clientes ATIVOS
// (`excluidoEm: null`) — do contrário, excluir um cliente bloquearia para
// sempre o reaproveitamento do telefone por um novo cadastro.
ClienteSchema.index({ telefoneNormalizado: 1 }, { unique: true, partialFilterExpression: { excluidoEm: null } });
// Soft delete: toda leitura filtra por ele; index acelera esse filtro sempre presente.
ClienteSchema.index({ excluidoEm: 1 });
// Ordenação padrão da listagem quando nada mais é pedido (mesma decisão de Produtos: `nome` não é indexado — volume de escrita baixo, ganho marginal).
ClienteSchema.index({ criadoEm: 1 });
