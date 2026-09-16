/** Espelha `Integracao`/`StatusIntegracao` (`src/types/integracao.ts` do Backoffice). */
export type StatusIntegracao = "conectada" | "disponivel" | "planejada";

export interface Integracao {
  id: string;
  nome: string;
  categoria: string;
  descricao: string;
  status: StatusIntegracao;
  observacao: string;
}
