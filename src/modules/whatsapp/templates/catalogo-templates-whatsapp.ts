import type { OrigemMensagemWhatsapp } from "../envios/envios-whatsapp.constants.js";

/**
 * Fase 22.8.9.10.3 — catálogo VERSIONADO de templates de WhatsApp (Cloud API). É a única lista de modelos que o
 * backend aceita enviar; o Backoffice escolhe pela `chave` interna e NUNCA envia texto livre nem valores de
 * parâmetros — os parâmetros são derivados do cadastro (`origem`).
 *
 * Estar no catálogo NÃO significa estar aprovado: a aprovação é sempre confirmada no provedor
 * (`TemplatesWhatsappService`), com cache curto, e o envio é bloqueado se ela não puder ser confirmada.
 *
 * ⚠️ Os textos abaixo são RASCUNHOS a serem revisados e submetidos à Meta pela loja (decisão pendente, spec
 * 22.8.9.10.2 §16). `previa` precisa ser IDÊNTICA ao corpo submetido; mudar o texto exige nova versão (`_v2`).
 *
 * ⚠️ Fase 22.8.9.10.7.2 — o MARIELA NÃO reconhece mais respostas como "SAIR" (palavras-chave removidas). A frase
 * "responda SAIR" do rascunho abaixo precisa ser revista ANTES da submissão à Meta, para não prometer um efeito que
 * não existe (decisão de conteúdo pendente; texto mantido sem alteração nesta fase).
 */
export type CategoriaTemplateWhatsapp = "MARKETING" | "UTILITY";

/** Origens de parâmetro permitidas — sempre dados do cadastro, nunca digitados no Backoffice. */
export type OrigemParametroTemplate = "cliente.primeiroNome";

export interface ParametroTemplateWhatsapp {
  /** Posição no corpo do template (`{{1}}`, `{{2}}`…), começando em 1. */
  posicao: number;
  origem: OrigemParametroTemplate;
}

export interface TemplateWhatsappDef {
  /** Chave interna estável (o que o Backoffice envia). */
  chave: string;
  /** Nome EXATO cadastrado na Meta. */
  nomeMeta: string;
  idioma: string;
  categoria: CategoriaTemplateWhatsapp;
  parametros: readonly ParametroTemplateWhatsapp[];
  /** Cópia do corpo submetido, com `{{n}}` — usada só para a prévia (o provedor renderiza o real). */
  previa: string;
  usoPermitido: readonly OrigemMensagemWhatsapp[];
}

export const CATALOGO_TEMPLATES_WHATSAPP: readonly TemplateWhatsappDef[] = [
  {
    chave: "aniversario_v1",
    nomeMeta: "mariela_aniversario_v1",
    idioma: "pt_BR",
    categoria: "MARKETING",
    parametros: [{ posicao: 1, origem: "cliente.primeiroNome" }],
    previa:
      "Olá, {{1}}! A equipe MARIELA deseja a você um feliz aniversário! Que seu novo ciclo seja cheio de coisas boas. " +
      "Esperamos você na MARIELA! Para não receber mais mensagens, responda SAIR.",
    usoPermitido: ["INDIVIDUAL", "CAMPANHA_ANIVERSARIO"],
  },
];

export function obterTemplateDoCatalogo(chave: string): TemplateWhatsappDef | null {
  return CATALOGO_TEMPLATES_WHATSAPP.find((t) => t.chave === chave) ?? null;
}

/** Primeiro nome do cadastro (mesma regra do Backoffice). */
export function primeiroNome(nome: string): string {
  const limpo = nome.trim();
  return limpo.split(/\s+/)[0] ?? limpo;
}

/** Valores dos parâmetros, na ordem das posições, derivados do cadastro. */
export function resolverParametros(def: TemplateWhatsappDef, cliente: { nome: string }): string[] {
  return [...def.parametros]
    .sort((a, b) => a.posicao - b.posicao)
    .map((p) => {
      switch (p.origem) {
        case "cliente.primeiroNome":
          return primeiroNome(cliente.nome);
      }
    });
}

/** Prévia em texto: substitui cada `{{n}}` pelo parâmetro correspondente. */
export function renderizarPrevia(def: TemplateWhatsappDef, parametros: readonly string[]): string {
  return def.previa.replace(/\{\{(\d+)\}\}/g, (marcador, n: string) => parametros[Number(n) - 1] ?? marcador);
}
