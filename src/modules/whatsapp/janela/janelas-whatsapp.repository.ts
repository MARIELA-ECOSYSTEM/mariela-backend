import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { ehChaveDuplicada } from "../bloqueios/bloqueios-whatsapp.repository.js";
import { JanelaWhatsapp, type JanelaWhatsappDocument } from "../schemas/janela-whatsapp.schema.js";

export type ResultadoRegistroJanela = "criada" | "estendida" | "inalterada";

/**
 * Fase 22.8.9.10.7.4 — persistência de `whatsapp_janelas`. Registrar é UMA escrita atômica (`upsert` + `$max`):
 * repetir o mesmo evento não muda nada, um evento mais antigo não regride, e eventos simultâneos do mesmo contato
 * convergem para um único documento (índice único `contato_unico`).
 */
@Injectable()
export class JanelasWhatsappRepository {
  constructor(@InjectModel(JanelaWhatsapp.name) private readonly model: Model<JanelaWhatsappDocument>) {}

  async registrar(phoneNumberId: string, waId: string, mensagemEm: Date, agora: Date): Promise<ResultadoRegistroJanela> {
    // Duas inserções simultâneas do mesmo contato: a perdedora recebe chave duplicada e repete (agora como atualização).
    for (let tentativa = 0; ; tentativa++) {
      try {
        const r = await this.model
          .updateOne({ phoneNumberId, waId }, { $max: { ultimaMensagemEm: mensagemEm }, $setOnInsert: { criadoEm: agora } }, { upsert: true })
          .exec();
        if (r.upsertedCount === 1) return "criada";
        return r.modifiedCount === 1 ? "estendida" : "inalterada";
      } catch (erro) {
        if (!ehChaveDuplicada(erro) || tentativa >= 2) throw erro;
      }
    }
  }

  /** Mensagem mais recente entre os identificadores do contato (comparação EXATA, sem aproximação). */
  async ultimaMensagemEm(phoneNumberId: string, waIds: readonly string[]): Promise<Date | null> {
    if (waIds.length === 0) return null;
    const doc = await this.model
      .findOne({ phoneNumberId, waId: { $in: [...waIds] } })
      .sort({ ultimaMensagemEm: -1 })
      .exec();
    return doc?.ultimaMensagemEm ?? null;
  }
}
