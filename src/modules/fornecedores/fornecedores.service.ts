import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, ApiMeta } from "../../common/types/api-response.interface.js";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import type { ProdutoDocument } from "../produtos/schemas/produto.schema.js";
import { precoEfetivo } from "../produtos/utils/precos.util.js";
import {
  CHAVE_SEQUENCIA_FORNECEDOR,
  DIGITOS_CODIGO_FORNECEDOR,
  FACETAS_FORNECEDOR,
  FAIXAS_PRODUTOS,
  JANELAS_ENTRADA,
  PREFIXO_CODIGO_FORNECEDOR,
  VALORES_DOCUMENTO,
  VALORES_ENDERECO,
  type OrdenarFornecedorPor,
  type Ordem,
} from "./fornecedores.constants.js";
import {
  aplicarSelecao,
  condicaoValor,
  type FornecedorComAgregado,
  type SelecaoFacetas,
} from "./fornecedores-filtros.util.js";
import { FornecedoresRepository } from "./fornecedores.repository.js";
import type { AgregadoFornecedor, EnderecoFornecedorDados } from "./fornecedores.types.js";
import type { AtualizarFornecedorDto } from "./dto/atualizar-fornecedor.dto.js";
import type { CriarFornecedorDto } from "./dto/criar-fornecedor.dto.js";
import type { EnderecoFornecedorDto } from "./dto/endereco-fornecedor.dto.js";
import type { ListarFornecedoresQueryDto } from "./dto/listar-fornecedores-query.dto.js";
import { EventoFornecedor, type EventoFornecedorDocument } from "./schemas/evento-fornecedor.schema.js";
import type { Fornecedor, FornecedorDocument } from "./schemas/fornecedor.schema.js";
import { normalizarTelefone } from "./utils/normalizacao.util.js";
import { SequenciasService } from "../sequencias/sequencias.service.js";

/** Espelha `Fornecedor` do Backoffice (`src/types/fornecedor.ts`) — inclui os agregados calculados. */
export interface FornecedorRespostaPublica {
  id: string;
  codigo: string;
  nome: string;
  foto: string | null;
  contato: string;
  telefone: string;
  email: string;
  cnpj: string;
  instagram: string;
  observacao: string;
  endereco: EnderecoFornecedorDados | null;
  criadoEm: Date;
  atualizadoEm: Date;
  produtosVinculados: number;
  valorEmCusto: number;
  ultimaEntrada: Date | null;
}

export interface ResultadoListaFornecedores {
  data: FornecedorRespostaPublica[];
  meta: ApiMeta;
  facets: ApiFacets;
}

export interface HistoricoFornecedorItem {
  id: string;
  produtoId: string;
  produtoNome: string;
  codProduto: string;
  vinculadoEm: Date;
  desvinculadoEm: null;
  precoCusto: number;
  precoVenda: number;
  situacao: "atual";
}

@Injectable()
export class FornecedoresService {
  constructor(
    private readonly fornecedoresRepository: FornecedoresRepository,
    private readonly produtosRepository: ProdutosRepository,
    private readonly sequenciasService: SequenciasService,
    @InjectModel(EventoFornecedor.name) private readonly eventoModel: Model<EventoFornecedorDocument>,
  ) {}

  async criar(dto: CriarFornecedorDto, usuarioId: string | null): Promise<FornecedorRespostaPublica> {
    const telefoneNormalizado = normalizarTelefone(dto.telefone ?? "");
    await this.garantirTelefoneDisponivel(telefoneNormalizado);

    const codigo = await this.sequenciasService.proximoCodigo(
      CHAVE_SEQUENCIA_FORNECEDOR,
      PREFIXO_CODIGO_FORNECEDOR,
      DIGITOS_CODIGO_FORNECEDOR,
    );

    const fornecedor = await this.fornecedoresRepository.criar({
      codigo,
      nome: dto.nome.trim(),
      foto: dto.foto?.trim() || null,
      contato: dto.contato?.trim() ?? "",
      telefone: dto.telefone?.trim() ?? "",
      telefoneNormalizado,
      email: dto.email?.trim() ?? "",
      cnpj: dto.cnpj?.trim() ?? "",
      instagram: dto.instagram?.trim() ?? "",
      observacao: dto.observacao?.trim() ?? "",
      endereco: this.normalizarEndereco(dto.endereco),
      excluidoEm: null,
    });

    await this.registrarEvento(fornecedor.id, "fornecedor.criado", usuarioId, { codigo });
    return this.paraRespostaPublica(fornecedor, { produtosVinculados: 0, valorEmCusto: 0, ultimaEntrada: null });
  }

