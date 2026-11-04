import { Injectable } from "@nestjs/common";
import { AdquirentesService, type AdquirenteRespostaPublica } from "../adquirentes/adquirentes.service.js";
import { ConfiguracoesService } from "../configuracoes/configuracoes.service.js";
import type { AdquirentePdv } from "./pdv-pagamentos.types.js";

/**
 * Fase 59 — camada de ADAPTAÇÃO entre o MARIELA PDV e a configuração de
 * pagamento (mesmo papel de `PdvClientesService`): NÃO é uma segunda fonte de
 * regras. As formas vêm de `configuracoes.formasPagamento` e as adquirentes de
 * `AdquirentesService` — exatamente o que `VendasService` valida ao criar a
 * venda. Somente leitura: nada aqui cria, altera ou exclui configuração.
 */
@Injectable()
export class PdvPagamentosService {
  constructor(
    private readonly configuracoesService: ConfiguracoesService,
    private readonly adquirentesService: AdquirentesService,
  ) {}

  /** Formas de pagamento aceitas em `POST /pdv/vendas` (`pagamentos[].forma`), na ordem do cadastro. */
  async listarFormas(): Promise<string[]> {
    return this.configuracoesService.listarFormasPagamento();
  }

  /**
   * Adquirentes ativas com ao menos uma tarifa configurada — sem tarifa, nenhum
   * pagamento no débito/crédito com ela passaria em `VendasService` (a tarifa
   * de (modalidade, parcelas) é obrigatória), então ela não é oferecida ao vendedor.
   */
  async listarAdquirentes(): Promise<AdquirentePdv[]> {
    const ativas = await this.adquirentesService.listarAtivasParaVenda();
    return ativas.map(paraAdquirentePdv).filter((adquirente) => adquirente.modalidades.debito !== null || adquirente.modalidades.credito !== null);
  }
}

function paraAdquirentePdv(adquirente: AdquirenteRespostaPublica): AdquirentePdv {
  // Débito só existe em 1 parcela (regra de `AdquirentesService.validarTabelaTarifas`).
  const debito = adquirente.tabelaTarifas.find((tarifa) => tarifa.modalidade === "debito" && tarifa.parcelas === 1);
  const opcoesCredito = adquirente.tabelaTarifas
    .filter((tarifa) => tarifa.modalidade === "credito")
    .map((tarifa) => ({ parcelas: tarifa.parcelas, tarifaPercentual: tarifa.percentual }))
    .sort((a, b) => a.parcelas - b.parcelas);
  return {
    id: adquirente.id,
    nome: adquirente.nome,
    modalidades: {
      debito: debito ? { tarifaPercentual: debito.percentual } : null,
      credito: opcoesCredito.length > 0 ? { opcoes: opcoesCredito } : null,
    },
  };
}
