import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Logger } from "@nestjs/common";
import type { MetaWhatsappConfig, WhatsappConfig } from "../../../../config/configuration.js";
import { obterTemplateDoCatalogo } from "../../templates/catalogo-templates-whatsapp.js";
import { avaliarAprovacaoTemplate } from "../../templates/templates-whatsapp.service.js";
import { ProvedorEnvioDesativado } from "../provedor-envio-desativado.js";
import type { EnviarTemplateWhatsappInput } from "../provedor-envio-whatsapp.interface.js";
import { criarProvedorEnvioWhatsapp } from "../selecionar-provedor-envio.js";
import { ClienteHttpMetaWhatsapp, type FetchMeta } from "./cliente-http-meta.js";
import { lerConfiguracaoMeta } from "./configuracao-meta.js";
import { analisarComponentes, classificarRespostaEnvio, montarPayloadTemplate } from "./contrato-meta.js";
import { META_GRAPH_API_VERSION_PADRAO } from "./meta-cloud-api.constants.js";
import { ProvedorEnvioMetaCloudApi } from "./provedor-envio-meta-cloud-api.js";

/**
 * Fase 22.8.9.10.4 — adaptador da Cloud API com `fetch` FALSO: nenhuma chamada de rede, nenhuma credencial real. O
 * "token" é um marcador textual evidente, usado para provar que nunca vaza em resultado, log ou exceção.
 */
const TOKEN = "TOKEN-FICTICIO-DE-TESTE";
const TELEFONE = "+5583912345678";
const NOME = "Joana";

const CONFIG_META: MetaWhatsappConfig = {
  graphApiVersion: "v26.0",
  phoneNumberId: "100000000000001",
  businessAccountId: "200000000000002",
  accessToken: TOKEN,
  timeoutMs: 5_000,
};

const whatsappConfig = (extra: Partial<WhatsappConfig> = {}, meta: Partial<MetaWhatsappConfig> = {}): WhatsappConfig => ({
  ownerPhone: "",
  evolution: { apiUrl: "", apiKey: "", instanceName: "x", timeoutMs: 10_000 },
  provedorEnvio: "meta-cloud-api",
  meta: { ...CONFIG_META, ...meta },
  ...extra,
});

const ENTRADA: EnviarTemplateWhatsappInput = {
  telefoneE164: TELEFONE,
  nomeMeta: "mariela_aniversario_v2",
  idioma: "pt_BR",
  parametros: [NOME],
  referenciaInterna: "65f1a2b3c4d5e6f7a8b9c0d1",
};

interface ChamadaFetch {
  url: string;
  init: RequestInit;
}

/** `fetch` falso: registra cada chamada e devolve o que o teste mandar (ou lança). */
function fetchFalso(responder: (c: ChamadaFetch) => Response | Promise<Response>) {
  const chamadas: ChamadaFetch[] = [];
  const impl: FetchMeta = async (url, init) => {
    const c = { url, init };
    chamadas.push(c);
    return responder(c);
  };
  return { impl, chamadas };
}

const json = (status: number, corpo: unknown) =>
  new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

const ACEITE = {
  messaging_product: "whatsapp",
  contacts: [{ input: TELEFONE, wa_id: "5583912345678" }],
  messages: [{ id: "wamid.HBgMNTU4MzkxMjM0NTY3OBUCABEYEjQ2", message_status: "accepted" }],
};

const erroMeta = (code: number, status = 400) =>
  json(status, { error: { message: `(#${code}) algo sobre ${TELEFONE}`, type: "OAuthException", code, error_data: { messaging_product: "whatsapp", details: `detalhe com ${NOME}` }, fbtrace_id: "Az8or2yhqkZfEZ-_4Qn_Bam" } });

function configValida(meta: Partial<MetaWhatsappConfig> = {}) {
  const leitura = lerConfiguracaoMeta({ ...CONFIG_META, ...meta });
  if (!leitura.valida) throw new Error("config de teste inválida");
  return leitura.config;
}

