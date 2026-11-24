import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection, Model } from "mongoose";
import type { WhatsappConfig } from "../../../config/configuration.js";
import { mongooseModuloDeTeste } from "../../../test-utils/mongo-teste.util.js";
import { ClientesService } from "../../clientes/clientes.service.js";
import type { Sequencia } from "../../sequencias/schemas/sequencia.schema.js";
import { BloqueiosWhatsappService } from "../bloqueios/bloqueios-whatsapp.service.js";
import type { EnviarTemplateWhatsappDto } from "../dto/envios-whatsapp.dto.js";
import type { FetchMeta } from "../providers/meta/cliente-http-meta.js";
import { PROVEDOR_ENVIO_WHATSAPP, type ProvedorEnvioWhatsapp } from "../providers/provedor-envio-whatsapp.interface.js";
import { criarProvedorEnvioWhatsapp } from "../providers/selecionar-provedor-envio.js";
import { BloqueioWhatsapp, type BloqueioWhatsappDocument } from "../schemas/bloqueio-whatsapp.schema.js";
import { MensagemWhatsapp, type MensagemWhatsappDocument } from "../schemas/mensagem-whatsapp.schema.js";
import { TemplatesWhatsappService } from "../templates/templates-whatsapp.service.js";
import { WHATSAPP_PROVIDER } from "../whatsapp.constants.js";
import { WhatsappModule } from "../whatsapp.module.js";
import { EnviosWhatsappService } from "./envios-whatsapp.service.js";

/**
 * Fase 22.8.9.10.4 — fluxo COMPLETO de envio (MongoDB real descartável) com o ADAPTADOR META de verdade, criado pela
 * mesma fábrica do módulo (`criarProvedorEnvioWhatsapp`), sobre um `fetch` FALSO que imita a Graph API. Nenhuma
 * chamada à Meta, nenhuma credencial real. Prova que idempotência, bloqueios, aprovação de template e máscara de
 * telefone continuam valendo com o adaptador real.
 */
const TOKEN = "TOKEN-FICTICIO-DE-TESTE";
const JWT_MODULO_DE_TESTE = JwtModule.register({ global: true, secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } });

const CONFIG: WhatsappConfig = {
  ownerPhone: "",
  evolution: { apiUrl: "", apiKey: "", instanceName: "x", timeoutMs: 10_000 },
  provedorEnvio: "meta-cloud-api",
  meta: { graphApiVersion: "v26.0", phoneNumberId: "100000000000001", businessAccountId: "200000000000002", accessToken: TOKEN, timeoutMs: 1_000 },
};

interface Chamada {
  url: string;
  metodo: string;
  corpo: Record<string, unknown> | null;
}

/** Graph API falsa: GET de templates e POST de mensagens, com respostas trocáveis por teste. */
class GraphFalsa {
  chamadas: Chamada[] = [];
  statusTemplate = "APPROVED";
  private sequencia = 0;
  envio: (c: Chamada, signal: AbortSignal) => Promise<Response> = (c) => this.aceitar(c);

  /** Resposta de aceite documentada: `contacts[].wa_id` e `messages[].id` (wamid único por chamada). */
  async aceitar(c: Chamada): Promise<Response> {
    const to = (c.corpo as { to: string }).to;
    return json(200, {
      messaging_product: "whatsapp",
      contacts: [{ input: to, wa_id: to.slice(1) }],
      messages: [{ id: `wamid.TESTE${++this.sequencia}`, message_status: "accepted" }],
    });
  }

  restaurarEnvio(): void {
    this.envio = (c) => this.aceitar(c);
  }

  readonly fetch: FetchMeta = async (url, init) => {
    const c: Chamada = { url, metodo: init.method ?? "GET", corpo: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null };
    this.chamadas.push(c);
    if (c.metodo === "GET") {
      return json(200, {
        data: [
          {
            name: "mariela_aniversario_v2",
            language: "pt_BR",
            status: this.statusTemplate,
            category: "MARKETING",
            id: "1",
            components: [{ type: "BODY", text: "Olá, {{1}}! Feliz aniversário." }],
          },
        ],
      });
    }
    return this.envio(c, init.signal!);
  };

