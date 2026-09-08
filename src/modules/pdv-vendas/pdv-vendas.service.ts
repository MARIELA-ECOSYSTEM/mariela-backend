import { Injectable } from "@nestjs/common";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { CaixasService } from "../caixas/caixas.service.js";
import type { VendaDocument } from "../vendas/schemas/venda.schema.js";
import type { DadosCriarVenda } from "../vendas/vendas.types.js";
import { VendasService } from "../vendas/vendas.service.js";
import type { CriarVendaPdvDto } from "./dto/criar-venda-pdv.dto.js";

/**
 * Camada de ADAPTAÇÃO/ORQUESTRAÇÃO entre o MARIELA PDV e o domínio de
 * Vendas — NÃO é uma segunda implementação. Toda regra financeira (preço
 * efetivo, desconto, baixa de estoque, lançamento no caixa, agregados de
 * cliente/vendedor, idempotência, auditoria) continua inteiramente em
 * `VendasService.criar` (inalterado nesta etapa, exceto pelo ajuste de
 * concorrência de idempotência descrito no relatório). Este service só
 * resolve `vendedorId`/`caixaId` a partir do contexto autenticado — nunca do
 * payload — e delega.
 */
@Injectable()
export class PdvVendasService {
  constructor(
    private readonly vendasService: VendasService,
    private readonly caixasService: CaixasService,
  ) {}

  async criar(vendedorId: string, dto: CriarVendaPdvDto): Promise<VendaDocument> {
    const caixaAtual = await this.caixasService.obterAtual();
    if (!caixaAtual) {
      throw ApiException.validation("Nenhum caixa aberto. Abra o caixa antes de vender.");
    }

    this.garantirItensSemDuplicidade(dto.itens);

    const dados: DadosCriarVenda = {
      clienteId: dto.clienteId ?? null,
      vendedorId,
      caixaId: caixaAtual.id,
      // `desconto`/`descontoVenda` são repassados tal como vieram (nunca
      // reconstruídos campo a campo): `DadosCriarVenda`/`ItemVendaSolicitado`
      // já aceitam tanto o formato novo (`{tipo, valor}`) quanto, no caso de
      // `descontoVenda`, um `number` puro — reconstruir o objeto aqui
      // quebraria essa retrocompatibilidade quando o chamador (ex.: um teste
      // que invoca `PdvVendasService.criar` diretamente, sem passar pelo
      // `ValidationPipe`/`@Transform` do DTO) ainda envia um `number` cru.
      itens: dto.itens.map((item) => ({
        produtoId: item.produtoId,
        varianteId: item.varianteId,
        tamanhoId: item.tamanhoId,
        quantidade: item.quantidade,
        desconto: item.desconto,
      })),
      descontoVenda: dto.descontoVenda,
      pagamentos: dto.pagamentos.map((pagamento) => ({
        forma: pagamento.forma,
        valor: pagamento.valor,
        parcelas: pagamento.parcelas,
        observacao: pagamento.observacao,
      })),
      totalParcelas: dto.totalParcelas,
      observacao: dto.observacao,
      idempotencyKey: dto.idempotencyKey,
    };

    // `usuarioId: null` — quem criou não é um `Usuario` (ADMIN) do
    // Backoffice; o vendedor responsável já está em `dados.vendedorId` e é
    // gravado normalmente na venda e no evento de auditoria por
    // `VendasService.criar` (mesmo padrão já usado pela integração de Caixa
    // com o PDV, ver `PdvCaixaService`).
    return this.vendasService.criar(dados, null);
  }

  /**
   * Rejeita duas linhas do carrinho apontando para o MESMO estoque
   * (produto+variante+tamanho) — decisão explícita (ver relatório, seção
   * "Itens duplicados"): `VendasService.criar` não mescla itens repetidos, e
   * mesclar quantidades aqui seria recalcular uma regra que pertence ao
   * domínio de Vendas. Rejeitar de forma clara e antecipada, em vez de deixar
   * a baixa de estoque item-a-item falhar no meio (2ª linha vendo o saldo já
   * reduzido pela 1ª) e disparar o rollback compensatório por um motivo que,
   * na prática, é erro de request, não falta de estoque.
   */
  private garantirItensSemDuplicidade(itens: { produtoId: string; varianteId: string; tamanhoId: string }[]): void {
    const vistos = new Set<string>();
    for (const item of itens) {
      const chave = `${item.produtoId}:${item.varianteId}:${item.tamanhoId}`;
      if (vistos.has(chave)) {
        throw ApiException.validation("Dados inválidos.", [
          { field: "itens", message: "Item duplicado no carrinho: combine a quantidade em uma única linha por produto/variante/tamanho." },
        ]);
      }
      vistos.add(chave);
    }
  }
}
