import { describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { validationExceptionFactory } from "../../../common/pipes/validation-exception-factory.js";
import { EnviarTemplateWhatsappDto } from "../dto/envios-whatsapp.dto.js";
import type { InfoTemplateProvedorWhatsapp, ProvedorEnvioWhatsapp } from "../providers/provedor-envio-whatsapp.interface.js";
import { CATALOGO_TEMPLATES_WHATSAPP, obterTemplateDoCatalogo, renderizarPrevia, resolverParametros } from "../templates/catalogo-templates-whatsapp.js";
import { avaliarAprovacaoTemplate, TemplatesWhatsappService } from "../templates/templates-whatsapp.service.js";
import { anoCivilDoEnvio, chaveDeduplicacaoCampanha } from "../utils/ano-campanha.util.js";
import { mascararTelefone } from "../utils/mascarar-telefone.util.js";
import { VALIDADE_CACHE_TEMPLATE_MS } from "./envios-whatsapp.constants.js";
import { hashConteudoEnvio } from "./envios-whatsapp.service.js";
import { aplicarEventoStatus, podeLiberarReenvio } from "./maquina-estados-whatsapp.js";

/**
 * Fase 22.8.9.10.3 — testes UNITÁRIOS (sem MongoDB, sem rede): regras puras do envio por template. A integração com
 * MongoDB real está em `envios-whatsapp.integracao.spec.ts`; a HTTP, em `envios-whatsapp.http.e2e.spec.ts`.
 */
const DEF = obterTemplateDoCatalogo("aniversario_v2")!;

describe("máquina de estados (webhook futuro — regra pura)", () => {
  it("progressão monotônica: sent → aceita, delivered → entregue, read → lida", () => {
    expect(aplicarEventoStatus("enviando", "sent")).toEqual({ tipo: "transicao", para: "aceita" });
    expect(aplicarEventoStatus("aceita", "delivered")).toEqual({ tipo: "transicao", para: "entregue" });
    expect(aplicarEventoStatus("entregue", "read")).toEqual({ tipo: "transicao", para: "lida" });
  });

  it("read direto (sem delivered antes) sobe para lida — read implica delivered", () => {
    expect(aplicarEventoStatus("aceita", "read")).toEqual({ tipo: "transicao", para: "lida" });
  });

  it("evento repetido ou fora de ordem é ignorado (sem regressão)", () => {
    expect(aplicarEventoStatus("aceita", "sent")).toEqual({ tipo: "ignorado" });
    expect(aplicarEventoStatus("lida", "delivered")).toEqual({ tipo: "ignorado" });
    expect(aplicarEventoStatus("lida", "sent")).toEqual({ tipo: "ignorado" });
    expect(aplicarEventoStatus("entregue", "delivered")).toEqual({ tipo: "ignorado" });
  });

  it("indeterminada sobe com confirmação tardia (reconciliação)", () => {
    expect(aplicarEventoStatus("indeterminada", "sent")).toEqual({ tipo: "transicao", para: "aceita" });
    expect(aplicarEventoStatus("indeterminada", "delivered")).toEqual({ tipo: "transicao", para: "entregue" });
    expect(aplicarEventoStatus("indeterminada", "failed")).toEqual({ tipo: "transicao", para: "falha" });
  });

  it("failed depois de entregue/lida é anomalia (não muda o estado)", () => {
    expect(aplicarEventoStatus("entregue", "failed")).toEqual({ tipo: "anomalia" });
    expect(aplicarEventoStatus("lida", "failed")).toEqual({ tipo: "anomalia" });
    expect(aplicarEventoStatus("aceita", "failed")).toEqual({ tipo: "transicao", para: "falha" });
  });

  it("nada sai de falha nem de pendente por evento externo", () => {
    for (const ev of ["sent", "delivered", "read", "failed"] as const) {
      expect(aplicarEventoStatus("falha", ev)).toEqual({ tipo: "ignorado" });
      expect(aplicarEventoStatus("pendente", ev)).toEqual({ tipo: "ignorado" });
    }
  });

  it("liberação de reenvio só para falha ou indeterminada", () => {
    expect(podeLiberarReenvio("falha")).toBe(true);
    expect(podeLiberarReenvio("indeterminada")).toBe(true);
    for (const e of ["pendente", "enviando", "aceita", "entregue", "lida"] as const) expect(podeLiberarReenvio(e)).toBe(false);
  });
});

describe("máscara de telefone", () => {
  it("celular e fixo brasileiros: nunca devolve o número completo", () => {
    expect(mascararTelefone("+5511987654321")).toBe("+55 11 9****-4321");
    expect(mascararTelefone("+551132654321")).toBe("+55 11 ****-4321");
    expect(mascararTelefone("5511987654321")).toBe("+55 11 9****-4321");
  });

  it("formato inesperado: só os 4 últimos dígitos", () => {
    expect(mascararTelefone("+1234567890123456")).toBe("****3456");
    expect(mascararTelefone("12")).toBe("****");
    expect(mascararTelefone(null)).toBe("****");
  });
});

describe("ano da campanha = ano civil do ENVIO no fuso da loja", () => {
  it("31/12 às 23:30 em São Paulo (já 01/01 em UTC) pertence ao ano que termina", () => {
    expect(anoCivilDoEnvio(new Date("2027-01-01T02:30:00Z"))).toBe(2026);
  });

  it("01/01 às 00:30 em São Paulo pertence ao ano novo", () => {
    expect(anoCivilDoEnvio(new Date("2027-01-01T03:30:00Z"))).toBe(2027);
  });

  it("envio em dezembro para aniversário de janeiro: campanha do ano do envio", () => {
    expect(anoCivilDoEnvio(new Date("2026-12-15T15:00:00Z"))).toBe(2026);
    expect(chaveDeduplicacaoCampanha("ANIVERSARIO", 2026, "abc")).toBe("ANIVERSARIO:2026:abc");
  });
});

describe("catálogo de templates", () => {
  it("chaves únicas, parâmetros sequenciais a partir de 1 e marcadores da prévia coerentes", () => {
    const chaves = CATALOGO_TEMPLATES_WHATSAPP.map((t) => t.chave);
    expect(new Set(chaves).size).toBe(chaves.length);
    for (const t of CATALOGO_TEMPLATES_WHATSAPP) {
      expect(t.parametros.map((p) => p.posicao).sort()).toEqual(t.parametros.map((_, i) => i + 1));
      const marcadores = [...t.previa.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(new Set(marcadores).size).toBe(t.parametros.length);
    }
  });

  it("parâmetros vêm do cadastro (primeiro nome) e a prévia os substitui", () => {
    const params = resolverParametros(DEF, { nome: "  Ana Maria Souza " });
    expect(params).toEqual(["Ana"]);
    expect(renderizarPrevia(DEF, params)).toStartWith("Olá, Ana!");
  });

  it("chave fora do catálogo: null", () => {
    expect(obterTemplateDoCatalogo("texto_livre")).toBeNull();
  });
});

describe("aprovação de templates (regra pura)", () => {
  const info = (extra: Partial<InfoTemplateProvedorWhatsapp> = {}): InfoTemplateProvedorWhatsapp => ({
    nomeMeta: DEF.nomeMeta,
    idioma: DEF.idioma,
    status: "APPROVED",
    categoria: DEF.categoria,
    quantidadeParametros: DEF.parametros.length,
    ...extra,
  });

  it("só APPROVED com tudo conferindo é APROVADO", () => {
    expect(avaliarAprovacaoTemplate(DEF, info())).toBe("APROVADO");
  });

  it("não encontrado, pendente, rejeitado, pausado, desativado e status desconhecido", () => {
    expect(avaliarAprovacaoTemplate(DEF, null)).toBe("NAO_ENCONTRADO");
    expect(avaliarAprovacaoTemplate(DEF, info({ status: "PENDING" }))).toBe("PENDENTE");
    expect(avaliarAprovacaoTemplate(DEF, info({ status: "REJECTED" }))).toBe("REJEITADO");
    expect(avaliarAprovacaoTemplate(DEF, info({ status: "PAUSED" }))).toBe("PAUSADO");
    expect(avaliarAprovacaoTemplate(DEF, info({ status: "DISABLED" }))).toBe("DESATIVADO");
    expect(avaliarAprovacaoTemplate(DEF, info({ status: "ALGO_NOVO" }))).toBe("DESCONHECIDO");
  });

  it("divergência de nome, idioma, categoria (reclassificação) ou parâmetros bloqueia", () => {
    expect(avaliarAprovacaoTemplate(DEF, info({ nomeMeta: "outro" }))).toBe("DIVERGENTE");
    expect(avaliarAprovacaoTemplate(DEF, info({ idioma: "en_US" }))).toBe("DIVERGENTE");
    expect(avaliarAprovacaoTemplate(DEF, info({ categoria: "UTILITY" }))).toBe("DIVERGENTE");
    expect(avaliarAprovacaoTemplate(DEF, info({ quantidadeParametros: 2 }))).toBe("DIVERGENTE");
  });
});

describe("TemplatesWhatsappService — cache e falha de consulta", () => {
  function criar(consulta: () => Promise<InfoTemplateProvedorWhatsapp | null>, configurado = true) {
    let consultas = 0;
    const provedor: ProvedorEnvioWhatsapp = {
      nome: "falso",
      configurado: () => configurado,
      enviarTemplate: async () => {
        throw new Error("não usado");
      },
      consultarTemplate: async () => {
        consultas += 1;
        return consulta();
      },
    };
    const service = new TemplatesWhatsappService(provedor);
    let agora = 1_000_000;
    service.relogio = () => agora;
    return { service, avancar: (ms: number) => (agora += ms), consultas: () => consultas };
  }
  const aprovado = async () => ({ nomeMeta: DEF.nomeMeta, idioma: DEF.idioma, status: "APPROVED", categoria: "MARKETING", quantidadeParametros: 1 });

  it("resultado confirmado fica em cache por 10 min e é consultado de novo depois", async () => {
    const t = criar(aprovado);
    expect(await t.service.estadoAprovacao(DEF)).toBe("APROVADO");
    t.avancar(VALIDADE_CACHE_TEMPLATE_MS - 1);
    expect(await t.service.estadoAprovacao(DEF)).toBe("APROVADO");
    expect(t.consultas()).toBe(1);
    t.avancar(1);
    await t.service.estadoAprovacao(DEF);
    expect(t.consultas()).toBe(2);
  });

  it("falha de consulta → DESCONHECIDO (bloqueia) e nunca reaproveita resultado vencido", async () => {
    let falhar = false;
    const t = criar(async () => {
      if (falhar) throw new Error("rede");
      return aprovado();
    });
    expect(await t.service.estadoAprovacao(DEF)).toBe("APROVADO");
    falhar = true;
    t.avancar(VALIDADE_CACHE_TEMPLATE_MS);
    expect(await t.service.estadoAprovacao(DEF)).toBe("DESCONHECIDO");
    await expect(t.service.exigirAprovado(DEF)).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_INDISPONIVEL" });
  });

  it("falha de consulta não entra no cache (a próxima tentativa consulta de novo)", async () => {
    let falhar = true;
    const t = criar(async () => {
      if (falhar) throw new Error("rede");
      return aprovado();
    });
    expect(await t.service.estadoAprovacao(DEF)).toBe("DESCONHECIDO");
    falhar = false;
    expect(await t.service.estadoAprovacao(DEF)).toBe("APROVADO");
    expect(t.consultas()).toBe(2);
  });

  it("invalidar descarta o cache na hora", async () => {
    const t = criar(aprovado);
    await t.service.estadoAprovacao(DEF);
    t.service.invalidar(DEF.chave);
    await t.service.estadoAprovacao(DEF);
    expect(t.consultas()).toBe(2);
  });

  it("provedor não configurado → DESCONHECIDO, sem consultar", async () => {
    const t = criar(aprovado, false);
    expect(await t.service.estadoAprovacao(DEF)).toBe("DESCONHECIDO");
    expect(t.consultas()).toBe(0);
  });
});

describe("hash do conteúdo (idempotência)", () => {
  const base = { idempotencyKey: "k", destinatario: { tipo: "CLIENTE" as const, id: "65f1a2b3c4d5e6f7a8b9c0d1" }, template: "aniversario_v2" };

  it("estável para o mesmo pedido e independente da chave", () => {
    expect(hashConteudoEnvio({ ...base })).toBe(hashConteudoEnvio({ ...base, idempotencyKey: "outra" }));
  });

  it("muda com destinatário, template ou campanha", () => {
    const h = hashConteudoEnvio(base);
    expect(hashConteudoEnvio({ ...base, destinatario: { tipo: "CLIENTE", id: "65f1a2b3c4d5e6f7a8b9c0d2" } })).not.toBe(h);
    expect(hashConteudoEnvio({ ...base, template: "outro" })).not.toBe(h);
    expect(hashConteudoEnvio({ ...base, campanha: { tipo: "ANIVERSARIO" } })).not.toBe(h);
  });
});

describe("DTO de envio (mesmo ValidationPipe global da API)", () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory });
  const validar = (corpo: unknown) => pipe.transform(corpo, { type: "body", metatype: EnviarTemplateWhatsappDto });
  const valido = {
    idempotencyKey: "6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d",
    destinatario: { tipo: "CLIENTE", id: "65f1a2b3c4d5e6f7a8b9c0d1" },
    template: "aniversario_v2",
  };

  it("aceita o contrato mínimo", async () => {
    await expect(validar(valido)).resolves.toBeDefined();
  });

  it("recusa telefone ou texto (no topo ou dentro do destinatário)", async () => {
    await expect(validar({ ...valido, telefone: "11999999999" })).rejects.toBeDefined();
    await expect(validar({ ...valido, mensagem: "texto livre" })).rejects.toBeDefined();
    await expect(validar({ ...valido, destinatario: { ...valido.destinatario, telefone: "11999999999" } })).rejects.toBeDefined();
  });

  it("recusa chave que não é UUID v4, tipo diferente de CLIENTE e campanha desconhecida", async () => {
    await expect(validar({ ...valido, idempotencyKey: "abc" })).rejects.toBeDefined();
    await expect(validar({ ...valido, destinatario: { tipo: "FORNECEDOR", id: valido.destinatario.id } })).rejects.toBeDefined();
    await expect(validar({ ...valido, campanha: { tipo: "BLACK_FRIDAY" } })).rejects.toBeDefined();
    await expect(validar({ ...valido, campanha: { tipo: "ANIVERSARIO", ano: 2020 } })).rejects.toBeDefined();
  });
});
