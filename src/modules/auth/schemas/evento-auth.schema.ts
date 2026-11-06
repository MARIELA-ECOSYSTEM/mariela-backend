import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Fase 60.4.3.1.5 — `ADMIN_DEACTIVATED` (desativação administrativa, gravado UMA vez por usuário desativado) e
 * `ADMIN_SESSIONS_REVOKED` (revogação de sessões remanescentes de um usuário que já estava inativo), ambos só pelo
 * comando local `admin:desativar`.
 */
export type TipoEventoAuth = "LOGIN_SUCCESS" | "LOGIN_FAILED" | "LOGOUT" | "REFRESH" | "REFRESH_REUSED" | "ADMIN_DEACTIVATED" | "ADMIN_SESSIONS_REVOKED";

/**
 * Auditoria mínima de autenticação — mesmo padrão de `eventos_produto`
 * (append-only, sem sistema de consulta/retenção ainda). NUNCA grava senha,
 * hash, access token ou refresh token — só o necessário para investigar um
 * incidente (quem, quando, de onde, o quê).
 *
 * Os campos opcionais abaixo só existem nos eventos administrativos (Fase 60.4.3.1.5); os eventos de login,
 * refresh e logout continuam sem eles.
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

  /** Motivo informado pelo operador. */
  @Prop({ type: String })
  motivo?: string;

  /** Identificação de quem executou (texto informado pelo operador; ausente quando não informado). */
  @Prop({ type: String })
  executor?: string;

  /** Origem da operação (ex.: `comando:admin:desativar`). */
  @Prop({ type: String })
  origem?: string;

  /** Quantidade de sessões (refresh tokens) revogadas nesta execução. */
  @Prop({ type: Number })
  sessoesRevogadas?: number;

  /** Momento em que o usuário passou a inativo (`Usuario.desativadoEm`). */
  @Prop({ type: Date })
  desativadoEm?: Date;

  /** `true` quando o evento foi gravado numa execução POSTERIOR à que desativou o usuário (recuperação de falha). */
  @Prop({ type: Boolean })
  reconciliado?: boolean;
}

export type EventoAuthDocument = HydratedDocument<EventoAuth>;
export const EventoAuthSchema = SchemaFactory.createForClass(EventoAuth);
aplicarSerializacaoPadrao(EventoAuthSchema);
