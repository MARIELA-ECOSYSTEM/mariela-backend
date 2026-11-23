import { FUSO_LOJA } from "../envios/envios-whatsapp.constants.js";

/**
 * Fase 22.8.9.10.3 — ano da campanha = ano CIVIL DO ENVIO no fuso da loja (decisão da autorização da fase): uma
 * mensagem enviada em dezembro de 2026 para um aniversário de janeiro pertence à campanha de 2026. O dia/mês do
 * aniversário nunca entra no cálculo. Fuso explícito (não depende do `TZ` do processo).
 */
export function anoCivilDoEnvio(agora: Date): number {
  const ano = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO_LOJA, year: "numeric" }).format(agora);
  return Number(ano);
}

/** Chave de deduplicação de campanha: uma mensagem por cliente, por campanha, por ano. */
export function chaveDeduplicacaoCampanha(tipo: "ANIVERSARIO", ano: number, clienteId: string): string {
  return `${tipo}:${ano}:${clienteId}`;
}