function provedorCom(
  responder: (c: ChamadaFetch) => Response | Promise<Response>,
  numeroDaLoja: string | null = null,
  meta: Partial<MetaWhatsappConfig> = {},
) {
  const f = fetchFalso(responder);
  const provedor = new ProvedorEnvioMetaCloudApi(configValida(meta), new ClienteHttpMetaWhatsapp(f.impl), numeroDaLoja);
  return { provedor, chamadas: f.chamadas };
}

let logs: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  logs = [];
  spies = (["log", "warn", "error", "debug", "verbose"] as const).map((nivel) =>
    spyOn(Logger.prototype, nivel).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }),
  );
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
});

/** Nada sensível em logs nem no resultado: token, número completo, nome, texto/detalhe da Meta. */
function semDadosSensiveis(...extras: unknown[]) {
  const tudo = [...logs, ...extras.map((e) => JSON.stringify(e))].join("\n");
  expect(tudo).not.toContain(TOKEN);
  expect(tudo).not.toContain("5583912345678");
  expect(tudo).not.toContain(NOME);
  expect(tudo).not.toContain("algo sobre");
  expect(tudo).not.toContain("detalhe com");
  expect(tudo).not.toContain("Bearer");
}

describe("contrato de envio (endpoint, versão, Phone Number ID, autenticação e payload)", () => {
  it("POST https://graph.facebook.com/{versão}/{Phone-Number-ID}/messages com Bearer e JSON do template", async () => {
    const { provedor, chamadas } = provedorCom(() => json(200, ACEITE));
    await provedor.enviarTemplate(ENTRADA);

    expect(chamadas).toHaveLength(1);
    const { url, init } = chamadas[0]!;
    expect(url).toBe("https://graph.facebook.com/v26.0/100000000000001/messages");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: TELEFONE,
      type: "template",
      template: {
        name: "mariela_aniversario_v2",
        language: { code: "pt_BR" },
        components: [{ type: "body", parameters: [{ type: "text", text: NOME }] }],
      },
    });
    // O token só existe no header: nunca na URL nem no corpo.
    expect(url).not.toContain(TOKEN);
    expect(init.body as string).not.toContain(TOKEN);
  });

  it("template sem parâmetros: sem `components`; vários parâmetros na ordem recebida", () => {
    expect((montarPayloadTemplate({ ...ENTRADA, parametros: [] })["template"] as Record<string, unknown>)["components"]).toBeUndefined();
    const t = montarPayloadTemplate({ ...ENTRADA, parametros: ["a", "b"] })["template"] as { components: { parameters: { text: string }[] }[] };
    expect(t.components[0]!.parameters.map((p) => p.text)).toEqual(["a", "b"]);
  });

  it("versão padrão = a mais recente do changelog oficial (v26.0)", () => {
    expect(META_GRAPH_API_VERSION_PADRAO).toBe("v26.0");
  });
});

describe("classificação: aceita", () => {
  it("2xx com messages[0].id → aceita, captura wamid e wa_id; log sem dados pessoais", async () => {
    const { provedor } = provedorCom(() => json(200, ACEITE));
    const r = await provedor.enviarTemplate(ENTRADA);
    expect(r).toEqual({ resultado: "aceita", wamid: "wamid.HBgMNTU4MzkxMjM0NTY3OBUCABEYEjQ2", waId: "5583912345678" });
    // `r` contém o wa_id (vai para o banco, nunca para log): a checagem de sigilo é só nos logs.
    semDadosSensiveis();
  });

  it("held_for_quality_assessment e paused também são aceite (a Meta criou a mensagem)", () => {
    for (const message_status of ["held_for_quality_assessment", "paused"]) {
      const corpo = JSON.stringify({ ...ACEITE, messages: [{ id: "wamid.X", message_status }] });
      expect(classificarRespostaEnvio({ tipo: "resposta", status: 200, corpo }).resultado.resultado).toBe("aceita");
    }
  });

  it("wa_id ausente ou malformado → waId null (o aceite continua válido)", () => {
    const corpo = JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.X" }] });
    expect(classificarRespostaEnvio({ tipo: "resposta", status: 200, corpo }).resultado).toEqual({ resultado: "aceita", wamid: "wamid.X", waId: null });
  });
});

