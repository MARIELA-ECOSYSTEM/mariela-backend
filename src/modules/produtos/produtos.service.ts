import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, ApiMeta } from "../../common/types/api-response.interface.js";
import { CHAVE_SEQUENCIA_PRODUTO, DIGITOS_CODIGO_PRODUTO, PREFIXO_CODIGO_PRODUTO } from "./produtos.constants.js";
import { SequenciasService } from "../sequencias/sequencias.service.js";
import type { AdicionarTamanhoDto } from "./dto/adicionar-tamanho.dto.js";
import type { AtualizarProdutoDto } from "./dto/atualizar-produto.dto.js";
import type { AtualizarVarianteDto } from "./dto/atualizar-variante.dto.js";
import type { CriarProdutoDto } from "./dto/criar-produto.dto.js";
import type { CriarVarianteDto } from "./dto/criar-variante.dto.js";
import type { DefinirFotoPrincipalDto } from "./dto/definir-foto-principal.dto.js";
import type { DefinirNovidadeDto } from "./dto/definir-novidade.dto.js";
import type { DefinirPromocaoDto } from "./dto/definir-promocao.dto.js";
import type { ListarProdutosQueryDto } from "./dto/listar-produtos-query.dto.js";
import { conflitoTamanhoUnico, formatarCodigoVariante, normalizarCor, normalizarTamanho } from "./utils/normalizacao.util.js";
import { arredondarMoeda, calcularMargem, precoEfetivo } from "./utils/precos.util.js";
import { ProdutosRepository } from "./produtos.repository.js";
import type { DadosNovaVariante } from "./produtos.types.js";
import { EventoProduto, type EventoProdutoDocument } from "./schemas/evento-produto.schema.js";
import type { ProdutoDocument } from "./schemas/produto.schema.js";
import type { Variante, VarianteDocument } from "./schemas/variante.schema.js";
import type { SelecaoFacetas } from "./produtos-filtros.util.js";

export interface ResultadoListaProdutos {
  data: ProdutoDocument[];
  meta: ApiMeta;
  facets: ApiFacets;
}

@Injectable()
export class ProdutosService {
  constructor(
    private readonly produtosRepository: ProdutosRepository,
    private readonly sequenciasService: SequenciasService,
    @InjectModel(EventoProduto.name) private readonly eventoModel: Model<EventoProdutoDocument>,
  ) {}

  async criar(dto: CriarProdutoDto, usuarioId: string | null): Promise<ProdutoDocument> {
    const codProduto = await this.sequenciasService.proximoCodigo(
      CHAVE_SEQUENCIA_PRODUTO,
      PREFIXO_CODIGO_PRODUTO,
      DIGITOS_CODIGO_PRODUTO,
    );

    const precoCusto = arredondarMoeda(dto.precoCusto);
    const precoVenda = arredondarMoeda(dto.precoVenda);

    const produto = await this.produtosRepository.criar({
      codProduto,
      nome: dto.nome.trim(),
      descricao: dto.descricao?.trim() ?? "",
      categoria: dto.categoria.trim(),
      colecaoId: dto.colecaoId?.trim() || null,
      campanhaId: dto.campanhaId?.trim() || null,
      fornecedorId: dto.fornecedorId?.trim() || null,
      precoCusto,
      precoVenda,
      margemLucro: calcularMargem(precoCusto, precoEfetivo({ precoVenda, ehPromocao: false, precoPromocional: null })),
      ehNovidade: dto.ehNovidade ?? false,
      ehPromocao: false,
      precoPromocional: null,
      quantidadeTotal: 0,
      fotoPrincipalVarianteId: null,
      estoqueZeradoEm: null,
      excluidoEm: null,
      variantes: [],
    });

    await this.registrarEvento(produto.id, null, "produto.criado", usuarioId, { codProduto });
    return produto;
  }

