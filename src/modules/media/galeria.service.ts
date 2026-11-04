import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { Configuration } from "../../config/configuration.js";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import type { ProdutoDocument } from "../produtos/schemas/produto.schema.js";
import { idImagemPrincipal, midiasOrdenadas } from "../produtos/utils/midias.util.js";
import type { ConfirmarUploadDto, SolicitarUploadGaleriaDto } from "./dto/galeria.dto.js";
import { exigirBaseUrlPublica } from "./media-config.util.js";
import { assinaturaDoFormatoConfere, validarArquivoDeclarado } from "./media-validacao.util.js";
import {
  BYTES_ASSINATURA_FORMATO,
  CACHE_CONTROL_MIDIA,
  EXPIRACAO_UPLOAD_SEGUNDOS,
  LIMITE_MIDIAS_POR_PRODUTO,
  MEDIA_STORAGE,
  PRAZO_LIMPEZA_UPLOAD_MS,
  PREFIXO_CHAVE_PRODUTOS,
  type EstadoUploadMidia,
  type TipoMidia,
} from "./media.constants.js";
import type { MediaStorage, UploadGaleriaAutorizado } from "./media.types.js";
import type { UploadMidiaDocument } from "./uploads/schemas/upload-midia.schema.js";
import { UploadsMidiaRepository } from "./uploads/uploads-midia.repository.js";

/** Elemento de `Produto.midias` (subdocumento serializado com `id` no lugar de `_id`). */
export type MidiaSubdocumento = ProdutoDocument["midias"][number];

export interface GaleriaResposta {
  /** Mídias ativas pela `ordem`. */
  midias: MidiaSubdocumento[];
  /** Imagem principal efetiva: a marcada, ou a primeira imagem pela ordem; `null` sem imagens. */
  midiaPrincipalId: string | null;
}

export interface ConfirmacaoResposta extends GaleriaResposta {
  midia: MidiaSubdocumento;
}

const ROTULO_ESTADO: Record<EstadoUploadMidia, string> = {
  pendente: "pendente",
  confirmado: "confirmado",
  removido: "removido",
  descartado: "descartado",
};

const MENSAGEM_MIDIA_NAO_ENCONTRADA = "Mídia não encontrada neste produto.";
const MENSAGEM_TIPO_SUBSTITUICAO = "A substituição precisa ser do mesmo tipo: imagem por imagem, vídeo por vídeo.";

function contemMidia(produto: ProdutoDocument, midiaId: string): boolean {
  return produto.midias.some((midia) => midia._id === midiaId);
}

function encontrarMidiaOuFalhar(produto: ProdutoDocument, midiaId: string): MidiaSubdocumento {
  const midia = produto.midias.find((item) => item._id === midiaId);
  if (!midia) throw ApiException.notFound(MENSAGEM_MIDIA_NAO_ENCONTRADA);
  return midia;
}

function garantirVarianteDoProduto(produto: ProdutoDocument, varianteId: string): void {
  if (!produto.variantes.some((variante) => String(variante._id) === varianteId)) {
    throw ApiException.validation("Variante não encontrada neste produto.", [{ field: "varianteId", message: "Variante não encontrada neste produto." }]);
  }
}

function erroDeValidacao(campo: string, mensagem: string): ApiException {
  return ApiException.validation(mensagem, [{ field: campo, message: mensagem }]);
}

/**
 * Fase 60.1 — galeria de mídia do produto (`Produto.midias`/`midiaPrincipalId`) e ciclo de vida dos uploads
 * (`uploads_midia`). O backend é a autoridade da associação: o cliente nunca envia URL nem chave, só `uploadId`.
 *
 * Toda mutação do produto passa por `ProdutosRepository.salvarComRetentativa` (concorrência otimista pelo `__v`,
 * 409 ao esgotar) e acontece numa ÚNICA escrita do documento — nenhuma transação multi-documento. A coerência
 * entre o produto e `uploads_midia` segue uma regra só: o produto é a verdade, e o registro de upload é
 * ajustado DEPOIS, por transições condicionais idempotentes, reconciliáveis por uma nova chamada.
 */
@Injectable()
export class GaleriaService {
  private readonly logger = new Logger(GaleriaService.name);

