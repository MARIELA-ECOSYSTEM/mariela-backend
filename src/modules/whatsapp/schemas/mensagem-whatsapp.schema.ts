import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, type HydratedDocument, type Types } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import {
  CODIGOS_ERRO_ENVIO_WHATSAPP,
  ESTADOS_MENSAGEM_WHATSAPP,
  ORIGENS_MENSAGEM_WHATSAPP,
  TIPOS_CAMPANHA_WHATSAPP,
  TIPOS_DESTINATARIO_ENVIO_WHATSAPP,
  TIPOS_MENSAGEM_WHATSAPP,
  type CodigoErroEnvioWhatsapp,
  type EstadoMensagemWhatsapp,
  type OrigemMensagemWhatsapp,
  type TipoCampanhaWhatsapp,
  type TipoDestinatarioEnvioWhatsapp,
  type TipoMensagemWhatsapp,
} from "../envios/envios-whatsapp.constants.js";

function exigidoEmTemplate(this: { tipo?: TipoMensagemWhatsapp }): boolean {
  return (this.tipo ?? "TEMPLATE") === "TEMPLATE";
}

function exigidoEmTexto(this: { tipo?: TipoMensagemWhatsapp }): boolean {
  return this.tipo === "TEXTO";
}

/**
 * Fase 22.8.9.10.3 — registro de CADA mensagem de WhatsApp por template (`mensagens_whatsapp`). Gravado ANTES de
 * qualquer chamada ao provedor (reserva), e nunca apagado — inclusive depois de uma liberação de reenvio.
 *
 * Template: não guarda o texto renderizado nem os valores dos parâmetros (deriváveis do catálogo + cadastro). Texto
 * livre (Fase 22.8.9.10.7.4): guarda o texto enviado, que não é derivável de nada. `telefoneE164` é
 * o número usado NAQUELE envio (rastreabilidade se o cadastro mudar): fica só no banco — respostas o mascaram e logs
 * nunca o recebem. `waId` é o identificador devolvido pelo provedor e pode diferir do E.164.
 */
@Schema({ collection: "mensagens_whatsapp", versionKey: false })
export class MensagemWhatsapp {
  /** Chave de idempotência (UUID v4 gerado pelo Backoffice) — ÚNICA (índice abaixo). */
  @Prop({ type: String, required: true })
  idempotencyKey!: string;

  /** SHA-256 do conteúdo pedido (destinatário, template, campanha) — detecta a mesma chave com outro conteúdo. */
  @Prop({ type: String, required: true })
  hashConteudo!: string;

  @Prop({ type: String, required: true, enum: TIPOS_DESTINATARIO_ENVIO_WHATSAPP })
  destinatarioTipo!: TipoDestinatarioEnvioWhatsapp;

  @Prop({ type: SchemaTypes.ObjectId, required: true })
  destinatarioId!: Types.ObjectId;

  @Prop({ type: String, required: true })
  telefoneE164!: string;

  @Prop({ type: String, default: null })
  waId!: string | null;

  /** Fase 22.8.9.10.7.4 — registros anteriores não têm o campo e são lidos como `TEMPLATE`. */
  @Prop({ type: String, required: true, enum: TIPOS_MENSAGEM_WHATSAPP, default: "TEMPLATE" })
  tipo!: TipoMensagemWhatsapp;

  // Obrigatórios só para `TEMPLATE`; `null` em `TEXTO`.
  @Prop({ type: String, default: null, required: exigidoEmTemplate })
  templateChave!: string | null;

  @Prop({ type: String, default: null, required: exigidoEmTemplate })
  templateNomeMeta!: string | null;

  @Prop({ type: String, default: null, required: exigidoEmTemplate })
  templateIdioma!: string | null;

  @Prop({ type: String, default: null, required: exigidoEmTemplate })
  templateCategoria!: string | null;

  /**
   * Fase 22.8.9.10.7.4 — o texto livre EXATO pedido pelo operador (só em `TEXTO`; não é derivável de catálogo nem de
   * cadastro, por isso fica no registro para rastreabilidade). Nunca vai para log.
   */
  @Prop({ type: String, default: null, required: exigidoEmTexto })
  texto!: string | null;

