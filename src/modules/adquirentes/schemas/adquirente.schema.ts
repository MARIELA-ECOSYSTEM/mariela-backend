import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument, Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import { MODALIDADES_TARIFA, type ModalidadeTarifa } from "../adquirentes.constants.js";

/**
 * Entrada da tabela de tarifas de um Adquirente — embutida (não é uma
 * collection própria: só faz sentido junto do "pai", mesmo padrão já usado
 * por `Variante`/`Tamanho` dentro de `Produto`). A aplicação efetiva dessas
 * tarifas em uma venda é responsabilidade de uma etapa futura — este schema
 * só armazena a configuração.
 */
@Schema({ _id: true })
export class TarifaConfig {
  @Prop({ type: String, required: true, enum: MODALIDADES_TARIFA })
  modalidade!: ModalidadeTarifa;

  @Prop({ type: Number, required: true, min: 1 })
  parcelas!: number;

  @Prop({ type: Number, required: true, min: 0 })
  percentual!: number;
}
export const TarifaConfigSchema = SchemaFactory.createForClass(TarifaConfig);
aplicarSerializacaoPadrao(TarifaConfigSchema);

/**
 * Configuração administrativa de uma adquirente de cartão (Stone, Cielo,
 * Rede, ...) — a loja cadastra as suas próprias, não há lista fixa. Nesta
 * etapa é usada apenas pelo CRUD administrativo; `VendasService` ainda não
 * consulta este módulo (integração prevista para etapa futura).
 */
@Schema({
  collection: "adquirentes",
  versionKey: "__v",
  // Sem isto, Mongoose NUNCA lança VersionError em .save() concorrente (o
  // default e apenas incrementar __v, nao checa-lo) -- salvarComRetentativa
  // dependia disto para funcionar de verdade; sem ele, dois saves
  // concorrentes se sobrescreviam silenciosamente (ultimo escreve vence).
  optimisticConcurrency: true,
  timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" },
})
export class Adquirente {
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  nome!: string;

  /**
   * `nome.trim().toLowerCase()` — existe SOMENTE para a checagem de
   * unicidade case-insensitive (índice único abaixo). Nunca serializada
   * (mesmo padrão de `telefoneNormalizado` em Fornecedores).
   */
  @Prop({ type: String, required: true })
  nomeNormalizado!: string;

  @Prop({ type: Boolean, default: true })
  ativo!: boolean;

  @Prop({ type: String, trim: true, maxlength: 400, default: null })
  observacao!: string | null;

  @Prop({ type: [TarifaConfigSchema], default: [] })
  tabelaTarifas!: Types.DocumentArray<TarifaConfig>;

  /** Soft delete. `null` = ativa. Deliberadamente serializada (ver contrato do módulo) — o Backoffice precisa distinguir uma adquirente excluída ao consultar por id. */
  @Prop({ type: Date, default: null })
  excluidoEm!: Date | null;

  criadoEm!: Date;
  atualizadoEm!: Date;
}

export type AdquirenteDocument = HydratedDocument<Adquirente>;
export const AdquirenteSchema = SchemaFactory.createForClass(Adquirente);

aplicarSerializacaoPadrao(AdquirenteSchema, ["nomeNormalizado"]);

// Unicidade case-insensitive de nome, escopada às adquirentes ATIVAS — mesma
// técnica de `telefoneNormalizado` em Fornecedores: um nome pode ser
// reaproveitado depois que a adquirente anterior foi excluída (soft delete).
AdquirenteSchema.index({ nomeNormalizado: 1 }, { unique: true, partialFilterExpression: { excluidoEm: null } });
// Soft delete: toda leitura filtra por ele; index acelera esse filtro sempre presente.
AdquirenteSchema.index({ excluidoEm: 1 });