  /**
   * Etapa 20.01A — `paginado` decide se a página `data` é truncada por
   * `page`/`limit` ou devolvida por completo; ver `ProdutosController.listar`
   * para o critério de quando cada modo é usado. Busca/ordenação/facetas são
   * SEMPRE aplicadas da mesma forma nos dois modos — só a paginação em si
   * muda. Quando `paginado` é `false`, `meta` reflete a lista inteira (mesmo
   * formato hoje devolvido pelo mock do Backoffice: `limit === total`).
   */
  async listar(query: ListarProdutosQueryDto, paginado = true): Promise<ResultadoListaProdutos> {
    const selecao: SelecaoFacetas = {
      categorias: query.categorias,
      colecoes: query.colecoes,
      campanhas: query.campanhas,
      fornecedores: query.fornecedores,
      estoque: query.estoque,
      promocao: query.promocao,
      novidade: query.novidade,
    };

    const { itens, total, facets } = await this.produtosRepository.listarComFacetas({
      busca: query.busca,
      ordenarPor: query.ordenarPor,
      ordem: query.ordem,
      selecao,
      page: query.page,
      limit: query.limit,
      paginar: paginado,
    });

    if (!paginado) {
      return {
        data: itens,
        meta: { total, page: 1, limit: total, totalPages: 1 },
        facets,
      };
    }

    return {
      data: itens,
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
      facets,
    };
  }

  async obterPorId(id: string): Promise<ProdutoDocument> {
    return this.produtosRepository.encontrarPorIdOuFalhar(id);
  }

  async atualizar(id: string, dto: AtualizarProdutoDto, usuarioId: string | null): Promise<ProdutoDocument> {
    const precoCusto = arredondarMoeda(dto.precoCusto);
    const precoVenda = arredondarMoeda(dto.precoVenda);

    const produto = await this.produtosRepository.salvarComRetentativa(id, (documento) => {
      // Integridade > conveniência: reduzir o preço de venda para menos do que
      // o preço promocional ativo quebraria o invariante "promocional < venda"
      // silenciosamente — bloqueado, ao invés de desativar a promoção sem avisar.
      if (documento.ehPromocao && documento.precoPromocional && precoVenda <= documento.precoPromocional) {
        throw ApiException.validation("Dados inválidos.", [
          {
            field: "precoVenda",
            message:
              "O preço de venda deve ser maior que o preço promocional ativo. Desative a promoção antes de reduzir o preço.",
          },
        ]);
      }

      documento.nome = dto.nome.trim();
      documento.descricao = dto.descricao?.trim() ?? "";
      documento.categoria = dto.categoria.trim();
      documento.colecaoId = dto.colecaoId?.trim() || null;
      documento.campanhaId = dto.campanhaId?.trim() || null;
      documento.fornecedorId = dto.fornecedorId?.trim() || null;
      documento.precoCusto = precoCusto;
      documento.precoVenda = precoVenda;
      documento.ehNovidade = dto.ehNovidade ?? false;
      this.recalcularDerivados(documento);
    });

    await this.registrarEvento(produto.id, null, "produto.atualizado", usuarioId, {});
    return produto;
  }

  async excluir(id: string, usuarioId: string | null): Promise<void> {
    const produto = await this.produtosRepository.encontrarPorIdOuFalhar(id);
    produto.excluidoEm = new Date();
    await produto.save();
    await this.registrarEvento(produto.id, null, "produto.excluido", usuarioId, {});
  }