  posts(): Chamada[] {
    return this.chamadas.filter((c) => c.metodo === "POST");
  }
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

async function montarModulo(provedor: ProvedorEnvioWhatsapp): Promise<TestingModule> {
  const ref = await Test.createTestingModule({ imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, WhatsappModule] })
    .overrideProvider(PROVEDOR_ENVIO_WHATSAPP)
    .useValue(provedor)
    .overrideProvider(WHATSAPP_PROVIDER)
    .useValue({})
    .compile();
  await ref.init();
  return ref;
}

describe("Envio por template com o adaptador Meta (integração — MongoDB real, Graph API falsa)", () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let service: EnviosWhatsappService;
  let bloqueios: BloqueiosWhatsappService;
  let templates: TemplatesWhatsappService;
  let clientes: ClientesService;
  let mensagemModel: Model<MensagemWhatsappDocument>;
  let bloqueioModel: Model<BloqueioWhatsappDocument>;
  let graph: GraphFalsa;
  let contador = 0;
  let logs: string[] = [];
  let spies: ReturnType<typeof spyOn>[] = [];

  const telefoneUnico = () => `869${String(++contador).padStart(8, "0")}`;
  const novoCliente = (nome = "Joana Prado Teste") => clientes.criar({ nome, telefone: telefoneUnico() }, null);
  const pedido = (clienteId: string): EnviarTemplateWhatsappDto => ({
    idempotencyKey: randomUUID(),
    destinatario: { tipo: "CLIENTE", id: clienteId },
    template: "aniversario_v2",
  });

  beforeAll(async () => {
    graph = new GraphFalsa();
    moduleRef = await montarModulo(criarProvedorEnvioWhatsapp(CONFIG, graph.fetch));
    connection = moduleRef.get(getConnectionToken());
    service = moduleRef.get(EnviosWhatsappService);
    bloqueios = moduleRef.get(BloqueiosWhatsappService);
    templates = moduleRef.get(TemplatesWhatsappService);
    clientes = moduleRef.get(ClientesService);
    mensagemModel = moduleRef.get(getModelToken(MensagemWhatsapp.name));
    bloqueioModel = moduleRef.get(getModelToken(BloqueioWhatsapp.name));
    await mensagemModel.init();
    await bloqueioModel.init();
  }, 30_000);

  beforeEach(async () => {
    await mensagemModel.deleteMany({});
    await bloqueioModel.deleteMany({});
    graph.chamadas = [];
    graph.statusTemplate = "APPROVED";
    graph.restaurarEnvio();
    templates.invalidar("aniversario_v2");
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

  afterAll(async () => {
    await connection.collection("mensagens_whatsapp").deleteMany({});
    await connection.collection("whatsapp_bloqueios").deleteMany({});
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: "cliente" });
    await moduleRef.close();
  });

  function logsSemDadosSensiveis(telefone: string) {
    const tudo = logs.join("\n");
    expect(tudo).not.toContain(TOKEN);
    expect(tudo).not.toContain(telefone);
    expect(tudo).not.toContain("Joana");
    expect(tudo).not.toContain("Bearer");
  }

  it("aceite: aprovação consultada na Meta, POST com telefone do CADASTRO e primeiro nome; wamid e wa_id persistidos", async () => {
    const cliente = await novoCliente();
    const { mensagem, nova } = await service.enviar(pedido(cliente.id), "usuario-1");

    expect(nova).toBe(true);
    expect(mensagem.estado).toBe("aceita");
    expect(graph.chamadas.map((c) => c.metodo)).toEqual(["GET", "POST"]);
    expect(graph.chamadas[0]!.url).toBe("https://graph.facebook.com/v26.0/200000000000002/message_templates?name=mariela_aniversario_v2");
    const post = graph.posts()[0]!;
    expect(post.url).toBe("https://graph.facebook.com/v26.0/100000000000001/messages");
    expect(post.corpo).toMatchObject({ to: `+55${cliente.telefone}`, type: "template", template: { name: "mariela_aniversario_v2", language: { code: "pt_BR" } } });
    expect(JSON.stringify(post.corpo)).toContain('"text":"Joana"');

    const doc = await mensagemModel.findById(mensagem.id).lean();
    expect(doc?.wamid).toMatch(/^wamid\.TESTE\d+$/);
    expect(doc?.waId).toBe(`55${cliente.telefone}`);
    // Resposta pública: telefone mascarado, sem wamid nem parâmetros.
    expect(mensagem.destinatario.telefoneMascarado).toContain("****");
    expect(JSON.stringify(mensagem)).not.toContain(cliente.telefone);
    expect(JSON.stringify(mensagem)).not.toContain("wamid");
    logsSemDadosSensiveis(cliente.telefone);
  });

  it("idempotência preservada: repetir a mesma chave NÃO faz novo POST", async () => {
    const cliente = await novoCliente();
    const p = pedido(cliente.id);
    const a = await service.enviar(p, null);
    const b = await service.enviar(p, null);
    expect(b.nova).toBe(false);
    expect(b.mensagem.id).toBe(a.mensagem.id);
    expect(graph.posts()).toHaveLength(1);
  });

  it("concorrência: 6 requisições simultâneas com a mesma chave → 1 POST à Meta", async () => {
    const cliente = await novoCliente();
    const p = pedido(cliente.id);
    const original = graph.envio;
    graph.envio = async (c, s) => {
      await new Promise((r) => setTimeout(r, 60));
      return original(c, s);
    };
    const rs = await Promise.all(Array.from({ length: 6 }, () => service.enviar({ ...p }, null)));
    expect(new Set(rs.map((r) => r.mensagem.id)).size).toBe(1);
    expect(graph.posts()).toHaveLength(1);
  });

  it("timeout real do adaptador → indeterminada TIMEOUT; repetir não reenvia; sem retry", async () => {
    const cliente = await novoCliente();
    graph.envio = (_c, signal) =>
      new Promise<Response>((_, rejeitar) => signal.addEventListener("abort", () => rejeitar(new DOMException("aborted", "AbortError"))));
    const p = pedido(cliente.id);
    const { mensagem } = await service.enviar(p, null);
    expect(mensagem.estado).toBe("indeterminada");
    expect(mensagem.erro?.codigo).toBe("INDETERMINADO");
    expect((await mensagemModel.findById(mensagem.id).lean())?.erroCodigoProvedor).toBe("TIMEOUT");
    const repetida = await service.enviar(p, null);
    expect(repetida.nova).toBe(false);
    expect(graph.posts()).toHaveLength(1);
    logsSemDadosSensiveis(cliente.telefone);
  });

  it("5xx da Meta → indeterminada (não vira falha definitiva)", async () => {
    const cliente = await novoCliente();
    graph.envio = async () => json(503, { error: { code: 131016, message: "Service unavailable" } });
    const { mensagem } = await service.enviar(pedido(cliente.id), null);
    expect(mensagem.estado).toBe("indeterminada");
    expect(graph.posts()).toHaveLength(1);
  });

  it("131050 (opt-out de marketing) → falha OPT_OUT_MARKETING e o número entra no bloqueio; novo envio é barrado sem POST", async () => {
    const cliente = await novoCliente();
    graph.envio = async () => json(400, { error: { code: 131050, message: "x", fbtrace_id: "abc" } });
    const { mensagem } = await service.enviar(pedido(cliente.id), null);
    expect(mensagem.estado).toBe("falha");
    expect(mensagem.erro?.codigo).toBe("OPT_OUT_MARKETING");
    expect(await bloqueios.bloqueioAtivo(`+55${cliente.telefone}`)).not.toBeNull();

    graph.chamadas = [];
    await expect(service.enviar(pedido(cliente.id), null)).rejects.toMatchObject({ code: "WHATSAPP_CONTATO_BLOQUEADO" });
    expect(graph.posts()).toHaveLength(0);
  });

  it("Fase 22.8.9.10.5.1 — recusa síncrona 131049 (limite da Meta) ou 131026: falha classificada, SEM bloqueio; novo envio não é barrado", async () => {
    for (const [codigo, esperado] of [
      [131049, "LIMITE_MARKETING_DESTINATARIO"],
      [131026, "SEM_WHATSAPP"],
    ] as const) {
      const cliente = await novoCliente();
      graph.envio = async () => json(400, { error: { code: codigo } });
      const { mensagem } = await service.enviar(pedido(cliente.id), null);
      expect(mensagem.erro?.codigo).toBe(esperado);
      expect(await bloqueios.bloqueioAtivo(`+55${cliente.telefone}`)).toBeNull();
      graph.restaurarEnvio();
      expect((await service.enviar(pedido(cliente.id), null)).mensagem.estado).toBe("aceita");
    }
  });

  it("bloqueio ativo (ADMIN) → nada é gravado nem enviado à Meta", async () => {
    const cliente = await novoCliente();
    await bloqueios.bloquearNumero(`+55${cliente.telefone}`, null, "ADMIN", null);
    await expect(service.enviar(pedido(cliente.id), null)).rejects.toMatchObject({ code: "WHATSAPP_CONTATO_BLOQUEADO" });
    expect(graph.chamadas).toHaveLength(0);
    expect(await mensagemModel.countDocuments({})).toBe(0);
  });

  it("template não aprovado na Meta (PENDING) → 422 sem gravar e sem POST", async () => {
    const cliente = await novoCliente();
    graph.statusTemplate = "PENDING";
    await expect(service.enviar(pedido(cliente.id), null)).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_INDISPONIVEL" });
    expect(graph.posts()).toHaveLength(0);
    expect(await mensagemModel.countDocuments({})).toBe(0);
  });

  it("132001 no envio → falha TEMPLATE_INVALIDO e o cache de aprovação é descartado (próximo envio consulta de novo)", async () => {
    const cliente = await novoCliente();
    graph.envio = async () => json(400, { error: { code: 132001 } });
    const { mensagem } = await service.enviar(pedido(cliente.id), null);
    expect(mensagem.erro?.codigo).toBe("TEMPLATE_INVALIDO");
    graph.chamadas = [];
    graph.restaurarEnvio();
    await service.enviar(pedido(cliente.id), null);
    expect(graph.chamadas.map((c) => c.metodo)).toEqual(["GET", "POST"]);
  });

  it("190 (token inválido) → falha CREDENCIAL_INVALIDA; o token nunca aparece no banco, na resposta nem nos logs", async () => {
    const cliente = await novoCliente();
    graph.envio = async () => json(401, { error: { code: 190, message: `Invalid OAuth access token ${TOKEN}` } });
    const { mensagem } = await service.enviar(pedido(cliente.id), null);
    expect(mensagem.erro?.codigo).toBe("CREDENCIAL_INVALIDA");
    const doc = await mensagemModel.findById(mensagem.id).lean();
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
    expect(JSON.stringify(mensagem)).not.toContain(TOKEN);
    logsSemDadosSensiveis(cliente.telefone);
  });
});