describe("classificação: recusada (determinística)", () => {
  const casos: [number, string][] = [
    [190, "CREDENCIAL_INVALIDA"], // token expirado (autenticação)
    [0, "CREDENCIAL_INVALIDA"],
    [10, "CREDENCIAL_INVALIDA"], // permissão (autorização)
    [200, "CREDENCIAL_INVALIDA"],
    [299, "CREDENCIAL_INVALIDA"],
    [131005, "CREDENCIAL_INVALIDA"],
    [132001, "TEMPLATE_INVALIDO"], // template inexistente/não aprovado no idioma
    [132000, "TEMPLATE_INVALIDO"], // número de parâmetros
    [132012, "TEMPLATE_INVALIDO"],
    [132015, "TEMPLATE_INVALIDO"],
    [132016, "TEMPLATE_INVALIDO"],
    [130429, "LIMITE_TAXA"],
    [131056, "LIMITE_TAXA"],
    [80007, "LIMITE_TAXA"],
    [4, "LIMITE_TAXA"],
    [131026, "SEM_WHATSAPP"],
    [131050, "OPT_OUT_MARKETING"],
    [131049, "LIMITE_MARKETING_DESTINATARIO"],
    [131021, "RECUSADA"], // remetente = destinatário
    [131047, "JANELA_FECHADA"], // Fase 22.8.9.10.7.4 — texto livre fora da janela de 24 h
    [368, "RECUSADA"],
    [100, "RECUSADA"],
    [131009, "RECUSADA"],
  ];

  for (const [codigo, esperado] of casos) {
    it(`erro ${codigo} (4xx estruturado) → recusada ${esperado}`, async () => {
      const status = codigo === 190 || codigo === 0 ? 401 : codigo === 130429 ? 429 : 400;
      const { provedor, chamadas } = provedorCom(() => erroMeta(codigo, status));
      const r = await provedor.enviarTemplate(ENTRADA);
      expect(r).toEqual({ resultado: "recusada", codigo: esperado as never, codigoProvedor: String(codigo) });
      expect(chamadas).toHaveLength(1); // sem retry
      semDadosSensiveis(r);
    });
  }
});

