/**
 * Fase 59 — projeções de LEITURA do PDV sobre a configuração de pagamento.
 * O formato de `AdquirentePdv` é o que o MARIELA PDV já consome
 * (`mariela-pdv/src/types/adquirente.ts`, `PdvAdquirente`): o vendedor escolhe
 * a adquirente e o parcelamento autorizado; o frontend nunca calcula tarifa,
 * só exibe a configurada (a mesma que `POST /pdv/vendas` já devolve em
 * `pagamentos[].tarifaAplicada`).
 *
 * Omite tudo que é administrativo: `observacao` (anotação interna do
 * Backoffice), `nomeNormalizado`, `excluidoEm`, datas e os ids das linhas da
 * tabela de tarifas.
 */
export interface OpcaoParcelamentoPdv {
  parcelas: number;
  tarifaPercentual: number;
}

export interface ModalidadesAdquirentePdv {
  /** `null` = a adquirente não tem tarifa de débito configurada (débito indisponível nela). */
  debito: { tarifaPercentual: number } | null;
  /** `null` = nenhuma opção de crédito configurada. Opções em ordem crescente de parcelas. */
  credito: { opcoes: OpcaoParcelamentoPdv[] } | null;
}

export interface AdquirentePdv {
  id: string;
  nome: string;
  modalidades: ModalidadesAdquirentePdv;
}