describe("Envio por template com o provedor DESATIVADO (padrão) — integração", () => {
  it("sem configuração: 503 WHATSAPP_NOT_CONFIGURED, nada gravado, nenhuma chamada de rede", async () => {
    let chamadas = 0;
    const provedor = criarProvedorEnvioWhatsapp({ ...CONFIG, provedorEnvio: "desativado" }, async () => {
      chamadas += 1;
      return json(200, {});
    });
    const ref = await montarModulo(provedor);
    try {
      const clientes = ref.get(ClientesService);
      const cliente = await clientes.criar({ nome: "Desativado Teste", telefone: `879${String(Date.now()).slice(-8)}` }, null);
      await expect(
        ref.get(EnviosWhatsappService).enviar({ idempotencyKey: randomUUID(), destinatario: { tipo: "CLIENTE", id: cliente.id }, template: "aniversario_v2" }, null),
      ).rejects.toMatchObject({ code: "WHATSAPP_NOT_CONFIGURED" });
      expect(await ref.get<Model<MensagemWhatsappDocument>>(getModelToken(MensagemWhatsapp.name)).countDocuments({ destinatarioId: cliente._id })).toBe(0);
      expect(chamadas).toBe(0);
      const conn = ref.get<Connection>(getConnectionToken());
      await conn.collection("clientes").deleteMany({ _id: cliente._id });
      await conn.collection("eventos_cliente").deleteMany({});
    } finally {
      await ref.close();
    }
  }, 30_000);
});
