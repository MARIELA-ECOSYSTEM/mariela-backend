import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { UploadMidia, type UploadMidiaDocument } from "./schemas/upload-midia.schema.js";

export type DadosCriarUploadMidia = Omit<UploadMidia, "estado" | "confirmadoEm" | "removidoEm" | "tokenReserva" | "reservadoEm" | "limpezaIniciadaEm">;

/**
 * Fase 60.1 — transições de estado de `uploads_midia`. Cada transição é UMA escrita condicional pelo estado de
 * origem (`updateOne` com filtro), então duas operações concorrentes nunca "desfazem" uma à outra: por exemplo,
 * um registro já `removido` nunca volta a `confirmado`. Todas devolvem se a transição aconteceu.
 *
 * Fase 60.3.1 — reserva de confirmação (`confirmando`), mutuamente exclusiva com a reserva da limpeza
 * (`limpando`, adquirida pelo comando `limpar-uploads-abandonados`): as duas só nascem de `pendente`, por escrita
 * condicional atômica no MESMO documento — no máximo uma vence. A confirmação só grava o produto depois de vencer.
 */
@Injectable()
export class UploadsMidiaRepository {
  constructor(@InjectModel(UploadMidia.name) private readonly uploadModel: Model<UploadMidiaDocument>) {}

  async criar(dados: DadosCriarUploadMidia): Promise<UploadMidiaDocument> {
    return this.uploadModel.create({ ...dados, estado: "pendente", confirmadoEm: null, removidoEm: null, tokenReserva: null, reservadoEm: null, limpezaIniciadaEm: null });
  }

  async encontrarPorId(uploadId: string): Promise<UploadMidiaDocument | null> {
    return this.uploadModel.findById(uploadId).exec();
  }

  /**
   * Reserva para confirmação: `pendente` NUNCA tocado pela limpeza (`limpezaIniciadaEm` ausente) e ainda dentro do
   * prazo (`limpezaApos` no futuro), tudo conferido no MESMO comando atômico → `confirmando`; ou reentrada em
   * `confirmando` (retomada de uma confirmação interrompida ou repetida — a limpeza nunca toca `confirmando`, e um
   * registro só chega a `confirmando` por este mesmo filtro). Falha (`false`) se a limpeza já assumiu o registro
   * alguma vez, se ele venceu ou se já saiu do ciclo (confirmado, removido, descartado).
   */
  async reservarParaConfirmacao(uploadId: string, token: string, agora: Date): Promise<boolean> {
    const resultado = await this.uploadModel
      .updateOne(
        { _id: uploadId, $or: [{ estado: "pendente", limpezaIniciadaEm: null, limpezaApos: { $gt: agora } }, { estado: "confirmando" }] },
        { $set: { estado: "confirmando", tokenReserva: token, reservadoEm: agora } },
      )
      .exec();
    return resultado.modifiedCount === 1;
  }

  /**
   * `confirmando` → `pendente`, SÓ pelo dono da reserva (token) e só quando a escrita do produto foi recusada com
   * certeza (erro de domínio antes de gravar). Outra confirmação que reentrou (token diferente) não é afetada.
   */
  async liberarReservaDeConfirmacao(uploadId: string, token: string): Promise<boolean> {
    const resultado = await this.uploadModel
      .updateOne({ _id: uploadId, estado: "confirmando", tokenReserva: token }, { $set: { estado: "pendente", tokenReserva: null, reservadoEm: null } })
      .exec();
    return resultado.modifiedCount === 1;
  }

  /**
   * `pendente`/`confirmando` → `confirmado`. Só é chamado depois de o produto comprovadamente referenciar a mídia.
   * Nunca a partir de `limpando` (a limpeza decide sozinha, depois de rever as referências).
   */
  async marcarConfirmado(uploadId: string, em: Date): Promise<boolean> {
    const resultado = await this.uploadModel
      .updateOne(
        { _id: uploadId, estado: { $in: ["pendente", "confirmando"] } },
        { $set: { estado: "confirmado", confirmadoEm: em, tokenReserva: null, reservadoEm: null } },
      )
      .exec();
    return resultado.modifiedCount === 1;
  }

  /** `pendente`/`confirmando`/`confirmado` → `removido`: a mídia saiu (ou nunca chegou a ficar) na galeria. Sem registro (mídia legada), não faz nada. */
  async marcarRemovido(uploadId: string, em: Date): Promise<boolean> {
    const resultado = await this.uploadModel
      .updateOne(
        { _id: uploadId, estado: { $in: ["pendente", "confirmando", "confirmado"] } },
        { $set: { estado: "removido", removidoEm: em, tokenReserva: null, reservadoEm: null } },
      )
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
