import { Injectable } from "@nestjs/common";
import { CaixasService, type CaixaDetalheResposta } from "../caixas/caixas.service.js";
import type { AbrirCaixaPdvDto } from "./dto/abrir-caixa-pdv.dto.js";

/**
 * Camada de ADAPTAÇÃO/ORQUESTRAÇÃO entre o MARIELA PDV e o domínio de Caixa —
 * NÃO é uma segunda implementação financeira. Toda regra (caixa único, saldo,
 * resumo derivado das movimentações, código sequencial, auditoria) continua
 * inteiramente em `CaixasService`; este service só resolve a identidade do
 * responsável a partir do vendedor autenticado (nunca do cliente) e delega.
 */
@Injectable()
export class PdvCaixaService {
  constructor(private readonly caixasService: CaixasService) {}

  /**
   * Abre o Caixa Geral da Loja — `vendedorId` vem sempre do token
   * (`PdvJwtAuthGuard`/`@VendedorPdv()`), nunca do corpo da requisição.
   * Etapa 18.2: o Caixa NÃO tem mais vínculo de vendedor no seu domínio
   * (`CaixasService.abrir` ignora `responsavelId` por completo) — o
   * vendedor autenticado só identifica o AUTOR do evento de auditoria
   * `caixa.aberto` (nunca persistido no documento financeiro). `CaixasService.abrir`
   * já garante "só um caixa aberto" via o índice único parcial do MongoDB —
   * nada disso é repetido aqui.
   */
  async abrir(vendedorId: string, dto: AbrirCaixaPdvDto): Promise<CaixaDetalheResposta> {
    return this.caixasService.abrir({ valorInicial: dto.valorInicial, observacao: dto.observacao }, vendedorId);
  }

  /** Caixa aberto atual (compartilhado por todos os vendedores) — `null` quando nenhum está aberto, nunca 404. */
  async atual(): Promise<CaixaDetalheResposta | null> {
    return this.caixasService.obterAtual();
  }
}