describe("classificação: indeterminada (na dúvida, nunca reenviar)", () => {
  it("timeout → indeterminada TIMEOUT, uma única chamada", async () => {
    const { provedor, chamadas } = provedorCom(
      (c) =>
        new Promise<Response>((_, rejeitar) => {
          c.init.signal!.addEventListener("abort", () => rejeitar(new DOMException("The operation was aborted.", "AbortError")));
        }),
      null,
      { timeoutMs: 1_000 },
    );
    const inicio = Date.now();
    const r = await provedor.enviarTemplate(ENTRADA);
    expect(r).toEqual({ resultado: "indeterminada", codigoProvedor: "TIMEOUT" });
    expect(Date.now() - inicio).toBeLessThan(3_000);
    expect(chamadas).toHaveLength(1);
    semDadosSensiveis(r);
  });

  it("conexão interrompida depois do pedido (ECONNRESET) → indeterminada", async () => {
    const { provedor, chamadas } = provedorCom(() => {
      throw Object.assign(new TypeError(`socket closed ${TOKEN}`), { code: "ECONNRESET" });
    });
    const r = await provedor.enviarTemplate(ENTRADA);
    expect(r).toEqual({ resultado: "indeterminada", codigoProvedor: "CONEXAO_INTERROMPIDA" });
    expect(chamadas).toHaveLength(1);
    semDadosSensiveis(r);
  });

  it("erro desconhecido de rede → indeterminada (nunca presumido como não enviado)", async () => {
    const { provedor } = provedorCom(() => {
      throw new Error("qualquer coisa");
    });
    expect(await provedor.enviarTemplate(ENTRADA)).toEqual({ resultado: "indeterminada", codigoProvedor: "CONEXAO_INTERROMPIDA" });
  });

  it("sem conexão estabelecida (recusada/DNS) → recusada PROVEDOR_INDISPONIVEL (nada saiu)", async () => {
    for (const [code, motivo] of [
      ["ConnectionRefused", "CONEXAO_RECUSADA"],
      ["ECONNREFUSED", "CONEXAO_RECUSADA"],
      ["ENOTFOUND", "DNS"],
    ]) {
      const { provedor } = provedorCom(() => {
        throw Object.assign(new TypeError("x"), { code });
      });
      expect(await provedor.enviarTemplate(ENTRADA)).toEqual({ resultado: "recusada", codigo: "PROVEDOR_INDISPONIVEL", codigoProvedor: motivo });
    }
  });

  it("JSON inválido no 2xx → indeterminada RESPOSTA_INVALIDA", async () => {
    const { provedor } = provedorCom(() => json(200, '{"messaging_product":"whatsapp","messages":[{"id":'));
    expect(await provedor.enviarTemplate(ENTRADA)).toEqual({ resultado: "indeterminada", codigoProvedor: "RESPOSTA_INVALIDA" });
  });

  it("2xx incompleto (sem messages, id vazio, id malformado, outro produto) → indeterminada ACEITE_INCOMPLETO", () => {
    for (const corpo of [
      { messaging_product: "whatsapp" },
      { messaging_product: "whatsapp", messages: [] },
      { messaging_product: "whatsapp", messages: [{ id: "" }] },
      { messaging_product: "whatsapp", messages: [{ id: "tem espaço e <html>" }] },
      { messaging_product: "outro", messages: [{ id: "wamid.X" }] },
    ]) {
      expect(classificarRespostaEnvio({ tipo: "resposta", status: 200, corpo: JSON.stringify(corpo) }).resultado).toEqual({
        resultado: "indeterminada",
        codigoProvedor: "ACEITE_INCOMPLETO",
      });
    }
    // JSON válido que nem é objeto (ou corpo vazio): resposta inválida.
    for (const corpo of ["[]", "null", ""]) {
      expect(classificarRespostaEnvio({ tipo: "resposta", status: 200, corpo }).resultado).toEqual({ resultado: "indeterminada", codigoProvedor: "RESPOSTA_INVALIDA" });
    }
  });

  it("5xx (mesmo com erro estruturado), 3xx e 4xx sem erro estruturado → indeterminada", () => {
    const r = (status: number, corpo: string) => classificarRespostaEnvio({ tipo: "resposta", status, corpo }).resultado;
    expect(r(500, JSON.stringify({ error: { code: 131000 } }))).toEqual({ resultado: "indeterminada", codigoProvedor: "131000" });
    expect(r(503, "<html>Service Unavailable</html>")).toEqual({ resultado: "indeterminada", codigoProvedor: "HTTP_503" });
    expect(r(502, "")).toEqual({ resultado: "indeterminada", codigoProvedor: "HTTP_502" });
    expect(r(302, "")).toEqual({ resultado: "indeterminada", codigoProvedor: "HTTP_302" });
    expect(r(400, "<html>proxy</html>")).toEqual({ resultado: "indeterminada", codigoProvedor: "HTTP_400" });
    expect(r(400, JSON.stringify({ error: { code: "131026" } }))).toEqual({ resultado: "indeterminada", codigoProvedor: "HTTP_400" });
  });

  it("códigos temporários da Meta (1, 2, 131000, 131016, 133004) → indeterminada mesmo em 4xx", () => {
    for (const code of [1, 2, 131000, 131016, 133004]) {
      expect(classificarRespostaEnvio({ tipo: "resposta", status: 400, corpo: JSON.stringify({ error: { code } }) }).resultado).toEqual({
        resultado: "indeterminada",
        codigoProvedor: String(code),
      });
    }
  });
});

describe("ausência de retry", () => {
  it("cada envio = exatamente UMA chamada HTTP, em qualquer resultado", async () => {
    const respostas: (() => Response)[] = [
      () => json(200, ACEITE),
      () => erroMeta(131026),
      () => erroMeta(131000, 500),
      () => json(503, "x"),
      () => {
        throw Object.assign(new TypeError("x"), { code: "ECONNRESET" });
      },
    ];
    for (const responder of respostas) {
      const { provedor, chamadas } = provedorCom(responder);
      await provedor.enviarTemplate(ENTRADA);
      expect(chamadas).toHaveLength(1);
    }
  });
});

