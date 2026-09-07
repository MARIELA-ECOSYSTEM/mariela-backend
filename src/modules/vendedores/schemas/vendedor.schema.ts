import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Contrato alinhado ao tipo `Vendedor` já consumido pelo Backoffice
 * (`src/types/vendedor.ts`). IMPORTANTE: `Vendedor` NÃO é `Usuario` — é uma
 * identidade de domínio comercial do MARIELA PDV, cadastrada pelo ADMIN mas
 * sem qualquer papel de autorização no Backoffice (ver `role.type.ts`,
 * `usuario.schema.ts`). `senhaHash` existe para deixar essa identidade pronta
 * para o futuro login do PDV — não implementado nesta etapa; nenhuma rota
 * deste módulo emite token para um vendedor.
 */
@Schema({
  collection: "vendedores",
  versionKey: "__v",
  // Sem isto, Mongoose NUNCA lança VersionError em .save() concorrente (o
  // default e apenas incrementar __v, nao checa-lo) -- salvarComRetentativa
  // dependia disto para funcionar de verdade; sem ele, dois saves
  // concorrentes se sobrescreviam silenciosamente (ultimo escreve vence).
  optimisticConcurrency: true,
  timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" },
})
export class Vendedor {
  @Prop({ type: String, required: true, unique: true })
  codigo!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  nome!: string;

  @Prop({ type: String, default: null })
  foto!: string | null;

  /** Como veio do formulário (ex.: "(11) 99999-9999") — valor exibido/reenviado ao frontend. */
  @Prop({ type: String, required: true, trim: true, maxlength: 20 })
  telefone!: string;

  /** Só dígitos — existe SOMENTE para checar duplicidade. Nunca serializada (ver Cliente, mesmo padrão). */
  @Prop({ type: String, required: true })
  telefoneNormalizado!: string;

  @Prop({ type: Date, default: null })
  dataNascimento!: Date | null;

  @Prop({ type: String, trim: true, maxlength: 400, default: "" })
  observacao!: string;

  /** Nunca serializado na resposta pública (ver `aplicarSerializacaoPadrao`). */
  @Prop({ type: String, required: true })
  senhaHash!: string;

  @Prop({ type: Boolean, default: true })
  ativo!: boolean;

  /**
   * Agregados de vendas — SEMPRE calculados e escritos pelo futuro módulo de
   * Vendas (fora do escopo desta etapa), nunca por Vendedores. Nascem
   * zerados; só existem aqui porque já fazem parte do contrato consumido
   * pelo Backoffice (`Vendedor.vendas/totalVendido/ultimaVenda`) — mesmo
   * padrão de `Cliente.compras/totalComprado/ultimaCompra`.
   */
  @Prop({ type: Number, default: 0 })
  vendas!: number;

  @Prop({ type: Number, default: 0 })
  totalVendido!: number;

  @Prop({ type: Date, default: null })
  ultimaVenda!: Date | null;

  /**
   * Soft delete — nunca serializado na resposta pública. `null` = ativo.
   * Nunca removido fisicamente: uma venda futura pode continuar apontando
   * para este id mesmo depois de excluído/inativado (ver relatório, seção
   * "Regras de negócio").
   */
  @Prop({ type: Date, default: null })
  excluidoEm!: Date | null;

  criadoEm!: Date;
  atualizadoEm!: Date;
}

export type VendedorDocument = HydratedDocument<Vendedor>;
export const VendedorSchema = SchemaFactory.createForClass(Vendedor);

aplicarSerializacaoPadrao(VendedorSchema, ["excluidoEm", "telefoneNormalizado", "senhaHash"]);

// `telefoneNormalizado` usa índice PARCIAL: único somente entre vendedores
// ATIVOS (`excluidoEm: null`) — do contrário, excluir um vendedor bloquearia
// para sempre o reaproveitamento do telefone por um novo cadastro.
VendedorSchema.index({ telefoneNormalizado: 1 }, { unique: true, partialFilterExpression: { excluidoEm: null } });
// Soft delete: toda leitura filtra por ele; index acelera esse filtro sempre presente.
VendedorSchema.index({ excluidoEm: 1 });
// Ordenação padrão da listagem quando nada mais é pedido (mesma decisão de Clientes: `nome` não é indexado).
VendedorSchema.index({ criadoEm: 1 });
