import type { ConfiguracoesService } from "../modules/configuracoes/configuracoes.service.js";

/**
 * Fase 54.2 — `ProdutosService.adicionarVariante`/`adicionarTamanho` passaram
 * a exigir que a cor/tamanho já exista em `configuracoes.cores`/`tamanhos`.
 * Muitos testes de OUTROS módulos (Vendas, Estoque, Clientes, Vendedores,
 * Dashboard, Relatórios, PDV) criam um produto+variante só como dado de
 * apoio — nunca testaram essa regra, não deveriam precisar conhecer sua
 * mensagem de erro. Este helper só garante o pré-requisito, idempotente
 * (ignora conflito se o valor já foi registrado por outro teste do mesmo
 * arquivo).
 */
export async function garantirItemConfiguracao(
  configuracoesService: ConfiguracoesService,
  lista: "cores" | "tamanhos",
  valor: string,
): Promise<void> {
  try {
    await configuracoesService.adicionarItem(lista, valor, null);
  } catch {
    // Já cadastrado (ou cadastrado por outra chamada concorrente/anterior do
    // mesmo arquivo de teste) — não é uma falha para quem só quer o pré-requisito.
  }
}
