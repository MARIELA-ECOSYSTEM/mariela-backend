import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { isValidObjectId, type Model, type Types } from "mongoose";
import { BloqueioWhatsapp, type BloqueioWhatsappDocument } from "../schemas/bloqueio-whatsapp.schema.js";
import type { OrigemBloqueioWhatsapp, TipoChaveBloqueioWhatsapp } from "../envios/envios-whatsapp.constants.js";

export interface DadosBloqueioWhatsapp {
  chave: string;
  tipoChave: TipoChaveBloqueioWhatsapp;
  clienteId: Types.ObjectId | null;
  origem: OrigemBloqueioWhatsapp;
  motivo: string | null;
  usuarioId: string | null;
}

/** Erro de chave duplicada do MongoDB (índice único violado). */
export function ehChaveDuplicada(erro: unknown): erro is { code: 11000; keyPattern?: Record<string, unknown> } {
  return typeof erro === "object" && erro !== null && (erro as { code?: unknown }).code === 11000;
}

/**
 * Fase 22.8.9.10.3 — persistência de `whatsapp_bloqueios`. Bloquear é idempotente (índice único parcial de bloqueio
 * ATIVO por chave: duas requisições simultâneas resultam em um só bloqueio). Desbloquear é condicional e não apaga.
 */
@Injectable()
export class BloqueiosWhatsappRepository {
  constructor(@InjectModel(BloqueioWhatsapp.name) private readonly model: Model<BloqueioWhatsappDocument>) {}

  /** Cria o bloqueio ativo, ou devolve o já existente para a mesma chave (`criado: false`). */
  async bloquear(dados: DadosBloqueioWhatsapp, agora: Date): Promise<{ bloqueio: BloqueioWhatsappDocument; criado: boolean }> {
    try {
      const bloqueio = await this.model.create({ ...dados, ativo: true, criadoEm: agora });
      return { bloqueio, criado: true };
    } catch (erro) {
      if (!ehChaveDuplicada(erro)) throw erro;
      const existente = await this.model.findOne({ chave: dados.chave, ativo: true }).exec();
      if (!existente) throw erro; // desbloqueado entre o insert e a leitura: não mascarar a corrida
      return { bloqueio: existente, criado: false };
    }
  }

  async encontrarAtivosPorChaves(chaves: readonly string[]): Promise<BloqueioWhatsappDocument[]> {
    if (chaves.length === 0) return [];
    return this.model.find({ chave: { $in: [...chaves] }, ativo: true }).sort({ criadoEm: 1 }).exec();
  }

  async encontrarPorId(id: string): Promise<BloqueioWhatsappDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.model.findById(id).exec();
  }

  /** Ativo → inativo, com registro de quem/por quê. Nunca apaga o documento. */
  async desbloquear(id: Types.ObjectId, usuarioId: string | null, motivo: string, agora: Date): Promise<boolean> {
    const r = await this.model
      .updateOne(
        { _id: id, ativo: true },
        { $set: { ativo: false, desbloqueadoEm: agora, desbloqueadoPor: usuarioId, motivoDesbloqueio: motivo } },
      )
      .exec();
    return r.modifiedCount === 1;
  }

  async listar(somenteAtivos: boolean, page: number, limit: number): Promise<{ itens: BloqueioWhatsappDocument[]; total: number }> {
    const filtro = somenteAtivos ? { ativo: true } : {};
    const [itens, total] = await Promise.all([
      this.model
        .find(filtro)
        .sort({ criadoEm: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.model.countDocuments(filtro).exec(),
    ]);
    return { itens, total };
  }
}
