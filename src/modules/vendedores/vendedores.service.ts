import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, ApiMeta } from "../../common/types/api-response.interface.js";
import { SequenciasService } from "../sequencias/sequencias.service.js";
import type { VendaDocument } from "../vendas/schemas/venda.schema.js";
import { VendasRepository } from "../vendas/vendas.repository.js";
import {
  ARGON2_MEMORY_COST,
  ARGON2_TIME_COST,
  CHAVE_SEQUENCIA_VENDEDOR,
  DIGITOS_CODIGO_VENDEDOR,
  PREFIXO_CODIGO_VENDEDOR,
  TELEFONE_DIGITOS_VALIDOS,
} from "./vendedores.constants.js";
import type { SelecaoFacetas } from "./vendedores-filtros.util.js";
import { VendedoresRepository } from "./vendedores.repository.js";
import type { AlterarStatusVendedorDto } from "./dto/alterar-status-vendedor.dto.js";
import type { AtualizarVendedorDto } from "./dto/atualizar-vendedor.dto.js";
import type { CriarVendedorDto } from "./dto/criar-vendedor.dto.js";
import type { ListarVendedoresQueryDto } from "./dto/listar-vendedores-query.dto.js";
import type { RedefinirSenhaVendedorDto } from "./dto/redefinir-senha-vendedor.dto.js";
import { EventoVendedor, type EventoVendedorDocument } from "./schemas/evento-vendedor.schema.js";
import type { VendedorDocument } from "./schemas/vendedor.schema.js";
import type { VendaResumoDoVendedor } from "./vendedores.types.js";
import { normalizarTelefone } from "./utils/normalizacao.util.js";

export interface ResultadoListaVendedores {
  data: VendedorDocument[];
  meta: ApiMeta;
  facets: ApiFacets;
}

/**
 * Hash argon2id de uma senha aleatória, calculado uma única vez no boot —
 * usado por `verificarSenha` para manter o tempo de resposta do login do
 * MARIELA PDV constante quando o código informado não existe (mesma defesa
 * contra canal lateral de temporização de `AuthService.login`, ver
 * `auth.service.ts`). Duplicado aqui de propósito, não importado do módulo
 * Auth: `Vendedor` não é `Usuario` (ver `role.type.ts`).
 */
const HASH_FANTASMA_VENDEDOR = Bun.password.hashSync(randomBytes(32).toString("hex"), {
  algorithm: "argon2id",
  memoryCost: ARGON2_MEMORY_COST,
  timeCost: ARGON2_TIME_COST,
});

@Injectable()
export class VendedoresService {
  constructor(
    private readonly vendedoresRepository: VendedoresRepository,
    private readonly sequenciasService: SequenciasService,
    private readonly vendasRepository: VendasRepository,
    @InjectModel(EventoVendedor.name) private readonly eventoModel: Model<EventoVendedorDocument>,
  ) {}

  async criar(dto: CriarVendedorDto, usuarioId: string | null): Promise<VendedorDocument> {
    const telefoneNormalizado = this.validarTelefone(dto.telefone);
    await this.garantirTelefoneDisponivel(telefoneNormalizado);

    if (!dto.senha) {
      throw ApiException.validation("Dados inválidos.", [
        { field: "senha", message: "Senha é obrigatória para novos vendedores." },
      ]);
    }
    const senhaHash = await this.hashSenha(dto.senha);

    const codigo = await this.sequenciasService.proximoCodigo(
      CHAVE_SEQUENCIA_VENDEDOR,
      PREFIXO_CODIGO_VENDEDOR,
      DIGITOS_CODIGO_VENDEDOR,
    );

    const vendedor = await this.vendedoresRepository.criar({
      codigo,
      nome: dto.nome.trim(),
      foto: dto.foto?.trim() || null,
      telefone: dto.telefone.trim(),
      telefoneNormalizado,
      dataNascimento: dto.dataNascimento ? new Date(dto.dataNascimento) : null,
      observacao: dto.observacao?.trim() ?? "",
      senhaHash,
      ativo: dto.ativo,
      vendas: 0,
      totalVendido: 0,
      ultimaVenda: null,
      excluidoEm: null,
    });

    await this.registrarEvento(vendedor.id, "vendedor.criado", usuarioId, { codigo });
    return vendedor;
  }

