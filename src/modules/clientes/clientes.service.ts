import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, ApiMeta } from "../../common/types/api-response.interface.js";
import { SequenciasService } from "../sequencias/sequencias.service.js";
import { CHAVE_SEQUENCIA_CLIENTE, DIGITOS_CODIGO_CLIENTE, PREFIXO_CODIGO_CLIENTE, TELEFONE_DIGITOS_VALIDOS } from "./clientes.constants.js";
import type { SelecaoFacetas } from "./clientes-filtros.util.js";
import { ClientesRepository } from "./clientes.repository.js";
import type { AtualizarClienteDto } from "./dto/atualizar-cliente.dto.js";
import type { CriarClienteDto } from "./dto/criar-cliente.dto.js";
import type { ListarClientesQueryDto } from "./dto/listar-clientes-query.dto.js";
import { EventoCliente, type EventoClienteDocument } from "./schemas/evento-cliente.schema.js";
import type { ClienteDocument } from "./schemas/cliente.schema.js";
import { normalizarTelefone } from "./utils/normalizacao.util.js";

export interface ResultadoListaClientes {
  data: ClienteDocument[];
  meta: ApiMeta;
  facets: ApiFacets;
}

@Injectable()
export class ClientesService {
  constructor(
    private readonly clientesRepository: ClientesRepository,
    private readonly sequenciasService: SequenciasService,
    @InjectModel(EventoCliente.name) private readonly eventoModel: Model<EventoClienteDocument>,
  ) {}

  async criar(dto: CriarClienteDto, usuarioId: string | null): Promise<ClienteDocument> {
    const telefoneNormalizado = this.validarTelefone(dto.telefone);
    await this.garantirTelefoneDisponivel(telefoneNormalizado);

    const codigo = await this.sequenciasService.proximoCodigo(
      CHAVE_SEQUENCIA_CLIENTE,
      PREFIXO_CODIGO_CLIENTE,
      DIGITOS_CODIGO_CLIENTE,
    );

    const cliente = await this.clientesRepository.criar({
      codigo,
      nome: dto.nome.trim(),
      foto: dto.foto?.trim() || null,
      telefone: dto.telefone.trim(),
      telefoneNormalizado,
      dataNascimento: dto.dataNascimento ? new Date(dto.dataNascimento) : null,
      observacao: dto.observacao?.trim() ?? "",
      compras: 0,
      totalComprado: 0,
      ultimaCompra: null,
      excluidoEm: null,
    });

    await this.registrarEvento(cliente.id, "cliente.criado", usuarioId, { codigo });
    return cliente;
  }

  async listar(query: ListarClientesQueryDto): Promise<ResultadoListaClientes> {
    const selecao: SelecaoFacetas = {
      recencia: query.recencia,
      historico: query.historico,
      aniversario: query.aniversario,
      observacao: query.observacao,
    };

    const { itens, total, facets } = await this.clientesRepository.listarComFacetas({
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

  async obterPorId(id: string): Promise<ClienteDocument> {
    return this.clientesRepository.encontrarPorIdOuFalhar(id);
  }

  async atualizar(id: string, dto: AtualizarClienteDto, usuarioId: string | null): Promise<ClienteDocument> {
    const telefoneNormalizado = this.validarTelefone(dto.telefone);
    await this.garantirTelefoneDisponivel(telefoneNormalizado, id);

    const cliente = await this.clientesRepository.salvarComRetentativa(id, (documento) => {
      documento.nome = dto.nome.trim();
      documento.foto = dto.foto?.trim() || null;
      documento.telefone = dto.telefone.trim();
      documento.telefoneNormalizado = telefoneNormalizado;
      documento.dataNascimento = dto.dataNascimento ? new Date(dto.dataNascimento) : null;
      documento.observacao = dto.observacao?.trim() ?? "";
    });

    await this.registrarEvento(cliente.id, "cliente.atualizado", usuarioId, {});
    return cliente;
  }

  async excluir(id: string, usuarioId: string | null): Promise<void> {
    const cliente = await this.clientesRepository.encontrarPorIdOuFalhar(id);
    cliente.excluidoEm = new Date();
    await cliente.save();
    await this.registrarEvento(cliente.id, "cliente.excluido", usuarioId, {});
  }

  /**
   * Histórico de compras do cliente. O módulo de Vendas ainda não existe
   * nesta etapa — por isso sempre devolve uma lista vazia (nunca inventa
   * dados de venda). Continua validando que o cliente existe, para preservar
   * o 404 já esperado pelo Backoffice quando o id é inválido ou excluído.
   */
  async listarVendas(id: string): Promise<{ data: never[]; meta: ApiMeta }> {
    await this.clientesRepository.encontrarPorIdOuFalhar(id);
    return { data: [], meta: { total: 0 } };
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
    const existente = await this.clientesRepository.encontrarPorTelefoneNormalizado(telefoneNormalizado, ignorarId);
    if (existente) {
      throw ApiException.conflict("Já existe um cliente cadastrado com este telefone.");
    }
  }

  private async registrarEvento(
    clienteId: string | Types.ObjectId,
    tipo: string,
    usuarioId: string | null,
    detalhes: Record<string, unknown>,
  ): Promise<void> {
    await this.eventoModel.create({ clienteId, tipo, usuarioId, detalhes });
  }
}
