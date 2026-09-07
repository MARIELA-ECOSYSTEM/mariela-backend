import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
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
  async proximoValor(chave: string): Promise<number> {
    const documento = await this.sequenciaModel
      .findOneAndUpdate(
        { _id: chave },
        { $inc: { valor: 1 } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      )
      .exec();
    return documento!.valor;
  }
}