  async definirPromocao(id: string, dto: DefinirPromocaoDto, usuarioId: string | null): Promise<ProdutoDocument> {
    const produto = await this.produtosRepository.salvarComRetentativa(id, (documento) => {
      if (dto.ehPromocao) {
        const preco = arredondarMoeda(dto.precoPromocional ?? 0);
        if (preco <= 0) {
          throw ApiException.validation("Dados inválidos.", [
            { field: "precoPromocional", message: "Preço promocional deve ser maior que zero." },
          ]);
        }
        if (preco >= documento.precoVenda) {
          throw ApiException.validation("Dados inválidos.", [
            { field: "precoPromocional", message: "Preço promocional deve ser menor que o preço de venda." },
          ]);
        }
        documento.ehPromocao = true;
        documento.precoPromocional = preco;
      } else {
        documento.ehPromocao = false;
      }
      this.recalcularDerivados(documento);
    });

    await this.registrarEvento(
      produto.id,
      null,
      dto.ehPromocao ? "promocao.ativada" : "promocao.desativada",
      usuarioId,
      { precoPromocional: produto.precoPromocional },
    );
    return produto;
  }

  async definirNovidade(id: string, dto: DefinirNovidadeDto, usuarioId: string | null): Promise<ProdutoDocument> {
    const produto = await this.produtosRepository.salvarComRetentativa(id, (documento) => {
      documento.ehNovidade = Boolean(dto.ehNovidade);
    });
    await this.registrarEvento(produto.id, null, "novidade.alterada", usuarioId, { ehNovidade: produto.ehNovidade });
    return produto;
  }

  async definirFotoPrincipal(
    id: string,
    dto: DefinirFotoPrincipalDto,
    usuarioId: string | null,
  ): Promise<ProdutoDocument> {
    const produto = await this.produtosRepository.salvarComRetentativa(id, (documento) => {
      const varianteId = dto.varianteId ?? null;
      if (varianteId) {
        const variante = documento.variantes.find((item) => String(item._id) === varianteId);
        if (!variante?.foto) {
          throw ApiException.validation("Dados inválidos.", [
            { field: "varianteId", message: "A variante selecionada não possui foto." },
          ]);
        }
      }
      documento.fotoPrincipalVarianteId = varianteId as unknown as Types.ObjectId | null;
    });
    await this.registrarEvento(produto.id, null, "foto-principal.alterada", usuarioId, {
      varianteId: produto.fotoPrincipalVarianteId ? String(produto.fotoPrincipalVarianteId) : null,
    });
    return produto;
  }

  async adicionarVariante(produtoId: string, dto: CriarVarianteDto, usuarioId: string | null): Promise<Variante> {
    // Confirma a existência do produto ANTES de tudo, só para reportar 404 vs.
    // "cor duplicada" corretamente — a inserção em si é atômica (ver repository).
    const produtoAtual = await this.produtosRepository.encontrarPorIdOuFalhar(produtoId);

    const corNormalizada = normalizarCor(dto.cor);
    const novaVariante: DadosNovaVariante = {
      cor: dto.cor.trim(),
      corNormalizada,
      codVariante: formatarCodigoVariante(produtoAtual.codProduto, dto.cor),
      quantidadeVariante: 0,
      foto: dto.foto?.trim() || null,
      video: dto.video?.trim() || null,
      tamanhos: [],
    };

    const produtoAtualizado = await this.produtosRepository.adicionarVarianteAtomico(produtoId, novaVariante);
    if (!produtoAtualizado) {
      throw ApiException.validation("Dados inválidos.", [
        { field: "cor", message: "Esta cor já está cadastrada neste produto." },
      ]);
    }

    const variante = produtoAtualizado.variantes[produtoAtualizado.variantes.length - 1]!;
    await this.registrarEvento(produtoId, String(variante._id), "variante.criada", usuarioId, { cor: variante.cor });
    return variante;
  }

