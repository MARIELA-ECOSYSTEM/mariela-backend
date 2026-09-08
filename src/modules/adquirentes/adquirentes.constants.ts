export const MODALIDADES_TARIFA = ["debito", "credito"] as const;
export type ModalidadeTarifa = (typeof MODALIDADES_TARIFA)[number];

export const PARCELAS_MINIMO = 1;
export const PARCELAS_MAXIMO_CREDITO = 24;

export const PAGINA_PADRAO = 1;
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;