  /**
   * Contrato LEGADO do Backoffice (Etapa 14.2, mesmo padrão de
   * `ClientesService.listarTodosAtivos`) — `GET /fornecedores` sem NENHUM
   * parâmetro espera de volta a base INTEIRA de fornecedores ativos, num
   * array simples, nunca truncada pelo `limit` padrão de `listar()`. Reusa
   * `FornecedoresRepository.encontrarTodosAtivos()` e a MESMA função de
   * agregação (`construirMapaDeAgregados`) já usada por `listar()` — os
   * agregados públicos (`produtosVinculados`/`valorEmCusto`/`ultimaEntrada`)
   * continuam calculados exatamente como hoje, nenhuma regra duplicada.
   */
  async listarTodosAtivos(): Promise<FornecedorRespostaPublica[]> {
    const [fornecedoresAtivos, produtosAtivos] = await Promise.all([
      this.fornecedoresRepository.encontrarTodosAtivos(),
      this.produtosRepository.listarTodosAtivos(),
    ]);
    const agregadosPorFornecedor = construirMapaDeAgregados(produtosAtivos);
    return fornecedoresAtivos.map((documento) =>
      this.paraRespostaPublica(documento, agregadosPorFornecedor.get(documento.id) ?? { produtosVinculados: 0, valorEmCusto: 0, ultimaEntrada: null }),
    );
  }

  async listar(query: ListarFornecedoresQueryDto): Promise<ResultadoListaFornecedores> {
    const [fornecedoresAtivos, produtosAtivos] = await Promise.all([
      this.fornecedoresRepository.encontrarTodosAtivos(query.busca),
      this.produtosRepository.listarTodosAtivos(),
    ]);

    const agregadosPorFornecedor = construirMapaDeAgregados(produtosAtivos);
    const itens: FornecedorComAgregado[] = fornecedoresAtivos.map((documento) => ({
      documento: documento.toJSON() as unknown as Fornecedor & { id: string },
      agregado: agregadosPorFornecedor.get(documento.id) ?? { produtosVinculados: 0, valorEmCusto: 0, ultimaEntrada: null },
    }));

    const selecao: SelecaoFacetas = {
      produtos: query.produtos,
      endereco: query.endereco,
      entrada: query.entrada,
      documento: query.documento,
    };

    const agora = new Date();
    const facets = this.calcularFacets(itens, selecao, agora);
    const filtrados = aplicarSelecao(itens, selecao, agora);
    const ordenados = ordenarItens(filtrados, query.ordenarPor, query.ordem);

    const total = ordenados.length;
    const totalPages = Math.max(1, Math.ceil(total / query.limit));
    const inicio = (query.page - 1) * query.limit;
    const pagina = ordenados.slice(inicio, inicio + query.limit);

    return {
      data: pagina.map((item) => ({ ...item.documento, ...item.agregado })),
      meta: { total, page: query.page, limit: query.limit, totalPages },
      facets,
    };
  }

  async obterPorId(id: string): Promise<FornecedorRespostaPublica> {
    const fornecedor = await this.fornecedoresRepository.encontrarPorIdOuFalhar(id);
    const agregado = await this.calcularAgregado(id);
    return this.paraRespostaPublica(fornecedor, agregado);
  }

  async atualizar(id: string, dto: AtualizarFornecedorDto, usuarioId: string | null): Promise<FornecedorRespostaPublica> {
    const telefoneNormalizado = normalizarTelefone(dto.telefone ?? "");
    await this.garantirTelefoneDisponivel(telefoneNormalizado, id);
    const endereco = this.normalizarEndereco(dto.endereco);

    const fornecedor = await this.fornecedoresRepository.salvarComRetentativa(id, (documento) => {
      documento.nome = dto.nome.trim();
      documento.foto = dto.foto?.trim() || null;
      documento.contato = dto.contato?.trim() ?? "";
      documento.telefone = dto.telefone?.trim() ?? "";
      documento.telefoneNormalizado = telefoneNormalizado;
      documento.email = dto.email?.trim() ?? "";
      documento.cnpj = dto.cnpj?.trim() ?? "";
      documento.instagram = dto.instagram?.trim() ?? "";
      documento.observacao = dto.observacao?.trim() ?? "";
      documento.endereco = endereco;
    });

    await this.registrarEvento(fornecedor.id, "fornecedor.atualizado", usuarioId, {});
    const agregado = await this.calcularAgregado(id);
    return this.paraRespostaPublica(fornecedor, agregado);
  }