describe("entrada fora do contrato: recusada SEM chamada de rede", () => {
  it("número da própria loja nunca é destinatário", async () => {
    const { provedor, chamadas } = provedorCom(() => json(200, ACEITE), TELEFONE);
    expect(await provedor.enviarTemplate(ENTRADA)).toEqual({ resultado: "recusada", codigo: "RECUSADA", codigoProvedor: "DESTINATARIO_PROPRIA_LOJA" });
    expect(chamadas).toHaveLength(0);
  });

  it("destinatário fora de E.164, nome/idioma inválidos ou parâmetro vazio", async () => {
    const { provedor, chamadas } = provedorCom(() => json(200, ACEITE));
    expect((await provedor.enviarTemplate({ ...ENTRADA, telefoneE164: "83912345678" })).resultado).toBe("recusada");
    expect((await provedor.enviarTemplate({ ...ENTRADA, nomeMeta: "Texto Livre!" })).resultado).toBe("recusada");
    expect((await provedor.enviarTemplate({ ...ENTRADA, idioma: "portugues" })).resultado).toBe("recusada");
    expect((await provedor.enviarTemplate({ ...ENTRADA, parametros: ["  "] })).resultado).toBe("recusada");
    expect(chamadas).toHaveLength(0);
    semDadosSensiveis();
  });
});

describe("Fase 22.8.9.10.7.4 — texto livre (type: text)", () => {
  const TEXTO = "Olá! Seu pedido ficou pronto. Veja https://exemplo.invalid/pedido";
  const ENTRADA_TEXTO = { telefoneE164: TELEFONE, texto: TEXTO, referenciaInterna: "65f1a2b3c4d5e6f7a8b9c0d2" };

  it("POST no mesmo endpoint, payload `text` com preview_url false; aceite com wamid e wa_id; texto nunca em log", async () => {
    const { provedor, chamadas } = provedorCom(() => json(200, ACEITE));
    const r = await provedor.enviarTexto(ENTRADA_TEXTO);
    expect(r).toEqual({ resultado: "aceita", wamid: "wamid.HBgMNTU4MzkxMjM0NTY3OBUCABEYEjQ2", waId: "5583912345678" });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe("https://graph.facebook.com/v26.0/100000000000001/messages");
    expect(JSON.parse(chamadas[0]!.init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: TELEFONE,
      type: "text",
      text: { preview_url: false, body: TEXTO },
    });
    expect(logs.join("\n")).not.toContain("Seu pedido");
    semDadosSensiveis();
  });

  it("131047 (fora da janela) → recusada JANELA_FECHADA; timeout → indeterminada; sempre UMA chamada", async () => {
    const fora = provedorCom(() => erroMeta(131047));
    expect(await fora.provedor.enviarTexto(ENTRADA_TEXTO)).toEqual({ resultado: "recusada", codigo: "JANELA_FECHADA", codigoProvedor: "131047" });
    expect(fora.chamadas).toHaveLength(1);

    const lento = provedorCom(
      (c) =>
        new Promise<Response>((_, rejeitar) => {
          c.init.signal!.addEventListener("abort", () => rejeitar(new DOMException("The operation was aborted.", "AbortError")));
        }),
      null,
      { timeoutMs: 1_000 },
    );
    expect(await lento.provedor.enviarTexto(ENTRADA_TEXTO)).toEqual({ resultado: "indeterminada", codigoProvedor: "TIMEOUT" });
    expect(lento.chamadas).toHaveLength(1);
    semDadosSensiveis();
  });

  it("texto vazio/só espaços/acima de 4096, destinatário fora de E.164 ou número da loja → recusada SEM rede", async () => {
    const { provedor, chamadas } = provedorCom(() => json(200, ACEITE), "+5583900000000");
    for (const entrada of [
      { ...ENTRADA_TEXTO, texto: "" },
      { ...ENTRADA_TEXTO, texto: "   \n " },
      { ...ENTRADA_TEXTO, texto: "a".repeat(4097) },
      { ...ENTRADA_TEXTO, telefoneE164: "83912345678" },
      { ...ENTRADA_TEXTO, telefoneE164: "+5583900000000" },
    ]) {
      expect((await provedor.enviarTexto(entrada)).resultado).toBe("recusada");
    }
    expect((await provedor.enviarTexto({ ...ENTRADA_TEXTO, texto: "a".repeat(4096) })).resultado).toBe("aceita");
    expect(chamadas).toHaveLength(1);
  });

  it("provedor desativado nunca envia texto", async () => {
    await expect(new ProvedorEnvioDesativado().enviarTexto(ENTRADA_TEXTO)).rejects.toThrow();
  });
});

