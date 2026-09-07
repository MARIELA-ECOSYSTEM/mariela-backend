import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Contrato alinhado ao tipo `Fornecedor` já consumido pelo Backoffice
 * (`src/types/fornecedor.ts`) — nomes de campo em PT-BR preservados de
 * propósito. Fornecedor NÃO possui status ativo/inativo (decisão de negócio
 * já documentada no tipo do frontend).
 *
 * `produtosVinculados`/`valorEmCusto`/`ultimaEntrada` NÃO são campos deste
 * schema: são agregados calculados em tempo de leitura a partir da collection
 * `produtos` (ver `FornecedoresService`) — nunca persistidos aqui, para nunca
 * dessincronizar de Produtos.
 */
@Schema({
  collection: "fornecedores",
  versionKey: "__v",
  // Sem isto, Mongoose NUNCA lança VersionError em .save() concorrente (o
  // default e apenas incrementar __v, nao checa-lo) -- salvarComRetentativa
  // dependia disto para funcionar de verdade; sem ele, dois saves
  // concorrentes se sobrescreviam silenciosamente (ultimo escreve vence).
  optimisticConcurrency: true,
  timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" },
})
export class Fornecedor {
  @Prop({ type: String, required: true, unique: true })
  codigo!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  nome!: string;

  @Prop({ type: String, default: null })
  foto!: string | null;

  @Prop({ type: String, trim: true, maxlength: 120, default: "" })
  contato!: string;

  /** Como veio do formulário (ex.: "(83) 99999-9999") — opcional, ao contrário de Clientes. */
  @Prop({ type: String, trim: true, maxlength: 20, default: "" })
  telefone!: string;

  /**
   * Só dígitos — existe SOMENTE para checar duplicidade quando o telefone é
   * informado. Nunca serializada. Fornecedores sem telefone têm
   * `telefoneNormalizado: ""` e NÃO entram na checagem de unicidade (ver
   * índice parcial abaixo) — do contrário, um segundo fornecedor sem telefone
   * jamais poderia ser cadastrado.
   */
  @Prop({ type: String, default: "" })
  telefoneNormalizado!: string;

  @Prop({ type: String, trim: true, maxlength: 160, default: "" })
  email!: string;

  @Prop({ type: String, trim: true, maxlength: 20, default: "" })
  cnpj!: string;

  @Prop({ type: String, trim: true, maxlength: 60, default: "" })
  instagram!: string;

  @Prop({ type: String, trim: true, maxlength: 500, default: "" })
  observacao!: string;

  /** Endereço 100% opcional — `null` quando nenhum campo foi informado (nunca um objeto vazio). */
  @Prop({
    type: {
      cep: { type: String, default: "" },
      logradouro: { type: String, default: "" },
      numero: { type: String, default: "" },
      complemento: { type: String, default: "" },
      bairro: { type: String, default: "" },
      cidade: { type: String, default: "" },
      estado: { type: String, default: "" },
    },
    default: null,
    _id: false,
  })
  endereco!: {
    cep: string;
    logradouro: string;
    numero: string;
    complemento: string;
    bairro: string;
    cidade: string;
    estado: string;
  } | null;

  /** Soft delete — nunca serializado na resposta pública. `null` = ativo. */
  @Prop({ type: Date, default: null })
  excluidoEm!: Date | null;

  criadoEm!: Date;
  atualizadoEm!: Date;
}

export type FornecedorDocument = HydratedDocument<Fornecedor>;
export const FornecedorSchema = SchemaFactory.createForClass(Fornecedor);

aplicarSerializacaoPadrao(FornecedorSchema, ["excluidoEm", "telefoneNormalizado"]);

// Unicidade de `codigo` já vem do `unique: true` do `@Prop` acima (nunca reaproveitado, mesmo excluído).
// `telefoneNormalizado` usa índice PARCIAL: único somente entre fornecedores
// ATIVOS (`excluidoEm: null`) e com telefone realmente informado (`$gt: ""`)
// — do contrário, excluir um fornecedor bloquearia reaproveitar o telefone, e
// múltiplos fornecedores sem telefone colidiriam entre si.
FornecedorSchema.index(
  { telefoneNormalizado: 1 },
  { unique: true, partialFilterExpression: { excluidoEm: null, telefoneNormalizado: { $gt: "" } } },
);
// Soft delete: toda leitura filtra por ele; index acelera esse filtro sempre presente.
FornecedorSchema.index({ excluidoEm: 1 });
// Ordenação padrão / recência de cadastro (mesma decisão de Produtos/Clientes: `nome` não é indexado).
FornecedorSchema.index({ criadoEm: 1 });
