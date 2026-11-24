import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection, type Model } from "mongoose";
import { mongooseModuloDeTeste } from "../../../test-utils/mongo-teste.util.js";
import { ClientesService } from "../../clientes/clientes.service.js";
import type { Sequencia } from "../../sequencias/schemas/sequencia.schema.js";
import { BloqueiosWhatsappService } from "../bloqueios/bloqueios-whatsapp.service.js";
import { EnviosWhatsappService } from "../envios/envios-whatsapp.service.js";
import { MensagensWhatsappRepository } from "../envios/mensagens-whatsapp.repository.js";
import { PROVEDOR_ENVIO_WHATSAPP, type ProvedorEnvioWhatsapp } from "../providers/provedor-envio-whatsapp.interface.js";
import { BloqueioWhatsapp, type BloqueioWhatsappDocument } from "../schemas/bloqueio-whatsapp.schema.js";
import { MensagemWhatsapp, type MensagemWhatsappDocument } from "../schemas/mensagem-whatsapp.schema.js";
import { WHATSAPP_PROVIDER } from "../whatsapp.constants.js";
import { WhatsappModule } from "../whatsapp.module.js";
import { CONFIG_WEBHOOK_WHATSAPP } from "./configuracao-webhook-meta.js";
import { PALAVRAS_CHAVE_OPT_OUT } from "./opt-out-palavras-chave.js";
import { WebhookWhatsappService } from "./webhook-whatsapp.service.js";

/**
 * Fase 22.8.9.10.5 — processamento do webhook com MongoDB REAL descartável: correlação por `wamid`, máquina de
 * estados, concorrência, idempotência e opt-out com bloqueio por número. Sem rede, sem credencial. A lista de
 * palavras-chave aqui é a de TESTE (`SAIR`, `Sair`) — a aprovada em produção continua vazia.
 */
const PHONE_ID = "100000000000001";
const JWT_MODULO_DE_TESTE = JwtModule.register({ global: true, secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } });

/** Provedor de envio dublê, só para os testes de regressão do envio (aprovação APPROVED, aceite com wamid). */
const provedor: ProvedorEnvioWhatsapp & { chamadas: number } = {
  nome: "falso",
  chamadas: 0,
  configurado: () => true,
  async enviarTemplate(i) {
    provedor.chamadas += 1;
    return { resultado: "aceita", wamid: `wamid.ENVIO${i.referenciaInterna}`, waId: i.telefoneE164.slice(1) };
  },
  async consultarTemplate(nomeMeta, idioma) {
    return { nomeMeta, idioma, status: "APPROVED", categoria: "MARKETING", quantidadeParametros: 1 };
  },
};

