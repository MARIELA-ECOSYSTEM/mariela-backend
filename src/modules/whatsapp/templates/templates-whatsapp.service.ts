import { Inject, Injectable, Logger } from "@nestjs/common";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import { VALIDADE_CACHE_TEMPLATE_MS } from "../envios/envios-whatsapp.constants.js";
import {
  PROVEDOR_ENVIO_WHATSAPP,
  type InfoTemplateProvedorWhatsapp,
  type ProvedorEnvioWhatsapp,
} from "../providers/provedor-envio-whatsapp.interface.js";
import { CATALOGO_TEMPLATES_WHATSAPP, type TemplateWhatsappDef } from "./catalogo-templates-whatsapp.js";

/**
 * `APROVADO` é o ÚNICO estado que permite envio. `DIVERGENTE`: aprovado no provedor, mas nome/idioma/categoria/número
 * de parâmetros diferente do catálogo (ex.: reclassificação de categoria). `DESCONHECIDO`: a consulta não pôde ser
 * feita agora (ou o provedor não está configurado) — nunca presumido como aprovado.
 */
export type EstadoAprovacaoTemplateWhatsapp =
  | "APROVADO"
  | "PENDENTE"
  | "REJEITADO"
  | "PAUSADO"
  | "DESATIVADO"
  | "NAO_ENCONTRADO"
  | "DIVERGENTE"
  | "DESCONHECIDO";

export interface TemplateWhatsappPublico {
  chave: string;
  categoria: TemplateWhatsappDef["categoria"];
  idioma: string;
  usoPermitido: TemplateWhatsappDef["usoPermitido"];
  /** Corpo com `{{n}}` — a prévia com dados reais vem de `POST /templates/:chave/previa`. */
  previa: string;
  estadoAprovacao: EstadoAprovacaoTemplateWhatsapp;
}

const STATUS_PROVEDOR: Record<string, EstadoAprovacaoTemplateWhatsapp> = {
  APPROVED: "APROVADO",
  PENDING: "PENDENTE",
  IN_APPEAL: "PENDENTE",
  REJECTED: "REJEITADO",
  PAUSED: "PAUSADO",
  DISABLED: "DESATIVADO",
};

/** Regra de aprovação (spec 22.8.9.10.2 consolidada, item G) — função pura. */
export function avaliarAprovacaoTemplate(def: TemplateWhatsappDef, info: InfoTemplateProvedorWhatsapp | null): EstadoAprovacaoTemplateWhatsapp {
  if (info === null) return "NAO_ENCONTRADO";
  const estado = STATUS_PROVEDOR[info.status.toUpperCase()] ?? "DESCONHECIDO";
  if (estado !== "APROVADO") return estado;
  const confere =
    info.nomeMeta === def.nomeMeta &&
    info.idioma === def.idioma &&
    info.categoria.toUpperCase() === def.categoria &&
    info.quantidadeParametros === def.parametros.length;
  return confere ? "APROVADO" : "DIVERGENTE";
}

/**
 * Fase 22.8.9.10.3 — aprovação de templates SEMPRE confirmada no provedor, com cache de `VALIDADE_CACHE_TEMPLATE_MS`
 * só para consultas que tiveram resposta. Falha de consulta → `DESCONHECIDO` (bloqueia o envio) e NUNCA reaproveita
 * um resultado vencido.
 */
@Injectable()
export class TemplatesWhatsappService {
  private readonly logger = new Logger(TemplatesWhatsappService.name);
  private readonly cache = new Map<string, { estado: EstadoAprovacaoTemplateWhatsapp; expiraEm: number }>();
  /** Relógio substituível nos testes. */
  relogio: () => number = () => Date.now();

  constructor(@Inject(PROVEDOR_ENVIO_WHATSAPP) private readonly provedor: ProvedorEnvioWhatsapp) {}

  async estadoAprovacao(def: TemplateWhatsappDef): Promise<EstadoAprovacaoTemplateWhatsapp> {
    const agora = this.relogio();
    const emCache = this.cache.get(def.chave);
    if (emCache && emCache.expiraEm > agora) return emCache.estado;
    this.cache.delete(def.chave);

    if (!this.provedor.configurado()) return "DESCONHECIDO";

    let info: InfoTemplateProvedorWhatsapp | null;
    try {
      info = await this.provedor.consultarTemplate(def.nomeMeta, def.idioma);
    } catch {
      this.logger.warn(JSON.stringify({ evento: "whatsapp.template.consulta_falhou", template: def.chave }));
      return "DESCONHECIDO";
    }
    const estado = avaliarAprovacaoTemplate(def, info);
    this.cache.set(def.chave, { estado, expiraEm: agora + VALIDADE_CACHE_TEMPLATE_MS });
    return estado;
  }

  /** Bloqueia o envio se a aprovação não estiver CONFIRMADA. */
  async exigirAprovado(def: TemplateWhatsappDef): Promise<void> {
    const estado = await this.estadoAprovacao(def);
    if (estado !== "APROVADO") {
      throw ApiException.whatsappTemplateIndisponivel(`O modelo "${def.chave}" não está disponível para envio (${estado}).`);
    }
  }

  /** Erro de template no envio: descarta o resultado em cache na hora. */
  invalidar(chave: string): void {
    this.cache.delete(chave);
  }

  async listar(): Promise<TemplateWhatsappPublico[]> {
    const lista: TemplateWhatsappPublico[] = [];
    for (const def of CATALOGO_TEMPLATES_WHATSAPP) {
      lista.push({
        chave: def.chave,
        categoria: def.categoria,
        idioma: def.idioma,
        usoPermitido: def.usoPermitido,
        previa: def.previa,
        estadoAprovacao: await this.estadoAprovacao(def),
      });
    }
    return lista;
  }
}
