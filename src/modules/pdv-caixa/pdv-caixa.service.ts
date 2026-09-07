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
   * Abre o caixa com o VENDEDOR AUTENTICADO como responsável — `vendedorId`
   * vem sempre do token (`PdvJwtAuthGuard`/`@VendedorPdv()`), nunca do corpo
   * da requisição. `CaixasService.abrir` já valida o vendedor
   * (`resolverResponsavel` → `VendedoresRepository.encontrarPorIdOuFalhar`),
   * já garante "só um caixa aberto" via o índice único parcial do MongoDB, e
   * já registra o evento de auditoria `caixa.aberto` — nada disso é repetido
   * aqui. `usuarioId: null` porque nenhum `Usuario` (ADMIN) administrou esta
   * abertura — mesmo padrão já usado por `VendasService.criar` para
   * operações originadas fora do Backoffice.
   */
  async abrir(vendedorId: string, dto: AbrirCaixaPdvDto): Promise<CaixaDetalheResposta> {
    return this.caixasService.abrir({ responsavelId: vendedorId, valorInicial: dto.valorInicial, observacao: dto.observacao }, null);
  }

  /** Caixa aberto atual (compartilhado por todos os vendedores) — `null` quando nenhum está aberto, nunca 404. */
  async atual(): Promise<CaixaDetalheResposta | null> {
    return this.caixasService.obterAtual();
  }
}
