import type { CodigoRecusaProvedor } from "../../envios/envios-whatsapp.constants.js";
import type {
  EnviarTemplateWhatsappInput,
  EnviarTextoWhatsappInput,
  InfoTemplateProvedorWhatsapp,
  ResultadoEnvioProvedorWhatsapp,
} from "../provedor-envio-whatsapp.interface.js";
import type { RespostaHttpMeta } from "./cliente-http-meta.js";
import {
  codigoMetaDePermissao,
  FORMATO_WAMID,
  META_CODIGOS_INDETERMINADOS,
  META_CODIGOS_RECUSA,
} from "./meta-cloud-api.constants.js";

/**
 * Fase 22.8.9.10.4 — contrato da Cloud API em funções PURAS (sem rede, sem log): payload de template, classificação
 * do resultado do envio e leitura da consulta de templates. Tudo aqui é testado diretamente.
 */

/** Corpo do `POST /{Version}/{Phone-Number-ID}/messages` para um template com parâmetros POSICIONAIS no corpo. */
export function montarPayloadTemplate(input: EnviarTemplateWhatsappInput): Record<string, unknown> {
  const template: Record<string, unknown> = { name: input.nomeMeta, language: { code: input.idioma } };
  if (input.parametros.length > 0) {
    template["components"] = [{ type: "body", parameters: input.parametros.map((text) => ({ type: "text", text })) }];
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.telefoneE164,
    type: "template",
    template,
  };
}

/**
 * Fase 22.8.9.10.7.4 — corpo do `POST /{Version}/{Phone-Number-ID}/messages` para TEXTO livre (`type: "text"`).
 * `preview_url: false`: nenhum link do texto vira prévia (o operador não escolheu enviar prévia).
 */
export function montarPayloadTexto(input: EnviarTextoWhatsappInput): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.telefoneE164,
    type: "text",
    text: { preview_url: false, body: input.texto },
  };
}

function lerJson(corpo: string): unknown {
  try {
    return JSON.parse(corpo) as unknown;
  } catch {
    return undefined;
  }
}

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Erro estruturado da Graph API: `{ error: { code: <inteiro>, ... } }`. Só o código e o fbtrace_id são extraídos. */
export function extrairErroMeta(corpo: string): { codigo: number; fbtraceId: string | null } | null {
  const erro = objeto(objeto(lerJson(corpo))?.["error"]);
  const codigo = erro?.["code"];
  if (typeof codigo !== "number" || !Number.isInteger(codigo) || codigo < 0) return null;
  const trace = erro?.["fbtrace_id"];
  return { codigo, fbtraceId: typeof trace === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(trace) ? trace : null };
}

/** Classificação interna de um código de erro da Meta (mesma tabela do envio; reutilizada pelo webhook). */
export function recusaPorCodigo(codigo: number): CodigoRecusaProvedor {
  if (codigoMetaDePermissao(codigo)) return "CREDENCIAL_INVALIDA";
  return META_CODIGOS_RECUSA.get(codigo) ?? "RECUSADA";
}

/** Detalhes só para diagnóstico/log — nunca contém número, nome, token nem texto da Meta. */
export interface DiagnosticoEnvioMeta {
  httpStatus: number | null;
  fbtraceId: string | null;
  statusMensagem: string | null;
}

/**
 * Classificação CONSERVADORA (na dúvida, `indeterminada` — nunca reenviar):
 * - `aceita` SÓ com 2xx + JSON + `messages[0].id` válido (o `wamid`);
 * - `recusada` SÓ com 4xx + erro estruturado da Graph API cujo código não é temporário, ou sem conexão estabelecida;
 * - todo o resto (timeout, conexão cortada, 5xx, 3xx, 2xx sem id, JSON inválido, 4xx sem erro estruturado,
 *   códigos temporários) → `indeterminada`.
 */
export function classificarRespostaEnvio(resposta: RespostaHttpMeta): { resultado: ResultadoEnvioProvedorWhatsapp; diagnostico: DiagnosticoEnvioMeta } {
  const diag = (httpStatus: number | null, fbtraceId: string | null = null, statusMensagem: string | null = null): DiagnosticoEnvioMeta => ({
    httpStatus,
    fbtraceId,
    statusMensagem,
  });

  switch (resposta.tipo) {
    case "timeout":
      return { resultado: { resultado: "indeterminada", codigoProvedor: "TIMEOUT" }, diagnostico: diag(null) };
    case "interrompida":
      return { resultado: { resultado: "indeterminada", codigoProvedor: "CONEXAO_INTERROMPIDA" }, diagnostico: diag(null) };
    case "sem_conexao":
      return { resultado: { resultado: "recusada", codigo: "PROVEDOR_INDISPONIVEL", codigoProvedor: resposta.motivo }, diagnostico: diag(null) };
    case "resposta":
      break;
  }

  const { status, corpo } = resposta;

  if (status >= 200 && status <= 299) {
    const json = objeto(lerJson(corpo));
    const mensagens = json?.["messages"];
    const primeira = Array.isArray(mensagens) ? objeto(mensagens[0]) : null;
    const id = primeira?.["id"];
    if (json?.["messaging_product"] !== "whatsapp" || typeof id !== "string" || !FORMATO_WAMID.test(id)) {
      return {
        resultado: { resultado: "indeterminada", codigoProvedor: json ? "ACEITE_INCOMPLETO" : "RESPOSTA_INVALIDA" },
        diagnostico: diag(status),
      };
    }
    const contatos = json["contacts"];
    const waIdBruto = Array.isArray(contatos) ? objeto(contatos[0])?.["wa_id"] : undefined;
    const waId = typeof waIdBruto === "string" && /^\d{5,20}$/.test(waIdBruto) ? waIdBruto : null;
    const statusBruto = primeira?.["message_status"];
    const statusMensagem = typeof statusBruto === "string" && /^[a-z_]{1,64}$/.test(statusBruto) ? statusBruto : null;
    return { resultado: { resultado: "aceita", wamid: id, waId }, diagnostico: diag(status, null, statusMensagem) };
  }

  const erro = extrairErroMeta(corpo);
  if (status >= 400 && status <= 499 && erro && !META_CODIGOS_INDETERMINADOS.has(erro.codigo)) {
    return {
      resultado: { resultado: "recusada", codigo: recusaPorCodigo(erro.codigo), codigoProvedor: String(erro.codigo) },
      diagnostico: diag(status, erro.fbtraceId),
    };
  }

  // 5xx, 3xx (redirecionamento não seguido), 1xx, 4xx sem erro estruturado ou com código temporário.
  return {
    resultado: { resultado: "indeterminada", codigoProvedor: erro ? String(erro.codigo) : `HTTP_${status}` },
    diagnostico: diag(status, erro?.fbtraceId ?? null),
  };
}

