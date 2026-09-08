import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiMeta } from "../../common/types/api-response.interface.js";
import { AdquirentesRepository } from "./adquirentes.repository.js";
import type { ModalidadeTarifa } from "./adquirentes.constants.js";
import type { AtualizarAdquirenteDto } from "./dto/atualizar-adquirente.dto.js";
import type { CriarAdquirenteDto } from "./dto/criar-adquirente.dto.js";
import type { ListarAdquirentesQueryDto } from "./dto/listar-adquirentes-query.dto.js";
import type { TarifaConfigDto } from "./dto/tarifa-config.dto.js";
import { EventoAdquirente, type EventoAdquirenteDocument } from "./schemas/evento-adquirente.schema.js";
import type { AdquirenteDocument } from "./schemas/adquirente.schema.js";
import type { TarifaConfigDados } from "./adquirentes.types.js";
import { normalizarNomeAdquirente } from "./utils/normalizar-nome.util.js";

export interface TarifaConfigRespostaPublica extends TarifaConfigDados {
  id: string;
}

export interface AdquirenteRespostaPublica {
  id: string;
  nome: string;
  ativo: boolean;
  observacao: string | null;
  tabelaTarifas: TarifaConfigRespostaPublica[];
  excluidoEm: Date | null;
  criadoEm: Date;
  atualizadoEm: Date;
}

export interface ResultadoListaAdquirentes {
  data: AdquirenteRespostaPublica[];
  meta: ApiMeta;
}

/**
 * CRUD administrativo de Adquirentes. Responsabilidade estritamente limitada
 * a esta fundação (nome, status, observação, tabela de tarifas) — a
 * APLICAÇÃO de uma tarifa numa venda (resolver `adquirenteId` + modalidade +
 * parcelas → percentual vigente) é responsabilidade de uma etapa futura, que
 * consumirá este service/repository sem alterá-lo (mesmo princípio de
 * `VendasService` consumindo `CaixasService`).
 */
@Injectable()
export class AdquirentesService {
  constructor(
    private readonly adquirentesRepository: AdquirentesRepository,
    @InjectModel(EventoAdquirente.name) private readonly eventoModel: Model<EventoAdquirenteDocument>,
  ) {}

  async criar(dto: CriarAdquirenteDto, usuarioId: string | null): Promise<AdquirenteRespostaPublica> {
    const nomeNormalizado = normalizarNomeAdquirente(dto.nome);
    await this.garantirNomeDisponivel(nomeNormalizado);
    const tabelaTarifas = this.validarTabelaTarifas(dto.tabelaTarifas ?? []);

    const adquirente = await this.adquirentesRepository.criar({
      nome: dto.nome.trim(),
      nomeNormalizado,
      ativo: dto.ativo ?? true,
      observacao: dto.observacao?.trim() || null,
      tabelaTarifas,
      excluidoEm: null,
    });

    await this.registrarEvento(adquirente.id, "adquirente.criada", usuarioId, {});
    return this.paraRespostaPublica(adquirente);
  }