  constructor(
    private readonly configService: ConfigService<Configuration>,
    private readonly produtosRepository: ProdutosRepository,
    private readonly uploadsRepository: UploadsMidiaRepository,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  /**
   * Autoriza um upload: cria o registro `pendente` (toda chave assinada fica rastreada) e só então assina a URL.
   * Não altera a galeria. Se a assinatura falhar, o registro vira `descartado` e a resposta é `STORAGE_UNAVAILABLE`.
   */
  async solicitarUpload(produtoId: string, dto: SolicitarUploadGaleriaDto, usuarioId: string | null): Promise<UploadGaleriaAutorizado> {
    exigirBaseUrlPublica(this.configService);
    const produto = await this.produtosRepository.encontrarPorIdOuFalhar(produtoId);
    const { extensao } = validarArquivoDeclarado(dto);
    // Fase 60.1.1 — substituição: o alvo precisa ser uma mídia ATIVA deste produto e do MESMO tipo; ela não conta no
    // limite (sai na mesma escrita que a nova entra). Upload novo continua contando uma mídia a mais.
    const substituiMidiaId = dto.substituiMidiaId ?? null;
    if (substituiMidiaId) {
      const antiga = produto.midias.find((midia) => midia._id === substituiMidiaId);
      if (!antiga) throw ApiException.notFound("Mídia a substituir não encontrada neste produto.");
      if (antiga.tipo !== dto.kind) throw erroDeValidacao("substituiMidiaId", MENSAGEM_TIPO_SUBSTITUICAO);
    }
    this.garantirLimite(produto, dto.kind, substituiMidiaId);

    const uploadId = randomUUID();
    const chave = `${PREFIXO_CHAVE_PRODUTOS}/${produto.id}/${uploadId}.${extensao}`;
    const agora = Date.now();
    await this.uploadsRepository.criar({
      _id: uploadId,
      produtoId: produto._id,
      chave,
      tipo: dto.kind,
      contentType: dto.contentType,
      tamanho: dto.size,
      nomeOriginal: dto.fileName.trim(),
      substituiMidiaId,
      criadoPor: usuarioId,
      criadoEm: new Date(agora),
      urlExpiraEm: new Date(agora + EXPIRACAO_UPLOAD_SEGUNDOS * 1000),
      limpezaApos: new Date(agora + PRAZO_LIMPEZA_UPLOAD_MS),
    });

    let uploadUrl: string;
    try {
      uploadUrl = await this.storage.assinarUpload({
        key: chave,
        contentType: dto.contentType,
        contentLength: dto.size,
        expiresInSeconds: EXPIRACAO_UPLOAD_SEGUNDOS,
        cacheControl: CACHE_CONTROL_MIDIA,
      });
    } catch (erro) {
      await this.tolerarFalha("descartar registro após falha de assinatura", uploadId, () => this.uploadsRepository.marcarDescartado(uploadId));
      throw erro instanceof ApiException ? erro : ApiException.storageUnavailable();
    }

    return {
      uploadId,
      uploadUrl,
      method: "PUT",
      headers: { "Content-Type": dto.contentType, "Cache-Control": CACHE_CONTROL_MIDIA },
      expiresIn: EXPIRACAO_UPLOAD_SEGUNDOS,
    };
  }

  /**
   * Confirma um upload e inclui a mídia na galeria. Ordem: registro do produto → produto ativo → reconciliação
   * (o produto já referencia o `uploadId`) → estado `pendente` → prazo → objeto no storage (existência, tamanho,
   * `Content-Type`) → assinatura real do formato → escrita atômica do produto (variante, limite, substituição e
   * principal validados DENTRO da mutação) → registro `confirmado`.
   *
   * Falhas parciais: qualquer erro antes da escrita do produto deixa o registro `pendente` (nova tentativa
   * possível); se o produto foi gravado mas o registro não, a resposta é sucesso e a próxima confirmação reconcilia.
   * O registro só vira `confirmado` depois de o produto comprovadamente referenciar a mídia.
   */
  async confirmarUpload(produtoId: string, uploadId: string, dto: ConfirmarUploadDto, usuarioId: string | null): Promise<ConfirmacaoResposta> {
    const registro = await this.uploadsRepository.encontrarPorId(uploadId);
    if (!registro || String(registro.produtoId) !== produtoId) throw ApiException.notFound("Upload não encontrado para este produto.");

    // Fase 60.1.1 — a intenção registrada na SOLICITAÇÃO é a fonte de verdade da substituição. O corpo pode repeti-la,
    // nunca trocá-la nem introduzi-la (registros anteriores, sem o campo, valem como "sem substituição").
    const alvo = registro.substituiMidiaId ?? null;
    if (dto.substituiMidiaId !== undefined && dto.substituiMidiaId !== alvo) {
      throw ApiException.conflict(
        alvo
          ? "O substituiMidiaId informado é diferente do registrado na solicitação deste upload."
          : "Este upload foi solicitado sem substituição; a confirmação não pode introduzir uma.",
      );
    }

    const produto = await this.produtosRepository.encontrarPorIdOuFalhar(produtoId);
    if (contemMidia(produto, uploadId)) {
      // Repetição (ou retomada depois de falha parcial): a mídia já está na galeria — só conclui os registros.
      await this.concluirRegistros(produtoId, uploadId, alvo && !contemMidia(produto, alvo) ? alvo : null, true);
      return this.respostaConfirmacao(produto, uploadId);
    }

    if (registro.estado !== "pendente") {
      throw ApiException.conflict(`Este upload não pode ser confirmado: ele está ${ROTULO_ESTADO[registro.estado]}.`);
    }
    if (Date.now() > registro.limpezaApos.getTime()) {
      throw ApiException.conflict("Upload expirado. Solicite um novo upload.");
    }
    if (registro.tipo === "video" && dto.varianteId) throw erroDeValidacao("varianteId", "Vídeos não podem ser associados a uma variante.");
    if (registro.tipo === "video" && dto.principal) throw erroDeValidacao("principal", "Somente imagens podem ser a imagem principal.");

    const baseUrl = exigirBaseUrlPublica(this.configService);
    await this.verificarObjeto(registro);

    const agora = new Date();
    const desfecho: { substituida: string | null } = { substituida: null };
    const salvo = await this.produtosRepository.salvarComRetentativa(produtoId, (documento) => {
      desfecho.substituida = null;
      // Uma confirmação concorrente do mesmo upload já gravou: nada a fazer (nunca duplica).
      if (contemMidia(documento, uploadId)) return;

      let ordem = documento.midias.reduce((maior, midia) => Math.max(maior, midia.ordem + 1), 0);
      let varianteId = dto.varianteId ?? null;
      let principal = dto.principal === true;
      let antiga: MidiaSubdocumento | null = null;

      if (alvo) {
        // Revalidado DENTRO da mutação: o alvo pode ter sido removido (ou já substituído por outro upload) depois da
        // solicitação. Erro controlado, galeria intacta, registro pendente.
        antiga = documento.midias.find((midia) => midia._id === alvo) ?? null;
        if (!antiga) throw ApiException.conflict("A mídia a ser substituída não está mais na galeria. Solicite um novo upload.");
        if (antiga.tipo !== registro.tipo) throw ApiException.conflict(MENSAGEM_TIPO_SUBSTITUICAO);
        ordem = antiga.ordem;
        if (dto.varianteId === undefined) varianteId = antiga.varianteId ? String(antiga.varianteId) : null;
        if (documento.midiaPrincipalId === antiga._id && registro.tipo === "image") principal = true;
      }

      if (registro.tipo === "video" && varianteId) throw erroDeValidacao("varianteId", "Vídeos não podem ser associados a uma variante.");
      if (varianteId) garantirVarianteDoProduto(documento, varianteId);
      this.garantirLimite(documento, registro.tipo, antiga?._id ?? null);

      if (antiga) {
        if (documento.midiaPrincipalId === antiga._id) documento.midiaPrincipalId = null;
        documento.midias.pull({ _id: antiga._id });
        desfecho.substituida = antiga._id;
      }
      documento.midias.push({
        _id: uploadId,
        tipo: registro.tipo,
        chave: registro.chave,
        url: `${baseUrl}/${registro.chave}`,
        contentType: registro.contentType,
        tamanho: registro.tamanho,
        nomeOriginal: registro.nomeOriginal,
        origem: "upload",
        varianteId: varianteId ? new Types.ObjectId(varianteId) : null,
        ordem,
        criadoEm: agora,
        criadoPor: usuarioId,
      });
      if (principal) documento.midiaPrincipalId = uploadId;
    });

    await this.concluirRegistros(produtoId, uploadId, desfecho.substituida, false);
    return this.respostaConfirmacao(salvo, uploadId);
  }

  async listar(produtoId: string): Promise<GaleriaResposta> {
    return this.galeria(await this.produtosRepository.encontrarPorIdOuFalhar(produtoId));
  }

  async associarVariante(produtoId: string, midiaId: string, varianteId: string | null): Promise<GaleriaResposta> {
    const salvo = await this.produtosRepository.salvarComRetentativa(produtoId, (documento) => {
      const midia = encontrarMidiaOuFalhar(documento, midiaId);
      if (midia.tipo !== "image") throw erroDeValidacao("varianteId", "Somente imagens podem ser associadas a uma variante.");
      if (varianteId) garantirVarianteDoProduto(documento, varianteId);
      midia.varianteId = varianteId ? new Types.ObjectId(varianteId) : null;
    });
    return this.galeria(salvo);
  }

  async definirPrincipal(produtoId: string, midiaId: string): Promise<GaleriaResposta> {
    const salvo = await this.produtosRepository.salvarComRetentativa(produtoId, (documento) => {
      const midia = encontrarMidiaOuFalhar(documento, midiaId);
      if (midia.tipo !== "image") throw erroDeValidacao("midiaId", "Somente imagens podem ser a imagem principal.");
      documento.midiaPrincipalId = midiaId;
    });
    return this.galeria(salvo);
  }

  /** `midiaIds` precisa ser exatamente o conjunto atual da galeria (conferido dentro da mutação); `ordem` = posição na lista. */
  async reordenar(produtoId: string, midiaIds: string[]): Promise<GaleriaResposta> {
    if (new Set(midiaIds).size !== midiaIds.length) {
      throw ApiException.validation("A lista de mídias contém ids repetidos.", [{ field: "midiaIds", message: "A lista de mídias contém ids repetidos." }]);
    }
    const salvo = await this.produtosRepository.salvarComRetentativa(produtoId, (documento) => {
      const atuais = new Set(documento.midias.map((midia) => midia._id));
      if (midiaIds.length !== atuais.size || midiaIds.some((id) => !atuais.has(id))) {
        const mensagem = "A lista deve conter exatamente todas as mídias atuais da galeria, sem ausentes nem adicionais.";
        throw ApiException.validation(mensagem, [{ field: "midiaIds", message: mensagem }]);
      }
      for (const midia of documento.midias) midia.ordem = midiaIds.indexOf(midia._id);
    });
    return this.galeria(salvo);
  }

  /**
   * Tira a mídia da galeria (e da principal, se for o caso) numa escrita só; depois marca o registro `removido`.
   * O objeto no R2 NÃO é apagado. Mídia legada (sem registro) é removida do mesmo jeito — a marcação não encontra
   * nada e não faz nada. Se a remoção anterior gravou o produto mas falhou ao marcar o registro, repetir o DELETE
   * conclui essa marcação.
   */
  async remover(produtoId: string, midiaId: string): Promise<GaleriaResposta> {
    const produto = await this.produtosRepository.encontrarPorIdOuFalhar(produtoId);
    if (!contemMidia(produto, midiaId)) {
      if (await this.uploadsRepository.marcarRemovidoSeConfirmado(midiaId, produtoId, new Date())) return this.galeria(produto);
      throw ApiException.notFound(MENSAGEM_MIDIA_NAO_ENCONTRADA);
    }

    const salvo = await this.produtosRepository.salvarComRetentativa(produtoId, (documento) => {
      encontrarMidiaOuFalhar(documento, midiaId);
      if (documento.midiaPrincipalId === midiaId) documento.midiaPrincipalId = null;
      documento.midias.pull({ _id: midiaId });
    });
    await this.tolerarFalha("marcar upload como removido", midiaId, () => this.uploadsRepository.marcarRemovido(midiaId, new Date()));
    return this.galeria(salvo);
  }

  /** Conta só as mídias ATIVAS do tipo (a substituída, se houver, não conta: ela sai na mesma escrita). */
  private garantirLimite(produto: ProdutoDocument, tipo: TipoMidia, ignorarMidiaId: string | null): void {
    const limite = LIMITE_MIDIAS_POR_PRODUTO[tipo];
    const atuais = produto.midias.filter((midia) => midia.tipo === tipo && midia._id !== ignorarMidiaId).length;
    if (atuais >= limite) {
      throw ApiException.conflict(`Limite de ${limite} ${tipo === "image" ? "imagens" : "vídeos"} por produto atingido.`);
    }
  }

  private async verificarObjeto(registro: UploadMidiaDocument): Promise<void> {
    const ausente = () => erroDeValidacao("uploadId", "O arquivo não foi encontrado no armazenamento. Envie o arquivo antes de confirmar.");
    const inspecao = await this.chamarStorage(() => this.storage.inspecionarObjeto(registro.chave));
    if (!inspecao.existe) throw ausente();
    if (inspecao.tamanho !== registro.tamanho) {
      throw erroDeValidacao("size", "O tamanho do arquivo enviado é diferente do declarado na solicitação.");
    }
    const tipoRecebido = inspecao.contentType?.split(";")[0]?.trim().toLowerCase() ?? null;
    if (tipoRecebido !== registro.contentType) {
      throw erroDeValidacao("contentType", "O tipo do arquivo enviado é diferente do declarado na solicitação.");
    }
    const bytes = await this.chamarStorage(() => this.storage.lerPrimeirosBytes(registro.chave, BYTES_ASSINATURA_FORMATO));
    if (bytes === null) throw ausente();
    if (!assinaturaDoFormatoConfere(registro.contentType, bytes)) {
      throw erroDeValidacao("contentType", "O conteúdo do arquivo não corresponde ao formato declarado.");
    }
  }

  /** Falha inesperada de uma implementação de storage vira `STORAGE_UNAVAILABLE` (o provider R2 já lança assim). */
  private async chamarStorage<T>(operacao: () => Promise<T>): Promise<T> {
    try {
      return await operacao();
    } catch (erro) {
      throw erro instanceof ApiException ? erro : ApiException.storageUnavailable();
    }
  }

  /**
   * Ajusta `uploads_midia` depois que o produto já reflete a verdade. Melhor esforço: uma falha aqui é registrada e
   * NÃO desfaz a resposta (o produto já foi gravado) — a próxima confirmação/remoção reconcilia.
   */
  private async concluirRegistros(produtoId: string, uploadId: string, substituida: string | null, reconciliando: boolean): Promise<void> {
    await this.tolerarFalha("marcar upload como confirmado", uploadId, () => this.uploadsRepository.marcarConfirmado(uploadId, new Date()));
    if (!substituida) return;
    // Na reconciliação só um registro `confirmado` (que de fato esteve na galeria) pode virar `removido`.
    await this.tolerarFalha("marcar upload substituído como removido", substituida, () =>
      reconciliando
        ? this.uploadsRepository.marcarRemovidoSeConfirmado(substituida, produtoId, new Date())
        : this.uploadsRepository.marcarRemovido(substituida, new Date()),
    );
  }

  private async tolerarFalha(operacao: string, uploadId: string, acao: () => Promise<unknown>): Promise<void> {
    try {
      await acao();
    } catch (erro) {
      const nome = erro instanceof Error ? erro.name : typeof erro;
      this.logger.warn(`Falha ao ${operacao} (upload ${uploadId}, ${nome}); será reconciliado na próxima chamada.`);
    }
  }

  private galeria(produto: ProdutoDocument): GaleriaResposta {
    return { midias: midiasOrdenadas(produto.midias), midiaPrincipalId: idImagemPrincipal(produto) };
  }

  private respostaConfirmacao(produto: ProdutoDocument, uploadId: string): ConfirmacaoResposta {
    return { midia: encontrarMidiaOuFalhar(produto, uploadId), ...this.galeria(produto) };
  }
}