/** Componentes do template como a Meta devolve (`GET /{WABA-ID}/message_templates`). */
interface ComponenteTemplateMeta {
  type?: unknown;
  format?: unknown;
  text?: unknown;
  buttons?: unknown;
}

const MARCADOR = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/**
 * Quantidade de parâmetros POSICIONAIS do corpo e se a estrutura é compatível com o envio que este backend faz
 * (só parâmetros de texto posicionais no corpo). Incompatível: parâmetros nomeados, cabeçalho com variável ou mídia,
 * botões com variável — enviar assim seria recusado pela Meta.
 */
export function analisarComponentes(componentes: unknown, formatoParametros: unknown): { quantidadeParametros: number; estruturaCompativel: boolean } {
  let compativel = typeof formatoParametros !== "string" || formatoParametros.toUpperCase() === "POSITIONAL";
  const posicoes = new Set<string>();
  if (!Array.isArray(componentes)) return { quantidadeParametros: 0, estruturaCompativel: false };

  for (const bruto of componentes) {
    const c = objeto(bruto) as ComponenteTemplateMeta | null;
    if (!c || typeof c.type !== "string") {
      compativel = false;
      continue;
    }
    const tipo = c.type.toUpperCase();
    const texto = typeof c.text === "string" ? c.text : "";
    const marcadores = [...texto.matchAll(MARCADOR)].map((m) => m[1]!);
    if (tipo === "BODY") {
      for (const m of marcadores) {
        if (/^\d+$/.test(m)) posicoes.add(m);
        else compativel = false;
      }
    } else if (tipo === "HEADER") {
      const formato = typeof c.format === "string" ? c.format.toUpperCase() : "TEXT";
      if (formato !== "TEXT" || marcadores.length > 0) compativel = false;
    } else if (tipo === "BUTTONS") {
      if (/\{\{/.test(JSON.stringify(c.buttons ?? []))) compativel = false;
    } else if (tipo !== "FOOTER") {
      compativel = false;
    }
  }
  return { quantidadeParametros: posicoes.size, estruturaCompativel: compativel };
}

/**
 * Lê a resposta da consulta de templates. Devolve a info do template com nome E idioma EXATOS, `null` se a resposta
 * completa não o contém, ou lança (sem detalhes sensíveis) se não dá para concluir — a aprovação fica DESCONHECIDA.
 */
export function lerConsultaTemplate(resposta: RespostaHttpMeta, nomeMeta: string, idioma: string): InfoTemplateProvedorWhatsapp | null {
  if (resposta.tipo !== "resposta") throw new Error(`Consulta de template sem resposta (${resposta.tipo}).`);
  if (resposta.status < 200 || resposta.status > 299) {
    const erro = extrairErroMeta(resposta.corpo);
    throw new Error(`Consulta de template recusada (HTTP ${resposta.status}${erro ? `, código ${erro.codigo}` : ""}).`);
  }
  const json = objeto(lerJson(resposta.corpo));
  const dados = json?.["data"];
  if (!Array.isArray(dados)) throw new Error("Consulta de template com resposta inválida.");

  for (const bruto of dados) {
    const t = objeto(bruto);
    if (!t || t["name"] !== nomeMeta || t["language"] !== idioma) continue;
    if (typeof t["status"] !== "string" || typeof t["category"] !== "string") throw new Error("Template com resposta incompleta.");
    const { quantidadeParametros, estruturaCompativel } = analisarComponentes(t["components"], t["parameter_format"]);
    return { nomeMeta, idioma, status: t["status"], categoria: t["category"], quantidadeParametros, estruturaCompativel };
  }

  // Não achou nesta página: só é "não encontrado" se a lista estiver completa (sem próxima página).
  const proxima = objeto(json?.["paging"])?.["next"];
  if (typeof proxima === "string" && proxima !== "") throw new Error("Consulta de template paginada sem o template na primeira página.");
  return null;
}
