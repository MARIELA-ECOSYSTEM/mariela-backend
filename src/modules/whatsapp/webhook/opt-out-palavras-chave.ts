/**
 * Opt-out por PALAVRA-CHAVE em mensagem de texto recebida pelo webhook (autenticado) da Meta.
 *
 * Fase 22.8.9.10.5 — mecanismo criado com a lista VAZIA (decisão pendente).
 * Fase 22.8.9.10.7.1 — lista APROVADA: SAIR, PARAR, CANCELAR, STOP, UNSUBSCRIBE (o template `aniversario_v1` anuncia
 * "responda SAIR").
 *
 * Regra do reconhecimento — a MENSAGEM INTEIRA precisa ser a palavra-chave, depois de uma normalização conservadora:
 *   1. remove caracteres invisíveis (zero-width, BOM, marca de direção) e espaços nas pontas (inclusive quebras de
 *      linha e espaço não separável);
 *   2. remove acentos (NFKD + descarte das marcas combinantes) e ignora maiúsculas/minúsculas;
 *   3. tolera UMA pontuação final de afirmação: até três `.` ou `!` (ex.: "Sair.", "PARAR!!"). Interrogação NÃO
 *      (ex.: "Sair?" é pergunta, não pedido).
 * Nada de "contém": a palavra dentro de uma frase ("Quero saber como sair da promoção", "Não quero cancelar meu
 * pedido") nunca bloqueia, assim como palavra repetida, letras separadas, prefixos/sufixos ou outra pontuação.
 * Mensagens com mais de `TAMANHO_MAXIMO_MENSAGEM_OPT_OUT` caracteres nem são analisadas.
 */
export const PALAVRAS_CHAVE_OPT_OUT_APROVADAS: readonly string[] = Object.freeze(["SAIR", "PARAR", "CANCELAR", "STOP", "UNSUBSCRIBE"]);

/** Token de injeção da lista em uso (padrão = a lista aprovada; os testes podem injetar outras listas). */
export const PALAVRAS_CHAVE_OPT_OUT = Symbol("PALAVRAS_CHAVE_OPT_OUT");

/** Bem acima da maior palavra-chave com pontuação e espaços; texto longo nunca é um pedido de uma palavra só. */
export const TAMANHO_MAXIMO_MENSAGEM_OPT_OUT = 64;

const INVISIVEIS = /[​-‏⁠﻿‪-‮]/g;
const MARCAS_COMBINANTES = /\p{M}/gu;
const PONTUACAO_FINAL_ACEITA = /[.!]{1,3}$/;

/** Forma canônica para comparação; `null` = texto que nunca pode ser opt-out (vazio ou longo demais). */
export function normalizarTextoOptOut(texto: string): string | null {
  if (texto.length > TAMANHO_MAXIMO_MENSAGEM_OPT_OUT) return null;
  const semAcento = texto.replace(INVISIVEIS, "").trim().normalize("NFKD").replace(MARCAS_COMBINANTES, "").toUpperCase();
  const semPontuacaoFinal = semAcento.replace(PONTUACAO_FINAL_ACEITA, "").trim();
  return semPontuacaoFinal === "" ? null : semPontuacaoFinal;
}

export function criarReconhecedorOptOut(palavras: readonly string[]): (texto: string) => boolean {
  const aceitas = new Set(
    palavras.map((p) => normalizarTextoOptOut(p)).filter((p): p is string => p !== null && /^[A-Z]+$/.test(p)),
  );
  return (texto: string) => {
    if (aceitas.size === 0 || typeof texto !== "string") return false;
    const canonico = normalizarTextoOptOut(texto);
    return canonico !== null && aceitas.has(canonico);
  };
}
