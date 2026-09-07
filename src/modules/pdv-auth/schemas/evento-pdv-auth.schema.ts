import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

export type TipoEventoPdvAuth = "pdv.login_sucesso" | "pdv.login_falha" | "pdv.logout" | "pdv.refresh" | "pdv.refresh_reusado";

/**
 * Auditoria mínima de autenticação do MARIELA PDV — coleção PRÓPRIA
 * (`eventos_pdv_auth`), mesmo padrão de `eventos_auth` (append-only). NUNCA
 * grava senha, hash, access token ou refresh token — só o necessário para
 * investigar um incidente (quem, quando, de onde, o quê).
 */
@Schema({ collection: "eventos_pdv_auth", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoPdvAuth {
  @Prop({ type: SchemaTypes.ObjectId, default: null, index: true })
  vendedorId!: Types.ObjectId | null;

  @Prop({ type: String, required: true, index: true })
  tipo!: TipoEventoPdvAuth;

  @Prop({ type: String, default: null })
  ip!: string | null;

  @Prop({ type: String, default: null })
  userAgent!: string | null;
}

export type EventoPdvAuthDocument = HydratedDocument<EventoPdvAuth>;
export const EventoPdvAuthSchema = SchemaFactory.createForClass(EventoPdvAuth);
aplicarSerializacaoPadrao(EventoPdvAuthSchema);
