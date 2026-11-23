import type { EstadoMensagemWhatsapp } from "./envios-whatsapp.constants.js";

/**
 * Fase 22.8.9.10.3 — máquina de estados de `mensagens_whatsapp` (funções PURAS; a persistência aplica cada transição
 * com escrita condicional pelo estado de origem). Especificação 22.8.9.10.2, itens A e D.
 *
 * Eventos de status externos (`sent`/`delivered`/`read`/`failed`) serão entregues pelo webhook da Fase 22.8.9.10.5;
 * a regra de aplicação já fica definida e testada aqui para que a fase do webhook só a conecte.
 */

/** Ordem de progressão. `indeterminada` empata com `enviando` (pode subir com uma confirmação tardia). */
export const ORDEM_ESTADO_WHATSAPP: Record<EstadoMensagemWhatsapp, number> = {
  pendente: 0,
  enviando: 1,
  indeterminada: 1,
  aceita: 2,
  entregue: 3,
  lida: 4,
  falha: 99,
};

export type EventoStatusExterno = "sent" | "delivered" | "read" | "failed";

export type ResultadoEventoStatus =
  | { tipo: "transicao"; para: EstadoMensagemWhatsapp }
  /** `failed` depois de `entregue`/`lida`: não regride — só registra a anomalia. */
  | { tipo: "anomalia" }
  /** Repetido, fora de ordem, ou sobre estado terminal: nada muda. */
  | { tipo: "ignorado" };

const ESTADO_DO_EVENTO: Record<Exclude<EventoStatusExterno, "failed">, EstadoMensagemWhatsapp> = {
  sent: "aceita",
  delivered: "entregue",
  read: "lida",
};

/**
 * Regra do webhook (tabela D da spec consolidada):
 * - progressão monotônica: só aplica um evento cuja ordem seja MAIOR que a atual (repetição e evento fora de ordem
 *   são ignorados; nunca há regressão);
 * - `read` implica `delivered` (o preenchimento de `entregueEm` é responsabilidade de quem persiste);
 * - `failed` só a partir de `enviando`/`indeterminada`/`aceita`; depois de `entregue`/`lida` é anomalia;
 * - nada sai de `falha` nem de `pendente` por evento externo (`pendente` nunca chegou ao provedor).
 */
export function aplicarEventoStatus(atual: EstadoMensagemWhatsapp, evento: EventoStatusExterno): ResultadoEventoStatus {
  if (atual === "falha" || atual === "pendente") return { tipo: "ignorado" };

  if (evento === "failed") {
    if (atual === "enviando" || atual === "indeterminada" || atual === "aceita") return { tipo: "transicao", para: "falha" };
    return { tipo: "anomalia" };
  }

  const destino = ESTADO_DO_EVENTO[evento];
  return ORDEM_ESTADO_WHATSAPP[destino] > ORDEM_ESTADO_WHATSAPP[atual] ? { tipo: "transicao", para: destino } : { tipo: "ignorado" };
}

/** Estados dos quais a liberação manual de reenvio é permitida (item B). */
export function podeLiberarReenvio(estado: EstadoMensagemWhatsapp): boolean {
  return estado === "falha" || estado === "indeterminada";
}
