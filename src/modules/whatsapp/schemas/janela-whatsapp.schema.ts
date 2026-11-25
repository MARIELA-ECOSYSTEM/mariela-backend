import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { aplicarSerializacaoPadrao } from "../../../database/mongoose-json.util.js";
import { RETENCAO_JANELA_SEGUNDOS } from "../envios/envios-whatsapp.constants.js";

/**
 * Fase 22.8.9.10.7.4 — janela de atendimento de 24 h (`whatsapp_janelas`): o instante da ÚLTIMA mensagem válida
 * recebida de um contato, por número empresarial (`phoneNumberId`) e identificador do WhatsApp (`waId`, só dígitos,
 * exatamente como a Meta enviou).
 *
 * - Só o webhook AUTENTICADO escreve aqui (mensagem recebida do contato). Envios da loja nunca abrem janela.
 * - `ultimaMensagemEm` só avança (`$max`): reentrega e evento fora de ordem nunca estendem nem encurtam a janela.
 * - Nenhum conteúdo de mensagem, nome ou telefone do cadastro é guardado.
 * - Dado de vida curta: fica FORA do backup (política aprovada na Fase 22.8.9.10.7.4) e expira pelo índice TTL. Depois
 *   de um restore, a janela de cada contato fica fechada até ele escrever de novo (falha segura).
 */
@Schema({ collection: "whatsapp_janelas", versionKey: false })
export class JanelaWhatsapp {
  @Prop({ type: String, required: true })
  phoneNumberId!: string;

  @Prop({ type: String, required: true })
  waId!: string;

  /** `min(timestamp informado pela Meta, momento em que o backend recebeu)` — nunca no futuro. */
  @Prop({ type: Date, required: true })
  ultimaMensagemEm!: Date;

  @Prop({ type: Date, required: true })
  criadoEm!: Date;
}

export type JanelaWhatsappDocument = HydratedDocument<JanelaWhatsapp>;
export const JanelaWhatsappSchema = SchemaFactory.createForClass(JanelaWhatsapp);

aplicarSerializacaoPadrao(JanelaWhatsappSchema);

// Um registro por contato e número empresarial (eventos simultâneos convergem para o mesmo documento).
JanelaWhatsappSchema.index({ phoneNumberId: 1, waId: 1 }, { unique: true, name: "contato_unico" });
// Limpeza automática de contatos sem mensagem recente.
JanelaWhatsappSchema.index({ ultimaMensagemEm: 1 }, { name: "expiracao", expireAfterSeconds: RETENCAO_JANELA_SEGUNDOS });