  async atualizarVariante(
    produtoId: string,
    varianteId: string,
    dto: AtualizarVarianteDto,
    usuarioId: string | null,
  ): Promise<Variante> {
    const corNormalizada = normalizarCor(dto.cor);

    const produto = await this.produtosRepository.salvarComRetentativa(produtoId, (documento) => {
      const variante = this.encontrarVarianteOuFalhar(documento, varianteId);
      const duplicada = documento.variantes.some(
        (item) => String(item._id) !== varianteId && item.corNormalizada === corNormalizada,
      );
      if (duplicada) {
        throw ApiException.validation("Dados inválidos.", [
          { field: "cor", message: "Esta cor já está cadastrada neste produto." },
        ]);
      }
      variante.cor = dto.cor.trim();
      variante.corNormalizada = corNormalizada;
      // `codVariante` é imutável após a criação — decisão de negócio já aprovada.
      variante.foto = dto.foto?.trim() || null;
      variante.video = dto.video?.trim() || null;
    });

    const variante = this.encontrarVarianteOuFalhar(produto, varianteId);
    await this.registrarEvento(produtoId, varianteId, "variante.atualizada", usuarioId, { cor: variante.cor });
    return variante;
  }

  async removerVariante(produtoId: string, varianteId: string, usuarioId: string | null): Promise<void> {
    let snapshot: { cor: string; codVariante: string } | null = null;

    await this.produtosRepository.salvarComRetentativa(produtoId, (documento) => {
      const variante = this.encontrarVarianteOuFalhar(documento, varianteId);
      snapshot = { cor: variante.cor, codVariante: variante.codVariante };
      if (String(documento.fotoPrincipalVarianteId) === varianteId) {
        documento.fotoPrincipalVarianteId = null;
      }
      documento.variantes.pull({ _id: varianteId });
      this.recalcularDerivados(documento);
    });

    await this.registrarEvento(produtoId, varianteId, "variante.excluida", usuarioId, snapshot ?? {});
  }

  async adicionarTamanho(
    produtoId: string,
    varianteId: string,
    dto: AdicionarTamanhoDto,
    usuarioId: string | null,
  ): Promise<Variante> {
    const tamanhoNormalizado = normalizarTamanho(dto.tamanho);

    const produto = await this.produtosRepository.salvarComRetentativa(produtoId, (documento) => {
      const variante = this.encontrarVarianteOuFalhar(documento, varianteId);
      const tamanhosExistentes = variante.tamanhos.map((item) => item.tamanho);

      if (tamanhosExistentes.some((tamanho) => normalizarTamanho(tamanho) === tamanhoNormalizado)) {
        throw ApiException.validation("Dados inválidos.", [
          { field: "tamanho", message: "Este tamanho já está cadastrado nesta variante." },
        ]);
      }
      const conflito = conflitoTamanhoUnico(tamanhosExistentes, tamanhoNormalizado);
      if (conflito) {
        throw ApiException.validation("Dados inválidos.", [{ field: "tamanho", message: conflito }]);
      }

      variante.tamanhos.push({ tamanho: tamanhoNormalizado, quantidade: dto.quantidade });
      this.recalcularDerivados(documento);
    });

    const variante = this.encontrarVarianteOuFalhar(produto, varianteId);
    await this.registrarEvento(produtoId, varianteId, "tamanho.adicionado", usuarioId, {
      tamanho: tamanhoNormalizado,
      quantidade: dto.quantidade,
    });
    return variante;
  }

  async removerTamanho(
    produtoId: string,
    varianteId: string,
    tamanhoId: string,
    usuarioId: string | null,
  ): Promise<void> {
    await this.produtosRepository.salvarComRetentativa(produtoId, (documento) => {
      const variante = this.encontrarVarianteOuFalhar(documento, varianteId);
      const tamanho = variante.tamanhos.find((item) => String(item._id) === tamanhoId);
      if (!tamanho) throw ApiException.notFound("Tamanho não encontrado.");
      variante.tamanhos.pull({ _id: tamanhoId });
      this.recalcularDerivados(documento);
    });

    await this.registrarEvento(produtoId, varianteId, "tamanho.excluido", usuarioId, { tamanhoId });
  }

