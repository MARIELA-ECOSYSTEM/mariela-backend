import type { FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Configuration, ReconciliacaoEstoqueConfig } from "../../config/configuration.js";
import { RECONCILIACAO_ESTOQUE_PADRAO } from "./vendas.constants.js";

/**
 * Fase 60.4.3.4.18 — token da configuração da reconciliação de estoque, injetado em `VendasService` e no
 * `ReconciliacaoEstoqueWorker`.
 *
 * Por que um provider próprio e não `ConfigService` direto: os testes de integração do domínio montam `VendasModule`
 * SEM `ConfigModule` (que é global só na aplicação). Sem `ConfigService`, valem os padrões de
 * `RECONCILIACAO_ESTOQUE_PADRAO` com o worker DESLIGADO — um teste nunca dispara ciclos em segundo plano sem pedir;
 * os testes do worker sobrescrevem este provider (`overrideProvider`) com valores próprios.
 */
export const RECONCILIACAO_ESTOQUE_CONFIG = Symbol("RECONCILIACAO_ESTOQUE_CONFIG");

export function configuracaoPadraoReconciliacao(habilitada: boolean): ReconciliacaoEstoqueConfig {
  return { habilitada, ...RECONCILIACAO_ESTOQUE_PADRAO };
}

export const reconciliacaoEstoqueConfigProvider: FactoryProvider<ReconciliacaoEstoqueConfig> = {
  provide: RECONCILIACAO_ESTOQUE_CONFIG,
  useFactory: (configService?: ConfigService<Configuration, true>): ReconciliacaoEstoqueConfig =>
    configService?.get("reconciliacaoEstoque", { infer: true }) ?? configuracaoPadraoReconciliacao(false),
  inject: [{ token: ConfigService, optional: true }],
};
