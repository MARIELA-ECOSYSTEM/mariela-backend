import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection, type Model } from "mongoose";
import { mongooseModuloDeTeste } from "../../../test-utils/mongo-teste.util.js";
import { ClientesService } from "../../clientes/clientes.service.js";
import type { Sequencia } from "../../sequencias/schemas/sequencia.schema.js";
import { BloqueiosWhatsappService } from "../bloqueios/bloqueios-whatsapp.service.js";
import type { EnviarTextoWhatsappDto } from "../dto/envios-whatsapp.dto.js";
import {
  PROVEDOR_ENVIO_WHATSAPP,
  type EnviarTemplateWhatsappInput,
  type EnviarTextoWhatsappInput,
  type InfoTemplateProvedorWhatsapp,
  type ProvedorEnvioWhatsapp,
  type ResultadoEnvioProvedorWhatsapp,
} from "../providers/provedor-envio-whatsapp.interface.js";
import { BloqueioWhatsapp, type BloqueioWhatsappDocument } from "../schemas/bloqueio-whatsapp.schema.js";
import { JanelaWhatsapp, type JanelaWhatsappDocument } from "../schemas/janela-whatsapp.schema.js";
import { MensagemWhatsapp, type MensagemWhatsappDocument } from "../schemas/mensagem-whatsapp.schema.js";
import { CONFIG_WEBHOOK_WHATSAPP } from "../webhook/configuracao-webhook-meta.js";
import { WebhookWhatsappService } from "../webhook/webhook-whatsapp.service.js";
import { WHATSAPP_PROVIDER } from "../whatsapp.constants.js";
import { WhatsappModule } from "../whatsapp.module.js";
import { JANELA_ATENDIMENTO_MS, LIMITE_TEXTO_LIVRE_WHATSAPP, MARGEM_SEGURANCA_JANELA_MS, PRAZO_ENVIANDO_MS } from "./envios-whatsapp.constants.js";
import { EnviosWhatsappService } from "./envios-whatsapp.service.js";
import { MensagensWhatsappRepository } from "./mensagens-whatsapp.repository.js";

/**
 * Fase 22.8.9.10.7.4 — texto livre na janela de 24 h, com MongoDB REAL descartável e o webhook de verdade (sem HTTP):
 * a janela só nasce de mensagens recebidas interpretadas pelo webhook. Provedor SEMPRE dublê: nenhuma chamada à Meta.
 */
const PHONE_ID = "100000000000001";
const CONFIG_WEBHOOK = { verifyToken: "VERIFY-TOKEN-FICTICIO-DE-TESTE", appSecret: "SEGREDO-FICTICIO-DE-TESTE-WEBHOOK", phoneNumberId: PHONE_ID };
const JWT_MODULO_DE_TESTE = JwtModule.register({ global: true, secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } });
const H = 60 * 60_000;

class ProvedorEnvioFalso implements ProvedorEnvioWhatsapp {
  readonly nome = "falso";
  ativo = true;
  atrasoMs = 0;
  textos: EnviarTextoWhatsappInput[] = [];
  templates: EnviarTemplateWhatsappInput[] = [];
  resultadoTexto: (i: EnviarTextoWhatsappInput) => Promise<ResultadoEnvioProvedorWhatsapp> = async (i) => ({
    resultado: "aceita",
    wamid: `wamid.TX${i.referenciaInterna}`,
    waId: i.telefoneE164.slice(1),
  });
  waIdTemplate: (telefoneE164: string) => string | null = (t) => t.slice(1);

  configurado(): boolean {
    return this.ativo;
  }
  async enviarTemplate(i: EnviarTemplateWhatsappInput): Promise<ResultadoEnvioProvedorWhatsapp> {
    this.templates.push(i);
    return { resultado: "aceita", wamid: `wamid.TP${i.referenciaInterna}`, waId: this.waIdTemplate(i.telefoneE164) };
  }
  async enviarTexto(i: EnviarTextoWhatsappInput): Promise<ResultadoEnvioProvedorWhatsapp> {
    this.textos.push(i);
    if (this.atrasoMs) await new Promise((r) => setTimeout(r, this.atrasoMs));
    return this.resultadoTexto(i);
  }
  async consultarTemplate(nomeMeta: string, idioma: string): Promise<InfoTemplateProvedorWhatsapp | null> {
    return { nomeMeta, idioma, status: "APPROVED", categoria: "MARKETING", quantidadeParametros: 1 };
  }
}