  async listar(query: ListarAdquirentesQueryDto): Promise<ResultadoListaAdquirentes> {
    const { itens, total } = await this.adquirentesRepository.listarAtivas(query.busca, query.page, query.limit);
    return {
      data: itens.map((item) => this.paraRespostaPublica(item)),
      meta: { total, page: query.page, limit: query.limit, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
    };
  }

  async obterPorId(id: string): Promise<AdquirenteRespostaPublica> {
    const adquirente = await this.adquirentesRepository.encontrarPorIdOuFalhar(id);
    return this.paraRespostaPublica(adquirente);
  }

  /**
   * PARCIAL de propósito (`PATCH`): só altera o que veio no DTO. Diferente da
   * maioria dos módulos administrativos (`PUT` de substituição completa) —
   * decisão explícita do contrato desta etapa, não uma inconsistência.
   */
  async atualizar(id: string, dto: AtualizarAdquirenteDto, usuarioId: string | null): Promise<AdquirenteRespostaPublica> {
    let nomeNormalizado: string | undefined;
    if (dto.nome !== undefined) {
      nomeNormalizado = normalizarNomeAdquirente(dto.nome);
      await this.garantirNomeDisponivel(nomeNormalizado, id);
    }
    const tabelaTarifas = dto.tabelaTarifas !== undefined ? this.validarTabelaTarifas(dto.tabelaTarifas) : undefined;

    const adquirente = await this.adquirentesRepository.salvarComRetentativa(id, (documento) => {
      if (dto.nome !== undefined) {
        documento.nome = dto.nome.trim();
        documento.nomeNormalizado = nomeNormalizado!;
      }
      if (dto.ativo !== undefined) documento.ativo = dto.ativo;
      if (dto.observacao !== undefined) documento.observacao = dto.observacao?.trim() || null;
      if (tabelaTarifas !== undefined) {
        documento.tabelaTarifas = tabelaTarifas as never;
      }
    });

    await this.registrarEvento(adquirente.id, "adquirente.atualizada", usuarioId, {});
    return this.paraRespostaPublica(adquirente);
  }

  /**
   * Soft delete — nunca apaga fisicamente (a adquirente pode já estar
   * referenciada em vendas históricas numa etapa futura). Uma adquirente já
   * excluída não é encontrada por `encontrarPorIdOuFalhar` (filtra
   * `excluidoEm: null`), então uma segunda tentativa de exclusão já recebe
   * 404 — mesmo comportamento de todos os outros módulos administrativos
   * para "registro não existe (mais)", sem necessidade de um erro dedicado.
   */
  async excluir(id: string, usuarioId: string | null): Promise<void> {
    const adquirente = await this.adquirentesRepository.encontrarPorIdOuFalhar(id);
    adquirente.excluidoEm = new Date();
    await adquirente.save();
    await this.registrarEvento(adquirente.id, "adquirente.excluida", usuarioId, {});
  }

  /**
   * Regras da seção 4/5 do pedido: débito só aceita 1 parcela; crédito aceita
   * 1–24 (o intervalo genérico já é validado pelo DTO); percentual >= 0 (já
   * validado pelo DTO); e nenhuma combinação (modalidade, parcelas) pode se
   * repetir dentro da mesma tabela — validado aqui porque é uma regra que
   * cruza os itens do próprio array embutido, não uma regra de índice Mongo.
   */
  private validarTabelaTarifas(tarifas: TarifaConfigDto[]): TarifaConfigDados[] {
    const vistos = new Set<string>();
    for (const tarifa of tarifas) {
      if (tarifa.modalidade === "debito" && tarifa.parcelas !== 1) {
        throw ApiException.validation("Dados inválidos.", [
          { field: "tabelaTarifas", message: "Débito só pode ter 1 parcela." },
        ]);
      }

      const chave = `${tarifa.modalidade}:${tarifa.parcelas}`;
      if (vistos.has(chave)) {
        throw ApiException.validation("Dados inválidos.", [
          {
            field: "tabelaTarifas",
            message: `Já existe uma tarifa para ${tarifa.modalidade === "credito" ? "crédito" : "débito"} em ${tarifa.parcelas}x.`,
          },
        ]);
      }
      vistos.add(chave);
    }

    return tarifas.map(
      (tarifa): TarifaConfigDados => ({
        modalidade: tarifa.modalidade as ModalidadeTarifa,
        parcelas: tarifa.parcelas,
        percentual: tarifa.percentual,
      }),
    );
  }

  private async garantirNomeDisponivel(nomeNormalizado: string, ignorarId?: string): Promise<void> {
    const existente = await this.adquirentesRepository.encontrarPorNomeNormalizado(nomeNormalizado, ignorarId);
    if (existente) {
      throw ApiException.conflict("Já existe uma adquirente cadastrada com este nome.");
    }
  }

  private paraRespostaPublica(adquirente: AdquirenteDocument): AdquirenteRespostaPublica {
    return adquirente.toJSON() as unknown as AdquirenteRespostaPublica;
  }

  private async registrarEvento(
    adquirenteId: string | Types.ObjectId,
    tipo: string,
    usuarioId: string | null,
    detalhes: Record<string, unknown>,
  ): Promise<void> {
    await this.eventoModel.create({ adquirenteId, tipo, usuarioId, detalhes });
  }
}