  /**
   * Fornecedores com produtos ATIVOS vinculados não podem ser excluídos — o
   * histórico do produto (`produto.fornecedorId`) não pode ficar apontando
   * para um fornecedor que "desapareceu" sem aviso. Mesma regra já aplicada
   * pelo mock (`cadastros.mock.ts`), replicada aqui contra dados reais.
   */
  async excluir(id: string, usuarioId: string | null): Promise<void> {
    const fornecedor = await this.fornecedoresRepository.encontrarPorIdOuFalhar(id);
    const vinculados = await this.produtosRepository.listarTodosAtivos({ fornecedorId: id });
    if (vinculados.length > 0) {
      throw ApiException.validation("Fornecedor possui produtos vinculados.", [
        { field: "id", message: `${vinculados.length} produto(s) usam este fornecedor.` },
      ]);
    }
    fornecedor.excluidoEm = new Date();
    await fornecedor.save();
    await this.registrarEvento(fornecedor.id, "fornecedor.excluido", usuarioId, {});
  }

  /**
   * Produtos atualmente vinculados a este fornecedor. NÃO existe, no backend
   * real, um registro histórico de vínculos ENCERRADOS (isso exigiria que
   * Produtos passasse a auditar toda troca de `fornecedorId`, fora do escopo
   * desta etapa) — por isso `situacao` é sempre `"atual"` e `desvinculadoEm`
   * é sempre `null`. O mock antigo fabricava vínculos "históricos" apenas
   * para demonstrar a tela (comentário original do próprio seed); aqui só é
   * devolvido o que é real.
   */
  async listarHistorico(id: string): Promise<HistoricoFornecedorItem[]> {
    await this.fornecedoresRepository.encontrarPorIdOuFalhar(id);
    const produtos = await this.produtosRepository.listarTodosAtivos({ fornecedorId: id });
    return produtos
      .map((produto) => mapearHistoricoItem(produto))
      .sort((a, b) => b.vinculadoEm.getTime() - a.vinculadoEm.getTime());
  }

  private async calcularAgregado(fornecedorId: string): Promise<AgregadoFornecedor> {
    const produtos = await this.produtosRepository.listarTodosAtivos({ fornecedorId });
    return calcularAgregadoDeProdutos(produtos);
  }

  private calcularFacets(itens: FornecedorComAgregado[], selecao: SelecaoFacetas, agora: Date): ApiFacets {
    const contarValores = (chave: keyof typeof FACETAS_FORNECEDOR, valores: readonly string[]): { valor: string; count: number }[] => {
      const base = aplicarSelecao(itens, selecao, agora, FACETAS_FORNECEDOR[chave]);
      return valores.map((valor) => ({
        valor,
        count: base.filter((item) => condicaoValor(FACETAS_FORNECEDOR[chave], valor, item, agora)).length,
      }));
    };

    return {
      [FACETAS_FORNECEDOR.produtos]: contarValores("produtos", FAIXAS_PRODUTOS),
      [FACETAS_FORNECEDOR.endereco]: contarValores("endereco", VALORES_ENDERECO),
      [FACETAS_FORNECEDOR.entrada]: contarValores("entrada", JANELAS_ENTRADA),
      [FACETAS_FORNECEDOR.documento]: contarValores("documento", VALORES_DOCUMENTO),
    };
  }

  /** `{}` (todos os campos vazios) vira `null` — nunca persiste um objeto "vazio". */
  private normalizarEndereco(dto: EnderecoFornecedorDto | null | undefined): EnderecoFornecedorDados | null {
    const endereco: EnderecoFornecedorDados = {
      cep: dto?.cep?.trim() ?? "",
      logradouro: dto?.logradouro?.trim() ?? "",
      numero: dto?.numero?.trim() ?? "",
      complemento: dto?.complemento?.trim() ?? "",
      bairro: dto?.bairro?.trim() ?? "",
      cidade: dto?.cidade?.trim() ?? "",
      estado: dto?.estado?.trim().toUpperCase().slice(0, 2) ?? "",
    };
    return Object.values(endereco).some((campo) => campo.length > 0) ? endereco : null;
  }