async function montarModulo(provedor: ProvedorEnvioWhatsapp, configWebhook: typeof CONFIG_WEBHOOK | null) {
  const moduleRef = await Test.createTestingModule({ imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, WhatsappModule] })
    .overrideProvider(CONFIG_WEBHOOK_WHATSAPP)
    .useValue(configWebhook)
    .overrideProvider(PROVEDOR_ENVIO_WHATSAPP)
    .useValue(provedor)
    .overrideProvider(WHATSAPP_PROVIDER)
    .useValue({})
    .compile();
  await moduleRef.init();
  return moduleRef;
}

describe("Texto livre na janela de 24 h (integração — MongoDB real, webhook real, provedor falso)", () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let service: EnviosWhatsappService;
  let webhook: WebhookWhatsappService;
  let bloqueios: BloqueiosWhatsappService;
  let mensagensRepo: MensagensWhatsappRepository;
  let clientes: ClientesService;
  let mensagemModel: Model<MensagemWhatsappDocument>;
  let bloqueioModel: Model<BloqueioWhatsappDocument>;
  let janelaModel: Model<JanelaWhatsappDocument>;
  let provedor: ProvedorEnvioFalso;
  let contador = 0;
  let agora = new Date("2026-11-24T15:00:00Z");
  let logs: string[] = [];
  let spies: ReturnType<typeof spyOn>[] = [];

  const telefoneUnico = () => `839${String(++contador).padStart(8, "0")}`;
  const waIdDe = (telefone: string) => `55${telefone}`;
  const novoCliente = async (nome = "Cliente Texto Livre") => {
    const telefone = telefoneUnico();
    const c = await clientes.criar({ nome, telefone }, null);
    return { id: String(c._id), telefone };
  };
  const pedido = (clienteId: string, texto = "Olá! Seu pedido está pronto.", extra: Partial<EnviarTextoWhatsappDto> = {}): EnviarTextoWhatsappDto => ({
    idempotencyKey: randomUUID(),
    destinatario: { tipo: "CLIENTE", id: clienteId },
    texto,
    ...extra,
  });

  const envelope = (changes: unknown[]) => ({ object: "whatsapp_business_account", entry: [{ id: "200000000000002", changes }] });
  const metadata = (phone = PHONE_ID) => ({ display_phone_number: "15550000000", phone_number_id: phone });
  const segundos = (d: Date) => String(Math.floor(d.getTime() / 1000));
  const recebida = (from: string, quando: Date, extra: Record<string, unknown> = {}) => ({
    from,
    id: `wamid.IN${++contador}`,
    timestamp: segundos(quando),
    type: "text",
    text: { body: "CONTEUDO-PRIVADO-DO-CLIENTE" },
    ...extra,
  });
  const notificar = (mensagens: unknown[], phone = PHONE_ID) =>
    webhook.processar(webhook.interpretar(envelope([{ field: "messages", value: { messaging_product: "whatsapp", metadata: metadata(phone), messages: mensagens } }])));
  /** O cliente escreveu `ha` ms antes de `agora`. */
  const clienteEscreveu = (telefone: string, ha = H) => notificar([recebida(waIdDe(telefone), new Date(agora.getTime() - ha))]);

  beforeAll(async () => {
    provedor = new ProvedorEnvioFalso();
    moduleRef = await montarModulo(provedor, CONFIG_WEBHOOK);
    connection = moduleRef.get(getConnectionToken());
    service = moduleRef.get(EnviosWhatsappService);
    webhook = moduleRef.get(WebhookWhatsappService);
    bloqueios = moduleRef.get(BloqueiosWhatsappService);
    mensagensRepo = moduleRef.get(MensagensWhatsappRepository);
    clientes = moduleRef.get(ClientesService);
    mensagemModel = moduleRef.get(getModelToken(MensagemWhatsapp.name));
    bloqueioModel = moduleRef.get(getModelToken(BloqueioWhatsapp.name));
    janelaModel = moduleRef.get(getModelToken(JanelaWhatsapp.name));
    await mensagemModel.init();
    await bloqueioModel.init();
    await janelaModel.init();
    service.relogio = () => agora;
    webhook.relogio = () => agora;
    bloqueios.relogio = () => agora;
  }, 30_000);

  beforeEach(async () => {
    await mensagemModel.deleteMany({});
    await bloqueioModel.deleteMany({});
    await janelaModel.deleteMany({});
    provedor.ativo = true;
    provedor.atrasoMs = 0;
    provedor.textos = [];
    provedor.templates = [];
    provedor.resultadoTexto = new ProvedorEnvioFalso().resultadoTexto;
    provedor.waIdTemplate = new ProvedorEnvioFalso().waIdTemplate;
    agora = new Date("2026-11-24T15:00:00Z");
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
    await connection.collection("whatsapp_janelas").deleteMany({});
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: "cliente" });
    await moduleRef.close();
  });

  describe("janela (gravada só pelo webhook)", () => {
    it("índices da coleção: contato único por número empresarial + TTL", async () => {
      const idx = Object.fromEntries((await janelaModel.collection.indexes()).map((i) => [i.name, i]));
      expect(idx["contato_unico"]?.unique).toBe(true);
      expect(idx["contato_unico"]?.key).toEqual({ phoneNumberId: 1, waId: 1 });
      expect(idx["expiracao"]?.expireAfterSeconds).toBeGreaterThan(0);
    });

    it("dentro da janela: permitido, com o fim calculado pelo backend; sem conteúdo nem número no banco/logs", async () => {
      const c = await novoCliente();
      const resumo = await clienteEscreveu(c.telefone, 2 * H);
      expect(resumo.janelas).toEqual({ criada: 1, estendida: 0, inalterada: 0, antiga: 0 });

      const e = await service.elegibilidadeTexto(c.id);
      const ultima = new Date(Number(segundos(new Date(agora.getTime() - 2 * H))) * 1000);
      expect(e).toMatchObject({ permitido: true, motivo: null, limiteCaracteres: LIMITE_TEXTO_LIVRE_WHATSAPP });
      expect(e.ultimaMensagemRecebidaEm).toBe(ultima.toISOString());
      expect(e.janelaExpiraEm).toBe(new Date(ultima.getTime() + JANELA_ATENDIMENTO_MS - MARGEM_SEGURANCA_JANELA_MS).toISOString());
      expect(e.telefoneMascarado).not.toBeNull();
      expect(e.telefoneMascarado).not.toContain(c.telefone);

      const docs = await janelaModel.find().lean();
      expect(docs).toHaveLength(1);
      expect(JSON.stringify(docs)).not.toContain("CONTEUDO-PRIVADO");
      expect(logs.join("\n")).not.toContain("CONTEUDO-PRIVADO");
      expect(logs.join("\n")).not.toContain(waIdDe(c.telefone));
    });

    it("sem mensagem recebida: SEM_MENSAGEM_RECEBIDA (nunca presume aberta)", async () => {
      const c = await novoCliente();
      expect(await service.elegibilidadeTexto(c.id)).toMatchObject({ permitido: false, motivo: "SEM_MENSAGEM_RECEBIDA", janelaExpiraEm: null });
    });

    it("fora da janela: o relógio do backend passa do fim → JANELA_EXPIRADA; mensagem de 25 h atrás nem é gravada", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone, H);
      agora = new Date(agora.getTime() + JANELA_ATENDIMENTO_MS - MARGEM_SEGURANCA_JANELA_MS - H);
      expect((await service.elegibilidadeTexto(c.id)).motivo).toBe("JANELA_EXPIRADA");

      const d = await novoCliente();
      const resumo = await clienteEscreveu(d.telefone, 25 * H);
      expect(resumo.janelas.antiga).toBe(1);
      expect((await service.elegibilidadeTexto(d.id)).motivo).toBe("SEM_MENSAGEM_RECEBIDA");
    });

    it("mensagem recebida inválida não abre janela: system, reaction, unsupported, do próprio número, sem timestamp", async () => {
      const c = await novoCliente();
      const w = waIdDe(c.telefone);
      const quando = new Date(agora.getTime() - H);
      const resumo = await notificar([
        recebida(w, quando, { type: "system" }),
        recebida(w, quando, { type: "reaction" }),
        recebida(w, quando, { type: "unsupported" }),
        recebida(w, quando, { timestamp: undefined }),
        recebida(w, quando, { id: "id inválido" }),
        recebida("15550000000", quando),
      ]);
      expect(resumo.contagem.mensagensIgnoradas).toBe(6);
      expect(await janelaModel.countDocuments()).toBe(0);
      expect((await service.elegibilidadeTexto(c.id)).permitido).toBe(false);
    });

    it("evento DUPLICADO (reentrega horas depois) não estende a janela", async () => {
      const c = await novoCliente();
      const original = recebida(waIdDe(c.telefone), new Date(agora.getTime() - H));
      await notificar([original]);
      const antes = await service.elegibilidadeTexto(c.id);

      agora = new Date(agora.getTime() + 20 * H);
      const resumo = await notificar([original]); // a Meta reentrega o MESMO evento
      expect(resumo.janelas).toEqual({ criada: 0, estendida: 0, inalterada: 1, antiga: 0 });
      const depois = await service.elegibilidadeTexto(c.id);
      expect(depois.janelaExpiraEm).toBe(antes.janelaExpiraEm);
      expect(await janelaModel.countDocuments()).toBe(1);
    });

    it("eventos FORA DE ORDEM: o mais antigo não encurta; o mais novo estende", async () => {
      const c = await novoCliente();
      const w = waIdDe(c.telefone);
      await notificar([recebida(w, new Date(agora.getTime() - H))]);
      const r1 = await notificar([recebida(w, new Date(agora.getTime() - 5 * H))]);
      expect(r1.janelas.inalterada).toBe(1);
      const doc1 = await janelaModel.findOne().lean();
      expect(doc1!.ultimaMensagemEm.toISOString()).toBe(new Date(Number(segundos(new Date(agora.getTime() - H))) * 1000).toISOString());
      const r2 = await notificar([recebida(w, new Date(agora.getTime() - 60_000))]);
      expect(r2.janelas.estendida).toBe(1);
    });

    it("timestamp no FUTURO é limitado ao relógio do backend", async () => {
      const c = await novoCliente();
      await notificar([recebida(waIdDe(c.telefone), new Date(agora.getTime() + 48 * H))]);
      const e = await service.elegibilidadeTexto(c.id);
      expect(e.ultimaMensagemRecebidaEm).toBe(agora.toISOString());
      expect(new Date(e.janelaExpiraEm!).getTime()).toBe(agora.getTime() + JANELA_ATENDIMENTO_MS - MARGEM_SEGURANCA_JANELA_MS);
    });

    it("eventos simultâneos do mesmo contato convergem para UM registro", async () => {
      const c = await novoCliente();
      const w = waIdDe(c.telefone);
      await Promise.all(Array.from({ length: 10 }, (_, i) => notificar([recebida(w, new Date(agora.getTime() - (i + 1) * 60_000))])));
      expect(await janelaModel.countDocuments({ waId: w })).toBe(1);
      expect((await service.elegibilidadeTexto(c.id)).permitido).toBe(true);
    });

    it("número empresarial DIFERENTE não abre janela", async () => {
      const c = await novoCliente();
      const resumo = await notificar([recebida(waIdDe(c.telefone), new Date(agora.getTime() - H))], "999999999999999");
      expect(resumo.contagem.outroNumero).toBe(1);
      expect(await janelaModel.countDocuments()).toBe(0);
      expect((await service.elegibilidadeTexto(c.id)).motivo).toBe("SEM_MENSAGEM_RECEBIDA");
    });

    it("mensagem de OUTRO contato nunca torna este cliente elegível (comparação exata)", async () => {
      const c = await novoCliente();
      const outro = telefoneUnico();
      await clienteEscreveu(outro);
      expect((await service.elegibilidadeTexto(c.id)).motivo).toBe("SEM_MENSAGEM_RECEBIDA");
    });

    it("wa_id sem o nono dígito: vale SÓ se a Meta já o devolveu num envio a este número", async () => {
      const c = await novoCliente();
      const semNono = `55${c.telefone.slice(0, 2)}${c.telefone.slice(3)}`; // 55 + DDD + 8 dígitos
      await notificar([recebida(semNono, new Date(agora.getTime() - H))]);
      expect((await service.elegibilidadeTexto(c.id)).motivo).toBe("SEM_MENSAGEM_RECEBIDA");

      provedor.waIdTemplate = () => semNono;
      await service.enviar({ idempotencyKey: randomUUID(), destinatario: { tipo: "CLIENTE", id: c.id }, template: "aniversario_v2" }, null);
      expect((await service.elegibilidadeTexto(c.id)).permitido).toBe(true);
    });
  });

  describe("elegibilidade: demais condições", () => {
    it("cliente inexistente → 404", async () => {
      await expect(service.elegibilidadeTexto("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(service.enviarTexto(pedido("65f1a2b3c4d5e6f7a8b9c0d1"), null)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(provedor.textos).toHaveLength(0);
    });

    it("telefone do cadastro inválido → TELEFONE_INVALIDO; envio → WHATSAPP_INVALID_NUMBER, nada gravado", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      await connection.collection("clientes").updateOne({ _id: new Types.ObjectId(c.id) }, { $set: { telefone: "12345" } });
      expect(await service.elegibilidadeTexto(c.id)).toMatchObject({ permitido: false, motivo: "TELEFONE_INVALIDO", telefoneMascarado: null });
      await expect(service.enviarTexto(pedido(c.id), null)).rejects.toMatchObject({ code: "WHATSAPP_INVALID_NUMBER" });
      expect(await mensagemModel.countDocuments()).toBe(0);
      expect(provedor.textos).toHaveLength(0);
    });

    it("cliente bloqueado → CONTATO_BLOQUEADO mesmo com janela aberta; envio 422, provedor não chamado", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      await bloqueios.bloquearCliente(c.id, "Pediu", null);
      expect((await service.elegibilidadeTexto(c.id)).motivo).toBe("CONTATO_BLOQUEADO");
      await expect(service.enviarTexto(pedido(c.id), null)).rejects.toMatchObject({ code: "WHATSAPP_CONTATO_BLOQUEADO" });
      expect(await mensagemModel.countDocuments()).toBe(0);
      expect(provedor.textos).toHaveLength(0);
    });

    it("provedor não configurado → PROVEDOR_NAO_CONFIGURADO; envio WHATSAPP_NOT_CONFIGURED", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      provedor.ativo = false;
      expect((await service.elegibilidadeTexto(c.id)).motivo).toBe("PROVEDOR_NAO_CONFIGURADO");
      await expect(service.enviarTexto(pedido(c.id), null)).rejects.toMatchObject({ code: "WHATSAPP_NOT_CONFIGURED" });
      expect(provedor.textos).toHaveLength(0);
    });

    it("webhook não configurado → WEBHOOK_NAO_CONFIGURADO (sem fonte de evidência, nunca permite)", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      const outroProvedor = new ProvedorEnvioFalso();
      const semWebhook = await montarModulo(outroProvedor, null);
      try {
        const s = semWebhook.get(EnviosWhatsappService);
        s.relogio = () => agora;
        expect((await s.elegibilidadeTexto(c.id)).motivo).toBe("WEBHOOK_NAO_CONFIGURADO");
        await expect(s.enviarTexto(pedido(c.id), null)).rejects.toMatchObject({ code: "WHATSAPP_JANELA_FECHADA" });
        expect(outroProvedor.textos).toHaveLength(0);
      } finally {
        await semWebhook.close();
      }
    });
  });

  describe("envio", () => {
    it("sucesso: destinatário e número SÓ do cadastro, texto aparado; registro TEXTO aceito; nada sensível em log", async () => {
      const c = await novoCliente("Joana Prado");
      await clienteEscreveu(c.telefone);
      const { mensagem, nova } = await service.enviarTexto(pedido(c.id, "  Olá, Joana!\nSeu pedido chegou.  "), "usuario-1");

      expect(nova).toBe(true);
      expect(mensagem).toMatchObject({ tipo: "TEXTO", estado: "aceita", template: null, texto: "Olá, Joana!\nSeu pedido chegou.", origem: "INDIVIDUAL", erro: null });
      expect(provedor.textos).toEqual([{ telefoneE164: `+55${c.telefone}`, texto: "Olá, Joana!\nSeu pedido chegou.", referenciaInterna: mensagem.id }]);
      expect(JSON.stringify(mensagem)).not.toContain(c.telefone);

      const doc = await mensagemModel.findById(mensagem.id).lean();
      expect(doc).toMatchObject({ tipo: "TEXTO", templateChave: null, texto: "Olá, Joana!\nSeu pedido chegou.", usuarioId: "usuario-1", telefoneE164: `+55${c.telefone}` });
      const tudo = logs.join("\n");
      expect(tudo).toContain("whatsapp.envio.resultado");
      expect(tudo).not.toContain("Seu pedido chegou");
      expect(tudo).not.toContain(c.telefone);
      expect(tudo).not.toContain("Joana");
    });

    it("fora da janela: 422 WHATSAPP_JANELA_FECHADA, nada gravado, provedor não chamado", async () => {
      const c = await novoCliente();
      await expect(service.enviarTexto(pedido(c.id), null)).rejects.toMatchObject({ code: "WHATSAPP_JANELA_FECHADA" });
      await clienteEscreveu(c.telefone, 23 * H + 55 * 60_000); // dentro de 24 h, mas na margem de segurança
      await expect(service.enviarTexto(pedido(c.id), null)).rejects.toMatchObject({ code: "WHATSAPP_JANELA_FECHADA" });
      expect(await mensagemModel.countDocuments()).toBe(0);
      expect(provedor.textos).toHaveLength(0);
    });

    it("a janela fecha entre a consulta e o envio: o envio confere de novo e recusa", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone, H);
      expect((await service.elegibilidadeTexto(c.id)).permitido).toBe(true);
      agora = new Date(agora.getTime() + 23 * H);
      await expect(service.enviarTexto(pedido(c.id), null)).rejects.toMatchObject({ code: "WHATSAPP_JANELA_FECHADA" });
      expect(provedor.textos).toHaveLength(0);
    });

    it("texto vazio, só espaços, com caractere de controle ou acima do limite → VALIDATION_ERROR antes de tudo", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      for (const texto of ["", "    ", "\n\n", "oi\u0000", "a".repeat(LIMITE_TEXTO_LIVRE_WHATSAPP + 1)]) {
        await expect(service.enviarTexto(pedido(c.id, texto), null)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
      expect(await mensagemModel.countDocuments()).toBe(0);
      expect(provedor.textos).toHaveLength(0);
    });

    it("falha conhecida (recusa do provedor, nada saiu) → falha registrada, sem bloqueio", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      provedor.resultadoTexto = async () => ({ resultado: "recusada", codigo: "PROVEDOR_INDISPONIVEL", codigoProvedor: "CONEXAO_RECUSADA" });
      const { mensagem } = await service.enviarTexto(pedido(c.id), null);
      expect(mensagem).toMatchObject({ estado: "falha", erro: { codigo: "PROVEDOR_INDISPONIVEL" } });
      expect(await bloqueioModel.countDocuments()).toBe(0);
    });

    it("Meta recusa por janela (131047, síncrono) → falha JANELA_FECHADA, sem bloqueio", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      provedor.resultadoTexto = async () => ({ resultado: "recusada", codigo: "JANELA_FECHADA", codigoProvedor: "131047" });
      const { mensagem } = await service.enviarTexto(pedido(c.id), null);
      expect(mensagem).toMatchObject({ estado: "falha", erro: { codigo: "JANELA_FECHADA" } });
      expect(await bloqueioModel.countDocuments()).toBe(0);
    });

    it("falha DEPOIS do envio (webhook failed 131047 após o aceite) → falha JANELA_FECHADA; delivered tardio não regride", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      const { mensagem } = await service.enviarTexto(pedido(c.id), null);
      const wamid = `wamid.TX${mensagem.id}`;
      const status = (s: Record<string, unknown>) =>
        webhook.processar(webhook.interpretar(envelope([{ field: "messages", value: { messaging_product: "whatsapp", metadata: metadata(), statuses: [s] } }])));
      await status({ id: wamid, status: "failed", timestamp: segundos(agora), errors: [{ code: 131047 }] });
      expect(await service.obter(mensagem.id)).toMatchObject({ estado: "falha", erro: { codigo: "JANELA_FECHADA" } });
      await status({ id: wamid, status: "delivered", timestamp: segundos(agora) });
      expect((await service.obter(mensagem.id)).estado).toBe("falha");
      expect(await bloqueioModel.countDocuments()).toBe(0);
    });

    it("timeout (indeterminada) → registrado como indeterminada, SEM retry; repetir a chave só lê", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      provedor.resultadoTexto = async () => ({ resultado: "indeterminada", codigoProvedor: "TIMEOUT" });
      const p = pedido(c.id);
      const { mensagem } = await service.enviarTexto(p, null);
      expect(mensagem).toMatchObject({ estado: "indeterminada", erro: { codigo: "INDETERMINADO" } });

      const repetida = await service.enviarTexto(p, null);
      expect(repetida).toMatchObject({ nova: false, mensagem: { id: mensagem.id, estado: "indeterminada" } });
      await service.listar({ clienteId: c.id, page: 1, limit: 20 });
      await service.obter(mensagem.id);
      expect(provedor.textos).toHaveLength(1);
    });

    it("exceção inesperada do provedor → indeterminada (na dúvida, nunca reenviar)", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      provedor.resultadoTexto = async () => {
        throw new Error("conexão caiu no meio");
      };
      const { mensagem } = await service.enviarTexto(pedido(c.id), null);
      expect(mensagem.estado).toBe("indeterminada");
      expect(provedor.textos).toHaveLength(1);
    });

    it("processo abandonado em `enviando` vira indeterminada, e uma resposta tardia não rebaixa estado mais avançado", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      const { mensagem } = await service.enviarTexto(pedido(c.id), null);
      const id = (await mensagemModel.findById(mensagem.id))!._id;
      // aceita → entregue (webhook); depois, escritas atrasadas de outro processo não mudam nada.
      await webhook.processar(
        webhook.interpretar(envelope([{ field: "messages", value: { messaging_product: "whatsapp", metadata: metadata(), statuses: [{ id: `wamid.TX${mensagem.id}`, status: "delivered", timestamp: segundos(agora) }] } }])),
      );
      expect(await mensagensRepo.registrarIndeterminada(id, "TIMEOUT", agora)).toBe(false);
      expect(await mensagensRepo.registrarAceita(id, "wamid.OUTRO", null, agora)).toBe(false);
      agora = new Date(agora.getTime() + PRAZO_ENVIANDO_MS * 5);
      await mensagensRepo.converterAbandonadas(agora);
      expect((await service.obter(mensagem.id)).estado).toBe("entregue");
    });
  });

  describe("idempotência e concorrência", () => {
    it("mesma chave + mesmo texto → mesmo registro (nova: false), UMA chamada; mesmo texto com outra chave = outra mensagem", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      const p = pedido(c.id);
      const a = await service.enviarTexto(p, null);
      const b = await service.enviarTexto({ ...p, texto: `  ${p.texto}  ` }, null); // aparado = mesmo conteúdo
      expect(b).toMatchObject({ nova: false, mensagem: { id: a.mensagem.id } });
      expect(provedor.textos).toHaveLength(1);
      await service.enviarTexto(pedido(c.id), null);
      expect(provedor.textos).toHaveLength(2);
    });

    it("mesma chave com texto OU destinatário diferente → 409, nada enviado", async () => {
      const c = await novoCliente();
      const d = await novoCliente();
      await clienteEscreveu(c.telefone);
      await clienteEscreveu(d.telefone);
      const p = pedido(c.id);
      await service.enviarTexto(p, null);
      await expect(service.enviarTexto({ ...p, texto: "Outro texto" }, null)).rejects.toMatchObject({ code: "WHATSAPP_IDEMPOTENCIA_CONFLITO" });
      await expect(service.enviarTexto({ ...p, destinatario: { tipo: "CLIENTE", id: d.id } }, null)).rejects.toMatchObject({
        code: "WHATSAPP_IDEMPOTENCIA_CONFLITO",
      });
      expect(provedor.textos).toHaveLength(1);
    });

    it("a chave de um TEMPLATE não pode ser reaproveitada para TEXTO (409)", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      const chave = randomUUID();
      await service.enviar({ idempotencyKey: chave, destinatario: { tipo: "CLIENTE", id: c.id }, template: "aniversario_v2" }, null);
      await expect(service.enviarTexto(pedido(c.id, "Olá", { idempotencyKey: chave }), null)).rejects.toMatchObject({ code: "WHATSAPP_IDEMPOTENCIA_CONFLITO" });
      expect(provedor.textos).toHaveLength(0);
    });

    it("10 requisições SIMULTÂNEAS com a mesma chave (duplo clique) → UMA chamada ao provedor, um registro", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      provedor.atrasoMs = 60;
      const p = pedido(c.id);
      const resultados = await Promise.all(Array.from({ length: 10 }, () => service.enviarTexto(p, null)));
      expect(provedor.textos).toHaveLength(1);
      expect(new Set(resultados.map((r) => r.mensagem.id)).size).toBe(1);
      expect(resultados.filter((r) => r.nova)).toHaveLength(1);
      expect(await mensagemModel.countDocuments({ idempotencyKey: p.idempotencyKey })).toBe(1);
    });

    it("repetição depois que a janela fechou devolve o registro existente (não recusa, não reenvia)", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      const p = pedido(c.id);
      const a = await service.enviarTexto(p, null);
      agora = new Date(agora.getTime() + 30 * H);
      expect(await service.enviarTexto(p, null)).toMatchObject({ nova: false, mensagem: { id: a.mensagem.id } });
      expect(provedor.textos).toHaveLength(1);
    });
  });

  describe("histórico e regressão do template", () => {
    it("histórico do cliente traz TEXTO (com o texto) e TEMPLATE (sem texto), em ordem", async () => {
      const c = await novoCliente();
      await clienteEscreveu(c.telefone);
      await service.enviar({ idempotencyKey: randomUUID(), destinatario: { tipo: "CLIENTE", id: c.id }, template: "aniversario_v2" }, null);
      agora = new Date(agora.getTime() + 1000);
      await service.enviarTexto(pedido(c.id, "Texto livre do histórico"), null);
      const { data, meta } = await service.listar({ clienteId: c.id, page: 1, limit: 20 });
      expect(meta.total).toBe(2);
      expect(data[0]).toMatchObject({ tipo: "TEXTO", texto: "Texto livre do histórico", template: null });
      expect(data[1]).toMatchObject({ tipo: "TEMPLATE", texto: null, template: { chave: "aniversario_v2", categoria: "MARKETING" } });
    });

    it("registro antigo (sem `tipo`, gravado antes desta fase) é lido como TEMPLATE", async () => {
      const c = await novoCliente();
      const { mensagem } = await service.enviar({ idempotencyKey: randomUUID(), destinatario: { tipo: "CLIENTE", id: c.id }, template: "aniversario_v2" }, null);
      await connection.collection("mensagens_whatsapp").updateOne({ idempotencyKey: mensagem.idempotencyKey }, { $unset: { tipo: "", texto: "" } });
      expect(await service.obter(mensagem.id)).toMatchObject({ tipo: "TEMPLATE", template: { chave: "aniversario_v2" }, texto: null });
    });

    it("schema: TEMPLATE sem chave de template, ou TEXTO sem texto, é recusado pelo banco", async () => {
      const base = {
        hashConteudo: "h",
        destinatarioTipo: "CLIENTE" as const,
        destinatarioId: new Types.ObjectId(),
        telefoneE164: "+5583900000000",
        origem: "INDIVIDUAL" as const,
        campanhaTipo: null,
        campanhaAno: null,
        chaveDeduplicacao: null,
        usuarioId: null,
      };
      await expect(
        mensagensRepo.reservar({ ...base, idempotencyKey: randomUUID(), templateChave: null, templateNomeMeta: null, templateIdioma: null, templateCategoria: null }, agora),
      ).rejects.toThrow();
      await expect(
        mensagensRepo.reservar(
          { ...base, idempotencyKey: randomUUID(), tipo: "TEXTO", texto: null, templateChave: null, templateNomeMeta: null, templateIdioma: null, templateCategoria: null },
          agora,
        ),
      ).rejects.toThrow();
    });

    it("envio por template segue igual (aceita, sem depender de janela) e mensagem recebida não bloqueia ninguém", async () => {
      const c = await novoCliente();
      const { mensagem } = await service.enviar({ idempotencyKey: randomUUID(), destinatario: { tipo: "CLIENTE", id: c.id }, template: "aniversario_v2" }, null);
      expect(mensagem).toMatchObject({ tipo: "TEMPLATE", estado: "aceita", texto: null });
      expect(provedor.templates).toHaveLength(1);
      await notificar([recebida(waIdDe(c.telefone), new Date(agora.getTime() - H), { text: { body: "SAIR" } })]);
      expect(await bloqueioModel.countDocuments()).toBe(0);
    });
  });
});