describe("Webhook WhatsApp (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let webhook: WebhookWhatsappService;
  let mensagensRepo: MensagensWhatsappRepository;
  let bloqueios: BloqueiosWhatsappService;
  let envios: EnviosWhatsappService;
  let clientes: ClientesService;
  let mensagemModel: Model<MensagemWhatsappDocument>;
  let bloqueioModel: Model<BloqueioWhatsappDocument>;
  let contador = 0;

  const envelope = (changes: unknown[]) => ({ object: "whatsapp_business_account", entry: [{ id: "200000000000002", changes }] });
  const metadata = { display_phone_number: "15550000000", phone_number_id: PHONE_ID };
  const notificarStatus = (...statuses: { id: string; status: string; timestamp?: string; errors?: unknown[] }[]) =>
    webhook.processar(webhook.interpretar(envelope([{ field: "messages", value: { messaging_product: "whatsapp", metadata, statuses } }])));
  const notificarTexto = (from: string, body: string) =>
    webhook.processar(
      webhook.interpretar(
        envelope([{ field: "messages", value: { messaging_product: "whatsapp", metadata, messages: [{ from, id: `wamid.IN${++contador}`, timestamp: "1", type: "text", text: { body } }] } }]),
      ),
    );
  const notificarPreferencia = (wa_id: string, value = "stop") =>
    webhook.processar(
      webhook.interpretar(
        envelope([{ field: "user_preferences", value: { messaging_product: "whatsapp", metadata, user_preferences: [{ wa_id, category: "marketing_messages", value, timestamp: 1731705721 }] } }]),
      ),
    );

  /** Mensagem já ACEITA pelo provedor (mesmo caminho do envio real: reserva → posse → aceite). */
  async function mensagemAceita(telefoneE164 = `+55839${String(++contador).padStart(8, "0")}`) {
    const agora = new Date("2026-11-24T12:00:00Z");
    const m = await mensagensRepo.reservar(
      {
        idempotencyKey: randomUUID(),
        hashConteudo: "h",
        destinatarioTipo: "CLIENTE",
        destinatarioId: new Types.ObjectId(),
        telefoneE164,
        templateChave: "aniversario_v1",
        templateNomeMeta: "mariela_aniversario_v1",
        templateIdioma: "pt_BR",
        templateCategoria: "MARKETING",
        origem: "INDIVIDUAL",
        campanhaTipo: null,
        campanhaAno: null,
        chaveDeduplicacao: null,
        usuarioId: null,
      },
      agora,
    );
    await mensagensRepo.assumirEnvio(m._id, agora);
    const wamid = `wamid.T${contador}${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await mensagensRepo.registrarAceita(m._id, wamid, telefoneE164.slice(1), agora);
    return { id: m._id, wamid, telefoneE164 };
  }
  const doc = async (id: Types.ObjectId) => (await mensagemModel.findById(id).lean())!;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, WhatsappModule] })
      .overrideProvider(CONFIG_WEBHOOK_WHATSAPP)
      .useValue({ verifyToken: "VERIFY-TOKEN-FICTICIO-DE-TESTE", appSecret: "SEGREDO-FICTICIO-DE-TESTE-WEBHOOK", phoneNumberId: PHONE_ID })
      .overrideProvider(PALAVRAS_CHAVE_OPT_OUT)
      .useValue(["SAIR", "Sair"])
      .overrideProvider(PROVEDOR_ENVIO_WHATSAPP)
      .useValue(provedor)
      .overrideProvider(WHATSAPP_PROVIDER)
      .useValue({})
      .compile();
    await moduleRef.init();
    connection = moduleRef.get(getConnectionToken());
    webhook = moduleRef.get(WebhookWhatsappService);
    mensagensRepo = moduleRef.get(MensagensWhatsappRepository);
    bloqueios = moduleRef.get(BloqueiosWhatsappService);
    envios = moduleRef.get(EnviosWhatsappService);
    clientes = moduleRef.get(ClientesService);
    mensagemModel = moduleRef.get(getModelToken(MensagemWhatsapp.name));
    bloqueioModel = moduleRef.get(getModelToken(BloqueioWhatsapp.name));
    await mensagemModel.init();
    await bloqueioModel.init();
  }, 30_000);

  beforeEach(async () => {
    await mensagemModel.deleteMany({});
    await bloqueioModel.deleteMany({});
    provedor.chamadas = 0;
  });

  afterAll(async () => {
    await connection.collection("mensagens_whatsapp").deleteMany({});
    await connection.collection("whatsapp_bloqueios").deleteMany({});
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: "cliente" });
    await moduleRef.close();
  });

  describe("status (correlação por wamid + máquina de estados)", () => {
    it("delivered → entregue; read → lida; datas do evento gravadas", async () => {
      const m = await mensagemAceita();
      expect((await notificarStatus({ id: m.wamid, status: "delivered", timestamp: "1764000000" })).status.aplicado).toBe(1);
      expect((await doc(m.id)).estado).toBe("entregue");
      expect((await doc(m.id)).entregueEm).toEqual(new Date(1764000000 * 1000));
      await notificarStatus({ id: m.wamid, status: "read", timestamp: "1764000100" });
      const d = await doc(m.id);
      expect(d.estado).toBe("lida");
      expect(d.lidaEm).toEqual(new Date(1764000100 * 1000));
      expect(d.entregueEm).toEqual(new Date(1764000000 * 1000)); // preservada
    });

    it("sent sobre mensagem já aceita é ignorado (sem efeito)", async () => {
      const m = await mensagemAceita();
      const antes = await doc(m.id);
      expect((await notificarStatus({ id: m.wamid, status: "sent", timestamp: "1764000000" })).status.ignorado).toBe(1);
      expect(await doc(m.id)).toEqual(antes);
    });

    it("read SEM delivered antes → lida, e entregueEm preenchida (read implica entregue)", async () => {
      const m = await mensagemAceita();
      await notificarStatus({ id: m.wamid, status: "read", timestamp: "1764000200" });
      const d = await doc(m.id);
      expect(d.estado).toBe("lida");
      expect(d.entregueEm).toEqual(new Date(1764000200 * 1000));
    });

    it("duplicado e fora de ordem: delivered depois de read não regride; repetição não altera nada", async () => {
      const m = await mensagemAceita();
      await notificarStatus({ id: m.wamid, status: "read", timestamp: "1764000300" });
      const depoisRead = await doc(m.id);
      const r = await notificarStatus({ id: m.wamid, status: "delivered", timestamp: "1764000250" }, { id: m.wamid, status: "read", timestamp: "1764000300" }, { id: m.wamid, status: "sent" });
      expect(r.status).toEqual({ aplicado: 0, ignorado: 3, anomalia: 0, desconhecida: 0 });
      expect(await doc(m.id)).toEqual(depoisRead);
    });

    it("failed sobre aceita → falha classificada (131026 = SEM_WHATSAPP)", async () => {
      const m = await mensagemAceita();
      await notificarStatus({ id: m.wamid, status: "failed", timestamp: "1764000400", errors: [{ code: 131026, title: "x", message: "detalhe" }] });
      const d = await doc(m.id);
      expect(d.estado).toBe("falha");
      expect(d.erroCodigo).toBe("SEM_WHATSAPP");
      expect(d.erroCodigoProvedor).toBe("131026");
      expect(d.falhaEm).toEqual(new Date(1764000400 * 1000));
    });

    it("failed sem código → falha RECUSADA", async () => {
      const m = await mensagemAceita();
      await notificarStatus({ id: m.wamid, status: "failed" });
      expect((await doc(m.id)).erroCodigo).toBe("RECUSADA");
    });

    it("failed depois de delivered e depois de read → ANOMALIA (estado preservado)", async () => {
      const a = await mensagemAceita();
      const b = await mensagemAceita();
      await notificarStatus({ id: a.wamid, status: "delivered" }, { id: b.wamid, status: "read" });
      const r = await notificarStatus({ id: a.wamid, status: "failed", errors: [{ code: 131000 }] }, { id: b.wamid, status: "failed", errors: [{ code: 131000 }] });
      expect(r.status.anomalia).toBe(2);
      expect((await doc(a.id)).estado).toBe("entregue");
      expect((await doc(b.id)).estado).toBe("lida");
      expect((await doc(a.id)).erroCodigo).toBeNull();
    });

    it("nada sai de falha por evento externo (delivered tardio após failed)", async () => {
      const m = await mensagemAceita();
      await notificarStatus({ id: m.wamid, status: "failed", errors: [{ code: 131049 }] });
      await notificarStatus({ id: m.wamid, status: "delivered" }, { id: m.wamid, status: "read" });
      expect((await doc(m.id)).estado).toBe("falha");
    });

    it("wamid desconhecido → nada é criado; status desconhecido (played) ignorado", async () => {
      const r = await notificarStatus({ id: "wamid.NAO_EXISTE", status: "delivered" }, { id: "wamid.NAO_EXISTE", status: "played" });
      expect(r.status.desconhecida).toBe(1);
      expect(r.contagem.statusIgnorados).toBe(1);
      expect(await mensagemModel.countDocuments({})).toBe(0);
    });

    it("CONCORRÊNCIA: 10 delivered + 10 read simultâneos → estado final lida, sem regressão", async () => {
      const m = await mensagemAceita();
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => notificarStatus({ id: m.wamid, status: i % 2 ? "read" : "delivered", timestamp: String(1764000500 + i) })),
      );
      const d = await doc(m.id);
      expect(d.estado).toBe("lida");
      expect(d.entregueEm).not.toBeNull();
      expect(d.lidaEm).not.toBeNull();
    });

    it("CONCORRÊNCIA: failed 131050 repetido 8x simultâneo → 1 falha, 1 bloqueio do número (META_OPT_OUT)", async () => {
      const m = await mensagemAceita();
      await Promise.all(Array.from({ length: 8 }, () => notificarStatus({ id: m.wamid, status: "failed", errors: [{ code: 131050 }] })));
      expect((await doc(m.id)).erroCodigo).toBe("OPT_OUT_MARKETING");
      const bs = await bloqueioModel.find({}).lean();
      expect(bs).toHaveLength(1);
      expect(bs[0]).toMatchObject({ chave: m.telefoneE164, tipoChave: "E164", origem: "META_OPT_OUT", ativo: true });
    });

    it("Fase 22.8.9.10.5.1 — SÓ 131050 (escolha do destinatário) bloqueia: 131049 (limite da Meta), 131026, 131000 e failed sem código NÃO", async () => {
      for (const codigo of [131049, 131026, 131000, null]) {
        const m = await mensagemAceita();
        await notificarStatus({ id: m.wamid, status: "failed", ...(codigo !== null ? { errors: [{ code: codigo }] } : {}) });
        expect((await doc(m.id)).estado).toBe("falha");
        expect((await doc(m.id)).erroCodigoProvedor).toBe(codigo !== null ? String(codigo) : null); // diagnóstico preservado
      }
      expect(await bloqueioModel.countDocuments({})).toBe(0);
      expect((await mensagemModel.findOne({ erroCodigoProvedor: "131049" }).lean())?.erroCodigo).toBe("LIMITE_MARKETING_DESTINATARIO");
    });

    it("falha de escrita concorrente: a transição condicional não sobrescreve estado mais avançado", async () => {
      const m = await mensagemAceita();
      // Alguém já levou a mensagem a `lida`; uma escrita baseada na leitura antiga (`aceita`) não pode aplicar.
      await notificarStatus({ id: m.wamid, status: "read" });
      expect(await mensagensRepo.aplicarTransicaoStatus(m.id, m.wamid, "aceita", "entregue", { entregueEm: new Date() }, new Date())).toBe(false);
      expect((await doc(m.id)).estado).toBe("lida");
    });
  });

  describe("opt-out e bloqueio por número", () => {
    it("user_preferences stop para número SEM cadastro → bloqueio WAID persistido, sem cliente", async () => {
      const r = await notificarPreferencia("5583911110000");
      expect(r.bloqueiosCriados).toBe(1);
      const b = await bloqueioModel.findOne({ chave: "5583911110000" }).lean();
      expect(b).toMatchObject({ tipoChave: "WAID", ativo: true, clienteId: null, origem: "META_OPT_OUT" });
      expect(await connection.collection("clientes").countDocuments({ telefone: "83911110000" })).toBe(0);
    });

    it("cliente existente: opt-out pelo wa_id (mesmos dígitos do E.164) bloqueia o envio a ele", async () => {
      const cliente = await clientes.criar({ nome: "Opt Out Teste", telefone: `839${String(++contador).padStart(8, "0")}` }, null);
      await notificarPreferencia(`55${cliente.telefone}`);
      expect(await bloqueios.bloqueioAtivo(`+55${cliente.telefone}`)).not.toBeNull();
      await expect(envios.enviar({ idempotencyKey: randomUUID(), destinatario: { tipo: "CLIENTE", id: cliente.id }, template: "aniversario_v1" }, null)).rejects.toMatchObject({
        code: "WHATSAPP_CONTATO_BLOQUEADO",
      });
      expect(provedor.chamadas).toBe(0);
    });

    it("resume NÃO desbloqueia automaticamente", async () => {
      await notificarPreferencia("5583922220000");
      const r = await notificarPreferencia("5583922220000", "resume");
      expect(r.contagem.preferenciasIgnoradas).toBe(1);
      expect(await bloqueioModel.countDocuments({ chave: "5583922220000", ativo: true })).toBe(1);
    });

    it("número já bloqueado e evento repetido → nenhum bloqueio duplicado", async () => {
      await bloqueios.bloquearNumero("+5583933330000", null, "ADMIN", null);
      await notificarPreferencia("5583933330000");
      const r = await notificarPreferencia("5583933330000");
      expect(r).toMatchObject({ bloqueiosCriados: 0, bloqueiosExistentes: 1 });
      expect(await bloqueioModel.countDocuments({ chave: "5583933330000", ativo: true })).toBe(1);
      expect(await bloqueios.bloqueioAtivo("+5583933330000")).not.toBeNull();
    });

    it("CONCORRÊNCIA: 10 opt-outs simultâneos do mesmo número → 1 bloqueio ativo", async () => {
      await Promise.all(Array.from({ length: 10 }, () => notificarPreferencia("5583944440000")));
      expect(await bloqueioModel.countDocuments({ chave: "5583944440000", ativo: true })).toBe(1);
    });

    it("histórico: desbloqueio pelo ADMIN preservado; novo opt-out cria NOVO bloqueio (o antigo fica inativo)", async () => {
      await notificarPreferencia("5583955550000");
      const primeiro = (await bloqueioModel.findOne({ chave: "5583955550000" }).lean())!;
      await bloqueios.desbloquearPorId(String(primeiro._id), "cliente pediu para voltar", "admin-1");
      await notificarPreferencia("5583955550000");
      const todos = await bloqueioModel.find({ chave: "5583955550000" }).sort({ criadoEm: 1 }).lean();
      expect(todos).toHaveLength(2);
      expect(todos[0]).toMatchObject({ ativo: false, motivoDesbloqueio: "cliente pediu para voltar" });
      expect(todos[1]).toMatchObject({ ativo: true, origem: "META_OPT_OUT" });
    });

    it("palavra-chave da lista (SAIR / Sair) → bloqueio PALAVRA_CHAVE; variação não listada e texto livre → nada", async () => {
      await notificarTexto("5583966660001", "SAIR");
      await notificarTexto("5583966660002", "  Sair ");
      await notificarTexto("5583966660003", "sair");
      await notificarTexto("5583966660004", "Quero sair da lista");
      await notificarTexto("5583966660005", "Obrigada!");
      const chaves = (await bloqueioModel.find({ origem: "PALAVRA_CHAVE" }).lean()).map((b) => b.chave).sort();
      expect(chaves).toEqual(["5583966660001", "5583966660002"]);
    });

    it("normalização exata: número novo não herda bloqueio do anterior; sem aproximação do nono dígito", async () => {
      // Bloqueio do wa_id SEM o nono dígito (12 dígitos) NÃO bloqueia o E.164 com o nono dígito, e vice-versa.
      await notificarPreferencia("558377770000");
      expect(await bloqueios.bloqueioAtivo("+5583977770000")).toBeNull();
      await notificarPreferencia("5583988880000");
      expect(await bloqueios.bloqueioAtivo("+558388880000")).toBeNull();
      // Cliente que trocou de número: o bloqueio do número antigo não passa para o novo.
      expect(await bloqueios.bloqueioAtivo("+5583988880001")).toBeNull();
      expect(await bloqueios.bloqueioAtivo("+5583988880000")).not.toBeNull();
    });
  });

  describe("regressão do envio por template", () => {
    it("envio + idempotência continuam: aceite com wamid, repetição sem nova chamada; o webhook atualiza a mesma mensagem", async () => {
      const cliente = await clientes.criar({ nome: "Regressao Webhook", telefone: `839${String(++contador).padStart(8, "0")}` }, null);
      const pedido = { idempotencyKey: randomUUID(), destinatario: { tipo: "CLIENTE" as const, id: cliente.id }, template: "aniversario_v1" };
      const { mensagem } = await envios.enviar(pedido, null);
      await envios.enviar(pedido, null);
      expect(provedor.chamadas).toBe(1);
      await notificarStatus({ id: `wamid.ENVIO${mensagem.id}`, status: "delivered" });
      expect((await envios.obter(mensagem.id)).estado).toBe("entregue");
    });
  });
});
