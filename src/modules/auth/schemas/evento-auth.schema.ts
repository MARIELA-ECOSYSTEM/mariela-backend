import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

export type TipoEventoAuth = "LOGIN_SUCCESS" | "LOGIN_FAILED" | "LOGOUT" | "REFRESH" | "REFRESH_REUSED";

/**
 * Auditoria mínima de autenticação — mesmo padrão de `eventos_produto`
 * (append-only, sem sistema de consulta/retenção ainda). NUNCA grava senha,
 * hash, access token ou refresh token — só o necessário para investigar um
 * incidente (quem, quando, de onde, o quê).
 */
@Schema({ collection: "eventos_auth", versionKey: false, timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class EventoAuth {
  @Prop({ type: SchemaTypes.ObjectId, default: null, index: true })
  usuarioId!: Types.ObjectId | null;

  @Prop({ type: String, required: true, index: true })
  tipo!: TipoEventoAuth;

  @Prop({ type: String, default: null })
  ip!: string | null;

  @Prop({ type: String, default: null })
  userAgent!: string | null;
}

export type EventoAuthDocument = HydratedDocument<EventoAuth>;
export const EventoAuthSchema = SchemaFactory.createForClass(EventoAuth);
aplicarSerializacaoPadrao(EventoAuthSchema);
