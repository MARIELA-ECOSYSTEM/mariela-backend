import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { ClientSession, Model } from "mongoose";
import { Sequencia, type SequenciaDocument } from "./schemas/sequencia.schema.js";

@Injectable()
export class SequenciasRepository {
  constructor(@InjectModel(Sequencia.name) private readonly sequenciaModel: Model<SequenciaDocument>) {}

  /**
   * Incrementa e devolve o próximo valor da sequência identificada por `chave`,
   * de forma atômica: `findOneAndUpdate` + `$inc` + `upsert` é uma única
   * operação no MongoDB, então duas requisições concorrentes NUNCA recebem o
   * mesmo valor — ao contrário de `countDocuments() + 1`, que lê e escreve em
   * passos separados e pode colidir sob concorrência.
   */
  /**
   * Fase 60.4.3.4.15 (F04) — com `sessao`, o incremento faz parte da transação: se ela abortar, o valor não é
   * consumido (sem lacuna) e nenhuma venda usa um número que não foi confirmado.
   */
  async proximoValor(chave: string, sessao?: ClientSession): Promise<number> {
    const documento = await this.sequenciaModel
      .findOneAndUpdate(
        { _id: chave },
        { $inc: { valor: 1 } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, session: sessao ?? null },
      )
      .exec();
    return documento!.valor;
  }

  /** Fase 60.4.3.2.1 — valor atual da sequência, SEM incrementar (0 se ela ainda não existe). Somente leitura. */
  async valorAtual(chave: string): Promise<number> {
    const documento = await this.sequenciaModel.findById(chave).lean().exec();
    return documento?.valor ?? 0;
  }
}
