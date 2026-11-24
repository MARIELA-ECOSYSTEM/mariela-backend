import type { EventoStatusExterno } from "../envios/maquina-estados-whatsapp.js";
import { FORMATO_WAMID } from "../providers/meta/meta-cloud-api.constants.js";
import { FORMATO_TIMESTAMP, FORMATO_WA_ID } from "./webhook-meta.constants.js";

/** Envelope fora do contrato documentado (o POST responde 400). Mensagem genérica, sem conteúdo do payload. */
export class ErroContratoWebhookMeta extends Error {
  constructor() {
    super("Notificação fora do contrato do webhook.");
    this.name = "ErroContratoWebhookMeta";
  }
}

export interface EventoStatusMeta {
  wamid: string;
  status: EventoStatusExterno;
  /** Momento do evento informado pela Meta; `null` se ausente/inválido. */
  ocorridoEm: Date | null;
  /** `errors[0].code` em `failed`; `null` se ausente. */
  codigoErro: number | null;
}

export type OrigemOptOutWebhook = "META_OPT_OUT" | "PALAVRA_CHAVE";

export interface PedidoOptOutMeta {
  /** Identificador do WhatsApp do usuário (`wa_id`/`from`), só dígitos, EXATAMENTE como a Meta enviou. */
  waId: string;
  origem: OrigemOptOutWebhook;
}

export interface ContagemWebhookMeta {
  statusIgnorados: number;
  mensagensRecebidas: number;
  preferenciasIgnoradas: number;
  outroNumero: number;
  camposIgnorados: number;
  itensInvalidos: number;
  errosNoValor: number;
  semIdentificadorTelefone: number;
}

export interface NotificacaoWebhookMeta {
  statuses: EventoStatusMeta[];
  optOuts: PedidoOptOutMeta[];
  contagem: ContagemWebhookMeta;
}

const STATUS_PROCESSADOS: ReadonlySet<string> = new Set<EventoStatusExterno>(["sent", "delivered", "read", "failed"]);

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function instante(v: unknown): Date | null {
  const texto = typeof v === "number" && Number.isInteger(v) ? String(v) : v;
  if (typeof texto !== "string" || !FORMATO_TIMESTAMP.test(texto)) return null;
  return new Date(Number(texto) * 1000);
}

/**
 * Fase 22.8.9.10.5 — interpreta uma notificação JÁ AUTENTICADA (assinatura validada antes). Função pura:
 * - envelope (`object`, `entry[]`, `changes[]`, `field`, `value`) fora do contrato → `ErroContratoWebhookMeta`;
 * - eventos de outro Phone Number ID, campos não suportados e itens malformados são IGNORADOS e só contados;
 * - o texto de mensagens recebidas é usado SÓ para `reconhecerOptOut` e nunca sai desta função.
 */
export function interpretarNotificacaoMeta(
  json: unknown,
  phoneNumberIdEsperado: string,
  reconhecerOptOut: (texto: string) => boolean,
): NotificacaoWebhookMeta {
  const raiz = objeto(json);
  if (!raiz || raiz["object"] !== "whatsapp_business_account" || !Array.isArray(raiz["entry"])) throw new ErroContratoWebhookMeta();

  const statuses: EventoStatusMeta[] = [];
  const optOuts: PedidoOptOutMeta[] = [];
  const contagem: ContagemWebhookMeta = {
    statusIgnorados: 0,
    mensagensRecebidas: 0,
    preferenciasIgnoradas: 0,
    outroNumero: 0,
    camposIgnorados: 0,
    itensInvalidos: 0,
    errosNoValor: 0,
    semIdentificadorTelefone: 0,
  };

  for (const entradaBruta of raiz["entry"]) {
    const entrada = objeto(entradaBruta);
    if (!entrada || !Array.isArray(entrada["changes"])) throw new ErroContratoWebhookMeta();
    for (const mudancaBruta of entrada["changes"]) {
      const mudanca = objeto(mudancaBruta);
      const campo = mudanca?.["field"];
      const valor = objeto(mudanca?.["value"]);
      if (!mudanca || typeof campo !== "string" || !valor) throw new ErroContratoWebhookMeta();

      if (campo !== "messages" && campo !== "user_preferences") {
        contagem.camposIgnorados += 1;
        continue;
      }
      if (objeto(valor["metadata"])?.["phone_number_id"] !== phoneNumberIdEsperado) {
        contagem.outroNumero += 1;
        continue;
      }

      if (campo === "messages") {
        if (Array.isArray(valor["errors"])) contagem.errosNoValor += valor["errors"].length;
        lerStatuses(valor["statuses"], statuses, contagem);
        lerMensagensRecebidas(valor["messages"], optOuts, contagem, reconhecerOptOut);
      } else {
        lerPreferencias(valor["user_preferences"], optOuts, contagem);
      }
    }
  }
  return { statuses, optOuts, contagem };
}

