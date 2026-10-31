import type { ConfiguracoesService } from "../modules/configuracoes/configuracoes.service.js";

/**
 * Fase 54.2 — `ProdutosService.adicionarVariante`/`adicionarTamanho` passaram
 * a exigir que a cor/tamanho já exista em `configuracoes.cores`/`tamanhos`.
 * Fase 55.1 — mesma exigência estendida a `criar()`/`atualizar()` de produto
 * contra `configuracoes.categorias`. Fase 55.2 — mesma exigência estendida a
 * `VendasService.criar/baixarParcela/receberPagamento` e
 * `CaixasService.registrarMovimento` contra `configuracoes.formasPagamento`.
 * Muitos testes de OUTROS módulos (Vendas, Estoque, Clientes, Vendedores,
 * Dashboard, Relatórios, PDV, Caixas) criam produto+variante ou venda só
 * como dado de apoio — nunca testaram essas regras, não deveriam precisar
 * conhecer suas mensagens de erro. Este helper só garante o pré-requisito,
 * idempotente (ignora conflito se o valor já foi registrado por outro teste
 * do mesmo arquivo).
 */
export async function garantirItemConfiguracao(
  configuracoesService: ConfiguracoesService,
  lista: "cores" | "tamanhos" | "categorias" | "formasPagamento",
  valor: string,
): Promise<void> {
  try {
    await configuracoesService.adicionarItem(lista, valor, null);
  } catch {
    // Já cadastrado (ou cadastrado por outra chamada concorrente/anterior do
    // mesmo arquivo de teste) — não é uma falha para quem só quer o pré-requisito.
  }
}