  /** Usado pelo módulo Estoque (entrada/saída) — mesmo documento, mesma proteção de concorrência. */
  async ajustarQuantidadeTamanho(
    produtoId: string,
    varianteId: string,
    ajuste: { tamanhoId?: string; tamanho?: string; delta: number; exigirExistente: boolean },
  ): Promise<{ produto: ProdutoDocument; tamanhoId: string; saldoResultante: number }> {
    let tamanhoIdAfetado = "";
    let saldoResultante = 0;

    const produto = await this.produtosRepository.salvarComRetentativa(produtoId, (documento) => {
      const variante = this.encontrarVarianteOuFalhar(documento, varianteId);

      let tamanho = ajuste.tamanhoId
        ? variante.tamanhos.find((item) => String(item._id) === ajuste.tamanhoId)
        : variante.tamanhos.find((item) => normalizarTamanho(item.tamanho) === normalizarTamanho(ajuste.tamanho ?? ""));

      if (!tamanho) {
        if (ajuste.exigirExistente) throw ApiException.notFound("Tamanho não encontrado.");
        if (!ajuste.tamanho?.trim()) {
          throw ApiException.validation("Dados inválidos.", [
            { field: "tamanho", message: "Tamanho é obrigatório." },
          ]);
        }
        const tamanhoNormalizado = normalizarTamanho(ajuste.tamanho);
        const conflito = conflitoTamanhoUnico(
          variante.tamanhos.map((item) => item.tamanho),
          tamanhoNormalizado,
        );
        if (conflito) throw ApiException.validation("Dados inválidos.", [{ field: "tamanho", message: conflito }]);

        variante.tamanhos.push({ tamanho: tamanhoNormalizado, quantidade: 0 });
        tamanho = variante.tamanhos[variante.tamanhos.length - 1];
      }

      const resultado = (tamanho!.quantidade ?? 0) + ajuste.delta;
      if (resultado < 0) {
        throw ApiException.validation("Dados inválidos.", [
          {
            field: "quantidade",
            message: `Quantidade indisponível. Estoque atual do tamanho ${tamanho!.tamanho}: ${tamanho!.quantidade}.`,
          },
        ]);
      }
      tamanho!.quantidade = resultado;
      tamanhoIdAfetado = String(tamanho!._id);
      saldoResultante = resultado;
      this.recalcularDerivados(documento);
    });

    return { produto, tamanhoId: tamanhoIdAfetado, saldoResultante };
  }

  private encontrarVarianteOuFalhar(produto: ProdutoDocument, varianteId: string): VarianteDocument {
    const variante = produto.variantes.find((item) => String(item._id) === varianteId) as VarianteDocument | undefined;
    if (!variante) throw ApiException.notFound("Variante não encontrada.");
    return variante;
  }

  /** Única função que recalcula estoque/margem — nunca duplicar esta lógica em outro lugar do módulo. */
  private recalcularDerivados(produto: ProdutoDocument): void {
    produto.variantes.forEach((variante) => {
      variante.quantidadeVariante = variante.tamanhos.reduce((total, tamanho) => total + tamanho.quantidade, 0);
    });

    const quantidadeAnterior = produto.quantidadeTotal;
    produto.quantidadeTotal = produto.variantes.reduce((total, variante) => total + variante.quantidadeVariante, 0);

    // `estoqueZeradoEm` só é iniciado quando um produto que JÁ TINHA estoque
    // volta a zero — nunca no cadastro inicial (que já nasce zerado).
    if (quantidadeAnterior > 0 && produto.quantidadeTotal === 0) {
      produto.estoqueZeradoEm = new Date();
    } else if (produto.quantidadeTotal > 0) {
      produto.estoqueZeradoEm = null;
    }

    produto.margemLucro = calcularMargem(produto.precoCusto, precoEfetivo(produto));
  }

  private async registrarEvento(
    produtoId: string | Types.ObjectId,
    varianteId: string | null,
    tipo: string,
    usuarioId: string | null,
    detalhes: Record<string, unknown>,
  ): Promise<void> {
    await this.eventoModel.create({ produtoId, varianteId, tipo, usuarioId, detalhes });
  }
}