function lerStatuses(lista: unknown, saida: EventoStatusMeta[], contagem: ContagemWebhookMeta): void {
  if (lista === undefined) return;
  if (!Array.isArray(lista)) {
    contagem.itensInvalidos += 1;
    return;
  }
  for (const bruto of lista) {
    const s = objeto(bruto);
    const id = s?.["id"];
    const status = s?.["status"];
    if (!s || typeof id !== "string" || !FORMATO_WAMID.test(id) || typeof status !== "string") {
      contagem.itensInvalidos += 1;
      continue;
    }
    if (!STATUS_PROCESSADOS.has(status)) {
      contagem.statusIgnorados += 1; // ex.: `played` (mensagem de voz) — fora do escopo
      continue;
    }
    const erros = s["errors"];
    const codigo = Array.isArray(erros) ? objeto(erros[0])?.["code"] : undefined;
    saida.push({
      wamid: id,
      status: status as EventoStatusExterno,
      ocorridoEm: instante(s["timestamp"]),
      codigoErro: typeof codigo === "number" && Number.isInteger(codigo) && codigo >= 0 ? codigo : null,
    });
  }
}

function lerMensagensRecebidas(
  lista: unknown,
  saida: PedidoOptOutMeta[],
  contagem: ContagemWebhookMeta,
  reconhecerOptOut: (texto: string) => boolean,
): void {
  if (lista === undefined) return;
  if (!Array.isArray(lista)) {
    contagem.itensInvalidos += 1;
    return;
  }
  for (const bruto of lista) {
    const m = objeto(bruto);
    if (!m) {
      contagem.itensInvalidos += 1;
      continue;
    }
    contagem.mensagensRecebidas += 1;
    // Só mensagens de TEXTO são candidatas a opt-out por palavra-chave; qualquer outro tipo é ignorado.
    const corpo = m["type"] === "text" ? objeto(m["text"])?.["body"] : undefined;
    if (typeof corpo !== "string" || !reconhecerOptOut(corpo)) continue;
    const from = m["from"];
    if (typeof from !== "string" || !FORMATO_WA_ID.test(from)) {
      // Usuário com nome de usuário/BSUID sem telefone: não há número a bloquear.
      contagem.semIdentificadorTelefone += 1;
      continue;
    }
    saida.push({ waId: from, origem: "PALAVRA_CHAVE" });
  }
}

function lerPreferencias(lista: unknown, saida: PedidoOptOutMeta[], contagem: ContagemWebhookMeta): void {
  if (!Array.isArray(lista)) {
    contagem.itensInvalidos += 1;
    return;
  }
  for (const bruto of lista) {
    const p = objeto(bruto);
    if (!p) {
      contagem.itensInvalidos += 1;
      continue;
    }
    // Só "parar marketing" bloqueia. `resume` NUNCA desbloqueia automaticamente (desbloqueio é ação do ADMIN).
    if (p["category"] !== "marketing_messages" || p["value"] !== "stop") {
      contagem.preferenciasIgnoradas += 1;
      continue;
    }
    const waId = p["wa_id"];
    if (typeof waId !== "string" || !FORMATO_WA_ID.test(waId)) {
      contagem.semIdentificadorTelefone += 1;
      continue;
    }
    saida.push({ waId, origem: "META_OPT_OUT" });
  }
}
