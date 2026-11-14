import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";

/**
 * Sessão de refresh token — o token opaco (aleatório) em si NUNCA é
 * persistido; só o hash SHA-256 dele (`tokenHash`). Um índice TTL em
 * `expiresAt` limpa tokens expirados automaticamente.
 *
 * `revogadoEm` não-nulo = token não pode mais ser usado (logout, rotação, ou
 * resposta a uma reutilização detectada). `substituidoPor` amarra a cadeia de
 * rotação (token novo gerado a partir deste) — só para rastreabilidade em
 * caso de investigação de comprometimento, não é usado em nenhuma validação.
 */
/** Fase 22.8.7.2 — sucessor selado (formato v1): binários em base64url sem padding. Subdocumento sem `_id`. */
@Schema({ _id: false, versionKey: false })
export class SucessorSelado {
  @Prop({ type: Number, required: true })
  v!: number;

  @Prop({ type: String, required: true })
  nonce!: string;

  @Prop({ type: String, required: true })
  ct!: string;

  @Prop({ type: String, required: true })
  tag!: string;
}
export const SucessorSeladoSchema = SchemaFactory.createForClass(SucessorSelado);

@Schema({ collection: "refresh_tokens", timestamps: { createdAt: "criadoEm", updatedAt: false } })
export class RefreshToken {
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  usuarioId!: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  tokenHash!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revogadoEm!: Date | null;

  @Prop({ type: Date, default: null })
  rotacionadoEm!: Date | null;

  @Prop({ type: String, default: null })
  substituidoPor!: string | null;

  /**
   * Fase 22.8.7.1 — FAMÍLIA DE SESSÃO: identificador aleatório (`randomUUID`, 122 bits) gerado pelo SERVIDOR a cada
   * login e herdado por todas as rotações daquela sessão. Nunca vem do cliente, nunca é derivado do usuário e não
   * contém dado pessoal. Escopo da revogação por reutilização suspeita e do logout (sempre junto com `usuarioId`).
   *
   * SEM `default` de propósito: documentos anteriores a esta fase NÃO têm o campo (ausente ≠ família) — continuam com
   * o comportamento legado (reuso revoga todas as sessões do usuário; logout revoga só o documento) até expirarem ou
   * serem rotacionados (o sucessor de um token legado inicia uma família nova; o legado em si nunca é alterado).
   */
  @Prop({ type: String })
  familiaId?: string;

  /**
   * Fase 22.8.7.2 — RECUPERAÇÃO IDEMPOTENTE (só em documentos com família, rotacionados com `Idempotency-Key` e com o
   * mecanismo ligado). Gravados na MESMA operação atômica que revoga este documento e aponta `substituidoPor`. Todos
   * opcionais e sem `default`: a ausência significa "sem recuperação". Formato e criptografia em
   * `recuperacao-refresh.crypto.ts`. Nenhum é indexado (nunca são critério de busca — só filtro do `_id`).
   */
  /** HMAC-SHA256 (hex) da `Idempotency-Key`, com segredo próprio (`REFRESH_IDEMPOTENCIA_HMAC_SECRET`). */
  @Prop({ type: String })
  chaveHash?: string;

  /** R2 cifrado (AES-256-GCM, chave HKDF de R1 + chave de idempotência). Removido quando deixa de ser recuperável. */
  @Prop({ type: SucessorSeladoSchema })
  sucessorSelado?: SucessorSelado;

  /** Fim da janela de recuperação (rotação + 15 min, relógio do servidor). */
  @Prop({ type: Date })
  recuperavelAte?: Date;

  /** Recuperações já concedidas (incremento atômico condicionado ao limite de 5). */
  @Prop({ type: Number })
  recuperacoes?: number;

  @Prop({ type: String, default: null })
  userAgent!: string | null;

  @Prop({ type: String, default: null })
  ip!: string | null;

  criadoEm!: Date;
}

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;
export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
aplicarSerializacaoPadrao(RefreshTokenSchema);

// TTL: o MongoDB apaga o documento sozinho quando `expiresAt` (timestamp
// absoluto) fica no passado — `expireAfterSeconds: 0` é o idioma correto para
// TTL sobre uma data absoluta (diferente de "N segundos após a criação").
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Fase 22.8.7.1 — revogação de uma família (`updateMany({ usuarioId, familiaId, revogadoEm: null })`, no reuso e no
// logout). PARCIAL: só documentos que TÊM família entram no índice — os legados (sem o campo) não ocupam espaço nem
// são alcançáveis por ele. Uma igualdade `familiaId: <string>` implica `$exists: true`, então o planner usa o índice.
RefreshTokenSchema.index(
  { familiaId: 1, revogadoEm: 1 },
  { partialFilterExpression: { familiaId: { $exists: true } } },
);