describe("consulta de template (aprovação) — GET /{WABA-ID}/message_templates", () => {
  const DEF = obterTemplateDoCatalogo("aniversario_v2")!;
  const tpl = (extra: Record<string, unknown> = {}) => ({
    name: "mariela_aniversario_v2",
    language: "pt_BR",
    status: "APPROVED",
    category: "MARKETING",
    id: "1",
    components: [{ type: "BODY", text: "Olá, {{1}}! Feliz aniversário." }, { type: "FOOTER", text: "Loja MARIELA." }],
    ...extra,
  });

  it("endpoint, filtro por nome e Bearer; nome+idioma exatos → info com parâmetros contados", async () => {
    const { provedor, chamadas } = provedorCom(() => json(200, { data: [tpl({ language: "en_US" }), tpl()] }));
    const info = await provedor.consultarTemplate("mariela_aniversario_v2", "pt_BR");
    expect(chamadas[0]!.url).toBe("https://graph.facebook.com/v26.0/200000000000002/message_templates?name=mariela_aniversario_v2");
    expect(chamadas[0]!.init.method).toBe("GET");
    expect((chamadas[0]!.init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(info).toEqual({ nomeMeta: "mariela_aniversario_v2", idioma: "pt_BR", status: "APPROVED", categoria: "MARKETING", quantidadeParametros: 1, estruturaCompativel: true });
    expect(avaliarAprovacaoTemplate(DEF, info)).toBe("APROVADO");
  });

  it("não encontrado (lista completa) → null; paginado sem o template → exceção (DESCONHECIDO)", async () => {
    expect(await provedorCom(() => json(200, { data: [tpl({ name: "mariela_aniversario_v20" })] })).provedor.consultarTemplate("mariela_aniversario_v2", "pt_BR")).toBeNull();
    await expect(
      provedorCom(() => json(200, { data: [], paging: { next: "https://graph.facebook.com/next" } })).provedor.consultarTemplate("mariela_aniversario_v2", "pt_BR"),
    ).rejects.toThrow();
  });

  it("erro HTTP, timeout, JSON inválido ou registro incompleto → exceção sem token nem corpo", async () => {
    for (const responder of [() => erroMeta(190, 401), () => json(200, "{"), () => json(200, { data: [tpl({ status: undefined })] }), () => json(500, "x")]) {
      const { provedor } = provedorCom(responder);
      const erro = await provedor.consultarTemplate("mariela_aniversario_v2", "pt_BR").catch((e: Error) => e);
      expect(erro).toBeInstanceOf(Error);
      expect((erro as Error).message).not.toContain(TOKEN);
      expect((erro as Error).message).not.toContain("algo sobre");
    }
  });

  it("estrutura incompatível com o envio (nomeado, cabeçalho com mídia/variável, botão com variável) → DIVERGENTE", () => {
    const info = (componentes: unknown[], formato?: string) => ({
      nomeMeta: DEF.nomeMeta,
      idioma: DEF.idioma,
      status: "APPROVED",
      categoria: "MARKETING",
      ...analisarComponentes(componentes, formato),
    });
    const corpo = { type: "BODY", text: "Olá, {{1}}!" };
    expect(avaliarAprovacaoTemplate(DEF, info([corpo]))).toBe("APROVADO");
    expect(avaliarAprovacaoTemplate(DEF, info([{ type: "BODY", text: "Olá, {{primeiro_nome}}!" }], "NAMED"))).toBe("DIVERGENTE");
    expect(avaliarAprovacaoTemplate(DEF, info([{ type: "HEADER", format: "IMAGE" }, corpo]))).toBe("DIVERGENTE");
    expect(avaliarAprovacaoTemplate(DEF, info([{ type: "HEADER", format: "TEXT", text: "Oi {{1}}" }, corpo]))).toBe("DIVERGENTE");
    expect(avaliarAprovacaoTemplate(DEF, info([corpo, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://x/{{1}}" }] }]))).toBe("DIVERGENTE");
    expect(avaliarAprovacaoTemplate(DEF, info([corpo, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Parar" }] }]))).toBe("APROVADO");
    expect(avaliarAprovacaoTemplate(DEF, info([{ type: "BODY", text: "Olá, {{1}} e {{2}}!" }]))).toBe("DIVERGENTE");
  });
});

describe("configuração e seleção do provedor", () => {
  it("padrão = desativado (sem config, vazio, 'desativado'); nunca chama a rede", async () => {
    const { impl, chamadas } = fetchFalso(() => json(200, ACEITE));
    for (const cfg of [undefined, whatsappConfig({ provedorEnvio: "desativado" }), whatsappConfig({ provedorEnvio: "" })]) {
      const p = criarProvedorEnvioWhatsapp(cfg, impl);
      expect(p).toBeInstanceOf(ProvedorEnvioDesativado);
      expect(p.configurado()).toBe(false);
      await expect(p.enviarTemplate(ENTRADA)).rejects.toThrow();
      await expect(p.consultarTemplate("a", "pt_BR")).rejects.toThrow();
    }
    expect(chamadas).toHaveLength(0);
  });

  it("Meta selecionada com config completa e válida → adaptador Meta", () => {
    const p = criarProvedorEnvioWhatsapp(whatsappConfig());
    expect(p).toBeInstanceOf(ProvedorEnvioMetaCloudApi);
    expect(p.configurado()).toBe(true);
    expect(p.nome).toBe("meta-cloud-api");
  });

  it("config incompleta ou inválida NÃO ativa a Meta: desativado, aviso só com nomes de campo", () => {
    const invalidas: Partial<MetaWhatsappConfig>[] = [
      { accessToken: "" },
      { accessToken: "com espaço" },
      { phoneNumberId: "" },
      { phoneNumberId: "abc" },
      { businessAccountId: "" },
      { graphApiVersion: "26" },
      { graphApiVersion: "v26.0/../../x" },
      { timeoutMs: Number.NaN },
      { timeoutMs: 0 },
      { timeoutMs: 120_000 },
    ];
    for (const meta of invalidas) {
      const p = criarProvedorEnvioWhatsapp(whatsappConfig({}, meta));
      expect(p).toBeInstanceOf(ProvedorEnvioDesativado);
    }
    expect(logs.some((l) => l.includes("meta_configuracao_invalida") && l.includes("accessToken"))).toBe(true);
    semDadosSensiveis();
  });

  it("lerConfiguracaoMeta: lista todos os campos inválidos, nunca os valores", () => {
    const r = lerConfiguracaoMeta({ graphApiVersion: "", phoneNumberId: "", businessAccountId: "", accessToken: "", timeoutMs: 10_000 });
    expect(r).toEqual({ valida: false, camposInvalidos: ["graphApiVersion", "phoneNumberId", "businessAccountId", "accessToken"] });
    expect(lerConfiguracaoMeta(undefined).valida).toBe(false);
  });

  it("número da loja (WHATSAPP_OWNER_PHONE) é normalizado e bloqueado como destinatário", async () => {
    const { impl, chamadas } = fetchFalso(() => json(200, ACEITE));
    const p = criarProvedorEnvioWhatsapp(whatsappConfig({ ownerPhone: "(83) 91234-5678" }), impl);
    expect((await p.enviarTemplate(ENTRADA)).resultado).toBe("recusada");
    expect(chamadas).toHaveLength(0);
  });
});
