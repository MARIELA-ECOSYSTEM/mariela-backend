import { JANELA_ATENDIMENTO_MS, MARGEM_SEGURANCA_JANELA_MS } from "../envios/envios-whatsapp.constants.js";

/**
 * Fase 22.8.9.10.7.4 — regra PURA da janela de atendimento de 24 h (texto livre na Cloud API).
 *
 * Início = instante da mensagem informado pela Meta, limitado ao momento em que o BACKEND a recebeu: um timestamp no
 * futuro (diferença de relógio) nunca estende a janela, e uma reentrega tardia do mesmo evento usa o instante
 * ORIGINAL da mensagem (não o da reentrega). O fim é comparado SEMPRE com o relógio do backend, com margem de segurança.
 */
export function inicioDaJanela(mensagemEm: Date, recebidaPeloBackendEm: Date): Date {
  return mensagemEm.getTime() <= recebidaPeloBackendEm.getTime() ? mensagemEm : recebidaPeloBackendEm;
}

/** Até quando o texto livre pode ser enviado (já descontada a margem de segurança). */
export function fimDaJanela(ultimaMensagemEm: Date): Date {
  return new Date(ultimaMensagemEm.getTime() + JANELA_ATENDIMENTO_MS - MARGEM_SEGURANCA_JANELA_MS);
}

export type SituacaoJanela =
  | { tipo: "sem_mensagem" }
  | { tipo: "aberta"; ultimaMensagemEm: Date; expiraEm: Date }
  | { tipo: "expirada"; ultimaMensagemEm: Date; expiraEm: Date };

/** Sem registro = sem evidência = fechada. Nunca presume janela aberta. */
export function avaliarJanela(ultimaMensagemEm: Date | null, agora: Date): SituacaoJanela {
  if (!ultimaMensagemEm) return { tipo: "sem_mensagem" };
  const expiraEm = fimDaJanela(ultimaMensagemEm);
  return agora.getTime() < expiraEm.getTime() ? { tipo: "aberta", ultimaMensagemEm, expiraEm } : { tipo: "expirada", ultimaMensagemEm, expiraEm };
}

/** Uma mensagem só vale como evidência se ainda pode abrir a janela agora (as antigas não geram registro). */
export function mensagemAindaAbreJanela(inicio: Date, agora: Date): boolean {
  return avaliarJanela(inicio, agora).tipo === "aberta";
}
