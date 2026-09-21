import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Auditoria mínima do domínio Configurações — mesmo padrão de
 * `eventos_adquirente`/`eventos_colecao`/`eventos_campanha`/`eventos_fornecedor`:
 * registro append-only das mutações administrativas deste módulo.
 *
 * Única diferença deliberada em relação aos módulos irmãos: não existe um
 * campo `<entidade>Id` — `Configuracao` é um singleton de `_id` fixo (string
 * `"global"`, ver `ID_CONFIGURACAO_GLOBAL`), então não há qual entidade
 * distinguir. Nunca guarda o documento inteiro: `detalhes` só carrega o
 * contexto mínimo (nomes de campos alterados, ou a lista/valor afetado).
 */
@Schema({ collection: "eventos_configuracao", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoConfiguracao {
  /** Ex.: "configuracao.loja_atualizada", "configuracao.item_adicionado", "configuracao.item_removido". */
  @Prop({ type: String, required: true, index: true })
  tipo!: string;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  @Prop({ type: Object, default: {} })
  detalhes!: Record<string, unknown>;
}

export type EventoConfiguracaoDocument = HydratedDocument<EventoConfiguracao>;
export const EventoConfiguracaoSchema = SchemaFactory.createForClass(EventoConfiguracao);
aplicarSerializacaoPadrao(EventoConfiguracaoSchema);