  private async garantirTelefoneDisponivel(telefoneNormalizado: string, ignorarId?: string): Promise<void> {
    // Telefone vazio é permitido para qualquer quantidade de fornecedores (campo opcional aqui).
    if (!telefoneNormalizado) return;
    const existente = await this.fornecedoresRepository.encontrarPorTelefoneNormalizado(telefoneNormalizado, ignorarId);
    if (existente) {
      throw ApiException.conflict("Já existe um fornecedor cadastrado com este telefone.");
    }
  }

  private paraRespostaPublica(fornecedor: FornecedorDocument, agregado: AgregadoFornecedor): FornecedorRespostaPublica {
    const json = fornecedor.toJSON() as unknown as Omit<FornecedorRespostaPublica, "produtosVinculados" | "valorEmCusto" | "ultimaEntrada">;
    return { ...json, ...agregado };
  }

  private async registrarEvento(
    fornecedorId: string | Types.ObjectId,
    tipo: string,
    usuarioId: string | null,
    detalhes: Record<string, unknown>,
  ): Promise<void> {
    await this.eventoModel.create({ fornecedorId, tipo, usuarioId, detalhes });
  }
}

function calcularAgregadoDeProdutos(produtos: ProdutoDocument[]): AgregadoFornecedor {
  if (produtos.length === 0) return { produtosVinculados: 0, valorEmCusto: 0, ultimaEntrada: null };
  const valorEmCusto = produtos.reduce((soma, produto) => soma + produto.precoCusto * produto.quantidadeTotal, 0);
  const ultimaEntrada = produtos.reduce<Date>(
    (maior, produto) => (produto.criadoEm > maior ? produto.criadoEm : maior),
    produtos[0]!.criadoEm,
  );
  return {
    produtosVinculados: produtos.length,
    valorEmCusto: Math.round(valorEmCusto * 100) / 100,
    ultimaEntrada,
  };
}

/** Um `Map` só para não repetir `O(fornecedores × produtos)` — cada produto é visitado uma única vez. */
function construirMapaDeAgregados(produtos: ProdutoDocument[]): Map<string, AgregadoFornecedor> {
  const porFornecedor = new Map<string, ProdutoDocument[]>();
  for (const produto of produtos) {
    if (!produto.fornecedorId) continue;
    const lista = porFornecedor.get(produto.fornecedorId) ?? [];
    lista.push(produto);
    porFornecedor.set(produto.fornecedorId, lista);
  }
  const resultado = new Map<string, AgregadoFornecedor>();
  for (const [fornecedorId, lista] of porFornecedor) {
    resultado.set(fornecedorId, calcularAgregadoDeProdutos(lista));
  }
  return resultado;
}

function mapearHistoricoItem(produto: ProdutoDocument): HistoricoFornecedorItem {
  return {
    id: produto.id,
    produtoId: produto.id,
    produtoNome: produto.nome,
    codProduto: produto.codProduto,
    vinculadoEm: produto.criadoEm,
    desvinculadoEm: null,
    precoCusto: produto.precoCusto,
    precoVenda: precoEfetivo(produto),
    situacao: "atual",
  };
}

function ordenarItens(itens: FornecedorComAgregado[], campo: OrdenarFornecedorPor, ordem: Ordem): FornecedorComAgregado[] {
  const fator = ordem === "desc" ? -1 : 1;
  const porNome = (a: FornecedorComAgregado, b: FornecedorComAgregado) => a.documento.nome.localeCompare(b.documento.nome, "pt-BR");
  const tempo = (data: Date | null) => (data ? data.getTime() : 0);

  return [...itens].sort((a, b) => {
    switch (campo) {
      case "produtosVinculados":
        return (a.agregado.produtosVinculados - b.agregado.produtosVinculados) * fator || porNome(a, b);
      case "valorEmCusto":
        return (a.agregado.valorEmCusto - b.agregado.valorEmCusto) * fator || porNome(a, b);
      case "ultimaEntrada":
        return (tempo(a.agregado.ultimaEntrada) - tempo(b.agregado.ultimaEntrada)) * fator || porNome(a, b);
      case "criadoEm":
        return (new Date(a.documento.criadoEm).getTime() - new Date(b.documento.criadoEm).getTime()) * fator || porNome(a, b);
      default:
        return porNome(a, b) * fator;
    }
  });
}
