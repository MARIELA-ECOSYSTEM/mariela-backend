import type { ModalidadeTarifa } from "./adquirentes.constants.js";

export interface TarifaConfigDados {
  modalidade: ModalidadeTarifa;
  parcelas: number;
  percentual: number;
}

/** Formato de entrada do repository — deliberadamente não reusa a classe `@Schema`. */
export interface DadosCriarAdquirente {
  nome: string;
  nomeNormalizado: string;
  ativo: boolean;
  observacao: string | null;
  tabelaTarifas: TarifaConfigDados[];
  excluidoEm: null;
}