  /**
   * Contrato LEGADO do Backoffice (Etapa 17.2, mesmo padrão de
   * `ClientesService.listarTodosAtivos`/`FornecedoresService.listarTodosAtivos`/
   * `ColecoesService.listarTodosAtivos`/`CampanhasService.listarTodosAtivos`)
   * — `GET /vendedores` sem NENHUM parâmetro de paginação/busca/faceta espera
   * de volta a base INTEIRA de vendedores ativos, num array simples, nunca
   * truncada por um `limit` padrão. Reusa `encontrarTodosAtivos()` (já
   * existente, já usado pelo Dashboard) — nenhuma consulta nova, nenhuma
   * regra duplicada de `listar()`. Ver `VendedoresController.listar` para a
   * decisão de QUANDO usar este caminho vs. o paginado/facetado abaixo.
   */
  async listarTodosAtivos(): Promise<VendedorDocument[]> {
    return this.vendedoresRepository.encontrarTodosAtivos();
  }

  async listar(query: ListarVendedoresQueryDto): Promise<ResultadoListaVendedores> {
    const selecao: SelecaoFacetas = {
      status: query.status,
      vendas: query.vendas,
      valor: query.valor,
      ultimaVenda: query.ultimaVenda,
      nascimento: query.nascimento,
      observacao: query.observacao,
    };

    const { itens, total, facets } = await this.vendedoresRepository.listarComFacetas({
      busca: query.busca,
      ordenarPor: query.ordenarPor,
      ordem: query.ordem,
      selecao,
      page: query.page,
      limit: query.limit,
    });

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

  async obterPorId(id: string): Promise<VendedorDocument> {
    return this.vendedoresRepository.encontrarPorIdOuFalhar(id);
  }

  async atualizar(id: string, dto: AtualizarVendedorDto, usuarioId: string | null): Promise<VendedorDocument> {
    const telefoneNormalizado = this.validarTelefone(dto.telefone);
    await this.garantirTelefoneDisponivel(telefoneNormalizado, id);
    const senhaHash = dto.senha ? await this.hashSenha(dto.senha) : null;

    const vendedor = await this.vendedoresRepository.salvarComRetentativa(id, (documento) => {
      documento.nome = dto.nome.trim();
      documento.foto = dto.foto?.trim() || null;
      documento.telefone = dto.telefone.trim();
      documento.telefoneNormalizado = telefoneNormalizado;
      documento.dataNascimento = dto.dataNascimento ? new Date(dto.dataNascimento) : null;
      documento.observacao = dto.observacao?.trim() ?? "";
      documento.ativo = dto.ativo;
      if (senhaHash) documento.senhaHash = senhaHash;
    });

    await this.registrarEvento(vendedor.id, "vendedor.atualizado", usuarioId, {});
    return vendedor;
  }

  async alterarStatus(id: string, dto: AlterarStatusVendedorDto, usuarioId: string | null): Promise<VendedorDocument> {
    const vendedor = await this.vendedoresRepository.salvarComRetentativa(id, (documento) => {
      documento.ativo = dto.ativo;
    });
    await this.registrarEvento(vendedor.id, dto.ativo ? "vendedor.ativado" : "vendedor.inativado", usuarioId, {});
    return vendedor;
  }

  /** Redefinição dedicada de senha — nunca registra a senha (nem o hash) no evento de auditoria. */
  async redefinirSenha(id: string, dto: RedefinirSenhaVendedorDto, usuarioId: string | null): Promise<void> {
    const senhaHash = await this.hashSenha(dto.senha);
    const vendedor = await this.vendedoresRepository.salvarComRetentativa(id, (documento) => {
      documento.senhaHash = senhaHash;
    });
    await this.registrarEvento(vendedor.id, "vendedor.senha_redefinida", usuarioId, {});
  }

  /**
   * Soft delete incondicional — diferente de Fornecedores/Campanhas (que
   * bloqueiam exclusão quando há produtos vinculados), não há hoje nenhuma
   * dependência ativa de Vendedor a checar: o módulo de Vendas ainda não
   * existe. O soft delete por si só já preserva o histórico futuro (mesma
   * decisão de Cliente).
   */
  async excluir(id: string, usuarioId: string | null): Promise<void> {
    const vendedor = await this.vendedoresRepository.encontrarPorIdOuFalhar(id);
    vendedor.excluidoEm = new Date();
    await vendedor.save();
    await this.registrarEvento(vendedor.id, "vendedor.excluido", usuarioId, {});
  }

  /**
   * Histórico de vendas do vendedor (Etapa 17.2) — consulta real via
   * `VendasRepository.encontrarPorVendedorId` (Vendas não é alterado; só
   * consultado, mesmo padrão já usado pelo Dashboard e por
   * `ClientesService.listarVendas`). Inclui vendas CANCELADAS de propósito:
   * histórico nunca é apagado, a UI decide como exibir usando `status` —
   * mesma regra exata do histórico de compras do Cliente. `encontrarPorIdOuFalhar`
   * preserva o 404 já esperado pelo Backoffice quando o id é inválido ou o
   * vendedor está excluído (soft delete) — mesma checagem de sempre,
   * comportamento inalterado.
   */
  async listarVendas(id: string): Promise<{ data: VendaResumoDoVendedor[]; meta: ApiMeta }> {
    await this.vendedoresRepository.encontrarPorIdOuFalhar(id);
    const vendas = await this.vendasRepository.encontrarPorVendedorId(id);
    const data = vendas.map((venda) => this.paraResumoVenda(venda));
    return { data, meta: { total: data.length } };
  }

  /**
   * Projeta uma `Venda` para o formato `VendaResumo` do Backoffice — só os
   * campos que já fazem parte desse contrato (ver `vendedores.types.ts`).
   * Nunca inclui itens/pagamentos/parcelas/histórico/cancelamento (detalhe
   * pesado, fora do escopo de um resumo) nem campos internos do backend
   * (`idempotencyKey`, `criadoEm`, `atualizadoEm`) — mesmo mapeamento de
   * `ClientesService.paraResumoVenda`.
   */
  private paraResumoVenda(venda: VendaDocument): VendaResumoDoVendedor {
    return {
      id: venda.id,
      codigo: venda.codigo,
      numero: venda.numero,
      dataVenda: venda.dataVenda,
      clienteId: venda.clienteId,
      clienteNome: venda.clienteNome,
      vendedorId: venda.vendedorId,
      vendedorNome: venda.vendedorNome,
      caixaId: venda.caixaId,
      caixaCodigo: venda.caixaCodigo,
      totalItens: venda.totalItens,
      valorBruto: venda.valorBruto,
      descontoPromocional: venda.descontoPromocional,
      descontoVenda: venda.descontoVenda,
      descontoTotal: venda.descontoTotal,
      valorFinal: venda.valorFinal,
      valorPago: venda.valorPago,
      valorPendente: venda.valorPendente,
      valorDevolvido: venda.valorDevolvido,
      temPromocao: venda.temPromocao,
      temDesconto: venda.temDesconto,
      formaPagamento: venda.formaPagamento,
      totalParcelas: venda.totalParcelas,
      parcelasPagas: venda.parcelasPagas,
      status: venda.status,
    };
  }

  /**
   * Autenticação do MARIELA PDV — NÃO confundir com o login do ADMIN
   * (`AuthService.login`, módulo separado). Devolve o vendedor só quando
   * código+senha conferem E o vendedor está ativo e não excluído; qualquer
   * outro caso (código inexistente, senha errada, inativo, excluído) devolve
   * `null` uniformemente, para que o chamador (`PdvAuthService`) sempre lance
   * a mesma mensagem genérica de credenciais inválidas — nunca revelar qual
   * dessas condições falhou (mesmo padrão de `AuthService.login`).
   */
  async verificarSenha(codigo: string, senha: string): Promise<VendedorDocument | null> {
    const vendedor = await this.vendedoresRepository.encontrarPorCodigo(codigo);
    // Mesmo quando o código não existe, gasta o tempo de um argon2id real
    // contra um hash fantasma — ver `HASH_FANTASMA_VENDEDOR`.
    const senhaConfere = await Bun.password.verify(senha, vendedor?.senhaHash ?? HASH_FANTASMA_VENDEDOR);
    if (!vendedor || !senhaConfere || !vendedor.ativo || vendedor.excluidoEm) return null;
    return vendedor;
  }

  private validarTelefone(telefone: string): string {
    const normalizado = normalizarTelefone(telefone);
    if (!TELEFONE_DIGITOS_VALIDOS.includes(normalizado.length)) {
      throw ApiException.validation("Dados inválidos.", [
        { field: "telefone", message: "Informe DDD + número (10 ou 11 dígitos)." },
      ]);
    }
    return normalizado;
  }

  private async garantirTelefoneDisponivel(telefoneNormalizado: string, ignorarId?: string): Promise<void> {
    const existente = await this.vendedoresRepository.encontrarPorTelefoneNormalizado(telefoneNormalizado, ignorarId);
    if (existente) {
      throw ApiException.conflict("Já existe um vendedor cadastrado com este telefone.");
    }
  }

  private async hashSenha(senha: string): Promise<string> {
    return Bun.password.hash(senha, { algorithm: "argon2id", memoryCost: ARGON2_MEMORY_COST, timeCost: ARGON2_TIME_COST });
  }

  private async registrarEvento(
    vendedorId: string | Types.ObjectId,
    tipo: string,
    usuarioId: string | null,
    detalhes: Record<string, unknown>,
  ): Promise<void> {
    await this.eventoModel.create({ vendedorId, tipo, usuarioId, detalhes });
  }
}
