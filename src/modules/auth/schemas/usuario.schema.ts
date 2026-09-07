import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import { ROLES, type Role } from "../../../common/types/role.type.js";

/**
 * Identidade de acesso ao Backoffice — NÃO confundir com `Vendedor` (domínio
 * comercial do PDV, entidade totalmente separada). Um vendedor nunca é um
 * `Usuario`, mesmo que futuramente ganhe autenticação própria no PDV.
 */
@Schema({ collection: "usuarios", timestamps: { createdAt: "criadoEm", updatedAt: "atualizadoEm" } })
export class Usuario {
  @Prop({ type: String, required: true, unique: true })
  codigo!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  nome!: string;

  /** Sempre normalizado (trim + minúsculas) ANTES de gravar — nunca confiar em já vir normalizado. */
  @Prop({ type: String, required: true, unique: true })
  email!: string;

  /** Nunca serializado na resposta pública (ver `aplicarSerializacaoPadrao`). */
  @Prop({ type: String, required: true })
  senhaHash!: string;

  @Prop({ type: String, required: true, enum: ROLES, default: "ADMIN" })
  role!: Role;

  @Prop({ type: Boolean, default: true })
  ativo!: boolean;

  @Prop({ type: Date, default: null })
  ultimoLoginEm!: Date | null;

  criadoEm!: Date;
  atualizadoEm!: Date;
}

export type UsuarioDocument = HydratedDocument<Usuario>;
export const UsuarioSchema = SchemaFactory.createForClass(Usuario);
aplicarSerializacaoPadrao(UsuarioSchema, ["senhaHash"]);