  /** Id da mensagem no provedor (`wamid`) — único quando presente. */
  @Prop({ type: String, default: null })
  wamid!: string | null;

  @Prop({ type: String, required: true, enum: ESTADOS_MENSAGEM_WHATSAPP })
  estado!: EstadoMensagemWhatsapp;

  @Prop({ type: String, required: true, enum: ORIGENS_MENSAGEM_WHATSAPP })
  origem!: OrigemMensagemWhatsapp;

  // `null` não passa pelo validador de `enum` do Mongoose (só valores definidos são conferidos).
  @Prop({ type: String, default: null, enum: TIPOS_CAMPANHA_WHATSAPP })
  campanhaTipo!: TipoCampanhaWhatsapp | null;

  @Prop({ type: Number, default: null })
  campanhaAno!: number | null;

  /**
   * `ANIVERSARIO:<ano>:<clienteId>` — ÚNICA quando presente (índice parcial): reservada no MESMO insert da mensagem.
   * A liberação de reenvio a move para `chaveDeduplicacaoLiberada` (sem índice), preservando a evidência.
   */
  @Prop({ type: String, default: null })
  chaveDeduplicacao!: string | null;

  @Prop({ type: String, default: null })
  chaveDeduplicacaoLiberada!: string | null;

  @Prop({ type: String, default: null })
  usuarioId!: string | null;

  @Prop({ type: Date, required: true })
  criadoEm!: Date;

  @Prop({ type: Date, required: true })
  atualizadoEm!: Date;

  @Prop({ type: Date, default: null })
  enviandoEm!: Date | null;

  @Prop({ type: Date, default: null })
  aceitaEm!: Date | null;

  @Prop({ type: Date, default: null })
  entregueEm!: Date | null;

  @Prop({ type: Date, default: null })
  lidaEm!: Date | null;

  @Prop({ type: Date, default: null })
  falhaEm!: Date | null;

  @Prop({ type: String, default: null, enum: CODIGOS_ERRO_ENVIO_WHATSAPP })
  erroCodigo!: CodigoErroEnvioWhatsapp | null;

  /** Código bruto do provedor, só para diagnóstico (nunca contém credencial nem número). */
  @Prop({ type: String, default: null })
  erroCodigoProvedor!: string | null;

  @Prop({ type: Date, default: null })
  liberadaEm!: Date | null;

  @Prop({ type: String, default: null })
  liberadaPor!: string | null;

  @Prop({ type: String, default: null })
  motivoLiberacao!: string | null;

  /** Eventos que não podem mudar o estado (ex.: `failed` depois de `entregue`) — Fase 22.8.9.10.5. */
  @Prop({ type: [{ tipo: String, em: Date, codigoProvedor: String }], default: [] })
  anomalias!: { tipo: string; em: Date; codigoProvedor: string | null }[];
}

export type MensagemWhatsappDocument = HydratedDocument<MensagemWhatsapp>;
export const MensagemWhatsappSchema = SchemaFactory.createForClass(MensagemWhatsapp);

aplicarSerializacaoPadrao(MensagemWhatsappSchema);

// Uma chave de idempotência = uma mensagem, para sempre (sem expiração).
MensagemWhatsappSchema.index({ idempotencyKey: 1 }, { unique: true, name: "idempotencyKey_unica" });
// Uma campanha por cliente por ano. Parcial: só documentos com a chave preenchida (string) participam.
MensagemWhatsappSchema.index(
  { chaveDeduplicacao: 1 },
  { unique: true, name: "chaveDeduplicacao_unica", partialFilterExpression: { chaveDeduplicacao: { $type: "string" } } },
);
// Correlação com o provedor/webhook.
MensagemWhatsappSchema.index(
  { wamid: 1 },
  { unique: true, name: "wamid_unico", partialFilterExpression: { wamid: { $type: "string" } } },
);
// Histórico por cliente.
MensagemWhatsappSchema.index({ destinatarioId: 1, criadoEm: -1 });
// Varredura de reservas/envios abandonados.
MensagemWhatsappSchema.index({ estado: 1, criadoEm: 1 });
// `waId`s conhecidos de um número (verificação de bloqueio).
MensagemWhatsappSchema.index({ telefoneE164: 1 });
