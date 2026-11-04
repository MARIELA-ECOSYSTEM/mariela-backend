import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { UploadMidia, type UploadMidiaDocument } from "./schemas/upload-midia.schema.js";

export type DadosCriarUploadMidia = Omit<UploadMidia, "estado" | "confirmadoEm" | "removidoEm">;

/**
 * Fase 60.1 — transições de estado de `uploads_midia`. Cada transição é UMA escrita condicional pelo estado de
 * origem (`updateOne` com filtro), então duas operações concorrentes nunca "desfazem" uma à outra: por exemplo,
 * um registro já `removido` nunca volta a `confirmado`. Todas devolvem se a transição aconteceu.
 */
@Injectable()
export class UploadsMidiaRepository {
  constructor(@InjectModel(UploadMidia.name) private readonly uploadModel: Model<UploadMidiaDocument>) {}

  async criar(dados: DadosCriarUploadMidia): Promise<UploadMidiaDocument> {
    return this.uploadModel.create({ ...dados, estado: "pendente", confirmadoEm: null, removidoEm: null });
  }

  async encontrarPorId(uploadId: string): Promise<UploadMidiaDocument | null> {
    return this.uploadModel.findById(uploadId).exec();
  }

  /** `pendente` → `confirmado`. Só é chamado depois de o produto comprovadamente referenciar a mídia. */
  async marcarConfirmado(uploadId: string, em: Date): Promise<boolean> {
    const resultado = await this.uploadModel.updateOne({ _id: uploadId, estado: "pendente" }, { $set: { estado: "confirmado", confirmadoEm: em } }).exec();
    return resultado.modifiedCount === 1;
  }

  /** `pendente`/`confirmado` → `removido`: a mídia saiu (ou nunca chegou a ficar) na galeria. Sem registro (mídia legada), não faz nada. */
  async marcarRemovido(uploadId: string, em: Date): Promise<boolean> {
    const resultado = await this.uploadModel
      .updateOne({ _id: uploadId, estado: { $in: ["pendente", "confirmado"] } }, { $set: { estado: "removido", removidoEm: em } })
      .exec();
    return resultado.modifiedCount === 1;
  }

  /**
   * `confirmado` → `removido`, restrito a um produto. Usado só para RECONCILIAR quando o produto já não referencia a
   * mídia: um registro `confirmado` que o produto não referencia mais só pode ter saído da galeria. Nunca toca um
   * `pendente` (que é um upload ainda não confirmado, legitimamente fora da galeria).
   */
  async marcarRemovidoSeConfirmado(uploadId: string, produtoId: string, em: Date): Promise<boolean> {
    const resultado = await this.uploadModel
      .updateOne({ _id: uploadId, produtoId, estado: "confirmado" }, { $set: { estado: "removido", removidoEm: em } })
      .exec();
    return resultado.modifiedCount === 1;
  }

  /** `pendente` → `descartado`: a assinatura falhou e a URL nunca chegou ao cliente. */
  async marcarDescartado(uploadId: string): Promise<boolean> {
    const resultado = await this.uploadModel.updateOne({ _id: uploadId, estado: "pendente" }, { $set: { estado: "descartado" } }).exec();
    return resultado.modifiedCount === 1;
  }
}
