/**
 * Fase 22.8.9.10.5 — opt-out por PALAVRA-CHAVE em mensagem de texto recebida.
 *
 * ⚠️ DECISÃO PENDENTE (não inventar regra operacional): o conjunto de palavras-chave e as variações aceitas ainda não
 * foram aprovados. O único indício é o texto RASCUNHO do template `aniversario_v1` ("responda SAIR"), ainda não
 * revisado nem submetido à Meta. Por isso a lista aprovada está VAZIA: nenhuma mensagem recebida gera bloqueio por
 * palavra-chave até a aprovação explícita.
 *
 * Regra do reconhecimento (quando houver lista): a mensagem INTEIRA, sem espaços nas pontas, precisa ser IGUAL a uma
 * entrada da lista. Sem "contém", sem ignorar maiúsculas/acentos/pontuação: cada variação aceita precisa constar
 * explicitamente da lista (ex.: "SAIR", "Sair", "sair").
 */
export const PALAVRAS_CHAVE_OPT_OUT_APROVADAS: readonly string[] = Object.freeze([]);

/** Token de injeção da lista em uso (padrão = a lista aprovada; os testes injetam listas próprias). */
export const PALAVRAS_CHAVE_OPT_OUT = Symbol("PALAVRAS_CHAVE_OPT_OUT");

export function criarReconhecedorOptOut(palavras: readonly string[]): (texto: string) => boolean {
  const aceitas = new Set(palavras.map((p) => p.trim()).filter((p) => p !== ""));
  return (texto: string) => aceitas.size > 0 && aceitas.has(texto.trim());
}
