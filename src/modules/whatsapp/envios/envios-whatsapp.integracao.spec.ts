import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection, Model } from "mongoose";
import { mongooseModuloDeTeste } from "../../../test-utils/mongo-teste.util.js";
import { ClientesService } from "../../clientes/clientes.service.js";
import type { Sequencia } from "../../sequencias/schemas/sequencia.schema.js";
import { BloqueiosWhatsappRepository } from "../bloqueios/bloqueios-whatsapp.repository.js";
import { BloqueiosWhatsappService } from "../bloqueios/bloqueios-whatsapp.service.js";
import type { EnviarTemplateWhatsappDto } from "../dto/envios-whatsapp.dto.js";
import {
  PROVEDOR_ENVIO_WHATSAPP,
  type EnviarTemplateWhatsappInput,
  type InfoTemplateProvedorWhatsapp,
  type ProvedorEnvioWhatsapp,
  type ResultadoEnvioProvedorWhatsapp,
} from "../providers/provedor-envio-whatsapp.interface.js";
import { BloqueioWhatsapp, type BloqueioWhatsappDocument } from "../schemas/bloqueio-whatsapp.schema.js";
import { MensagemWhatsapp, type MensagemWhatsappDocument } from "../schemas/mensagem-whatsapp.schema.js";
import { TemplatesWhatsappService } from "../templates/templates-whatsapp.service.js";
import { WHATSAPP_PROVIDER } from "../whatsapp.constants.js";
import { WhatsappModule } from "../whatsapp.module.js";
import { PRAZO_ENVIANDO_MS, PRAZO_MINIMO_LIBERAR_INDETERMINADA_MS, PRAZO_POSSE_MS } from "./envios-whatsapp.constants.js";
import { EnviosWhatsappService } from "./envios-whatsapp.service.js";
import { MensagensWhatsappRepository } from "./mensagens-whatsapp.repository.js";

/**
 * Fase 22.8.9.10.3 — INTEGRAÇÃO com MongoDB REAL (`MONGODB_URI_TESTE`): índices únicos, concorrência, idempotência,
 * reserva de campanha, bloqueio, abandono e liberação. O provedor é SEMPRE este dublê — nenhuma chamada de rede à
 * Meta nem à Evolution, nenhuma credencial.
 */
class ProvedorEnvioFalso implements ProvedorEnvioWhatsapp {
  readonly nome = "falso";
  ativo = true;
  atrasoMs = 0;
  chamadas: EnviarTemplateWhatsappInput[] = [];
  consultas = 0;
  resultado: (input: EnviarTemplateWhatsappInput) => Promise<ResultadoEnvioProvedorWhatsapp> = async (i) => ({
    resultado: "aceita",
    wamid: `wamid.${i.referenciaInterna}`,
    waId: i.telefoneE164.slice(1),
  });
  info: () => Promise<InfoTemplateProvedorWhatsapp | null> = async () => ({
    nomeMeta: "mariela_aniversario_v2",
    idioma: "pt_BR",
    status: "APPROVED",
    categoria: "MARKETING",
    quantidadeParametros: 1,
  });

  configurado(): boolean {
    return this.ativo;
  }
  async enviarTemplate(input: EnviarTemplateWhatsappInput): Promise<ResultadoEnvioProvedorWhatsapp> {
    this.chamadas.push(input);
    if (this.atrasoMs) await new Promise((r) => setTimeout(r, this.atrasoMs));
    return this.resultado(input);
  }
  async enviarTexto(): Promise<ResultadoEnvioProvedorWhatsapp> {
    throw new Error("texto livre é coberto por envios-texto-whatsapp.integracao.spec.ts");
  }
  async consultarTemplate(): Promise<InfoTemplateProvedorWhatsapp | null> {
    this.consultas += 1;
    return this.info();
  }
}

const JWT_MODULO_DE_TESTE = JwtModule.register({ global: true, secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } });

describe("Envio de WhatsApp por template (integração — MongoDB real, provedor falso)", () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let service: EnviosWhatsappService;
  let bloqueios: BloqueiosWhatsappService;
  let bloqueiosRepo: BloqueiosWhatsappRepository;
  let mensagensRepo: MensagensWhatsappRepository;
  let templates: TemplatesWhatsappService;
  let clientes: ClientesService;
  let mensagemModel: Model<MensagemWhatsappDocument>;
  let bloqueioModel: Model<BloqueioWhatsappDocument>;
  let provedor: ProvedorEnvioFalso;
  let contador = 0;
  let agora = new Date("2026-11-23T15:00:00Z");

  const telefoneUnico = () => `839${String(++contador).padStart(8, "0")}`;
  const e164 = (tel: string) => `+55${tel}`;
  const novoCliente = async (nome = "Cliente Teste WhatsApp") => clientes.criar({ nome, telefone: telefoneUnico() }, null);
  const pedido = (clienteId: string, extra: Partial<EnviarTemplateWhatsappDto> = {}): EnviarTemplateWhatsappDto => ({
    idempotencyKey: randomUUID(),
    destinatario: { tipo: "CLIENTE", id: clienteId },
    template: "aniversario_v2",
    ...extra,
  });

  beforeAll(async () => {
    provedor = new ProvedorEnvioFalso();
    moduleRef = await Test.createTestingModule({ imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, WhatsappModule] })
      .overrideProvider(PROVEDOR_ENVIO_WHATSAPP)
      .useValue(provedor)
      // O fluxo da Evolution (intacto nesta fase) não participa destes testes: dublê inerte, sem ConfigService.
      .overrideProvider(WHATSAPP_PROVIDER)
      .useValue({})
      .compile();
    await moduleRef.init();
    connection = moduleRef.get(getConnectionToken());
    service = moduleRef.get(EnviosWhatsappService);
    bloqueios = moduleRef.get(BloqueiosWhatsappService);
    bloqueiosRepo = moduleRef.get(BloqueiosWhatsappRepository);
    mensagensRepo = moduleRef.get(MensagensWhatsappRepository);
    templates = moduleRef.get(TemplatesWhatsappService);
    clientes = moduleRef.get(ClientesService);
    mensagemModel = moduleRef.get(getModelToken(MensagemWhatsapp.name));
    bloqueioModel = moduleRef.get(getModelToken(BloqueioWhatsapp.name));
    // Índices construídos ANTES dos testes de concorrência (o mesmo `init()` que o Mongoose dispara no boot).
    await mensagemModel.init();
    await bloqueioModel.init();
    service.relogio = () => agora;
    bloqueios.relogio = () => agora;
  }, 30_000);

  beforeEach(async () => {
    await mensagemModel.deleteMany({});
    await bloqueioModel.deleteMany({});
    provedor.ativo = true;
    provedor.atrasoMs = 0;
    provedor.chamadas = [];
    provedor.resultado = new ProvedorEnvioFalso().resultado;
    provedor.info = new ProvedorEnvioFalso().info;
    templates.invalidar("aniversario_v2");
    agora = new Date("2026-11-23T15:00:00Z");
  });

  afterAll(async () => {
    await connection.collection("mensagens_whatsapp").deleteMany({});
    await connection.collection("whatsapp_bloqueios").deleteMany({});
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: "cliente" });
    await moduleRef.close();
  });

  describe("índices únicos (MongoDB real)", () => {
    it("índices declarados existem com unicidade/parcialidade corretas", async () => {
      const idx = await mensagemModel.collection.indexes();
      const porNome = Object.fromEntries(idx.map((i) => [i.name, i]));
      expect(porNome["idempotencyKey_unica"]?.unique).toBe(true);
      expect(porNome["chaveDeduplicacao_unica"]?.unique).toBe(true);
      expect(porNome["chaveDeduplicacao_unica"]?.partialFilterExpression).toEqual({ chaveDeduplicacao: { $type: "string" } });
      expect(porNome["wamid_unico"]?.unique).toBe(true);
      const idxB = await bloqueioModel.collection.indexes();
      const chaveAtiva = idxB.find((i) => i.name === "chave_ativa_unica");
      expect(chaveAtiva?.unique).toBe(true);
      expect(chaveAtiva?.partialFilterExpression).toEqual({ ativo: true });
    });

    it("o banco recusa a mesma idempotencyKey e a mesma chaveDeduplicacao (E11000), mas aceita várias sem chave de campanha", async () => {
      const cliente = await novoCliente();
      const base = {
        hashConteudo: "h",
        destinatarioTipo: "CLIENTE" as const,
        destinatarioId: cliente._id,
        telefoneE164: e164(cliente.telefone),
        templateChave: "aniversario_v2",
        templateNomeMeta: "mariela_aniversario_v2",
        templateIdioma: "pt_BR",
        templateCategoria: "MARKETING",
        origem: "INDIVIDUAL" as const,
        campanhaTipo: null,
        campanhaAno: null,
        usuarioId: null,
      };
      await mensagensRepo.reservar({ ...base, idempotencyKey: "k1", chaveDeduplicacao: null }, agora);
      await mensagensRepo.reservar({ ...base, idempotencyKey: "k2", chaveDeduplicacao: null }, agora); // null não conflita
      await expect(mensagensRepo.reservar({ ...base, idempotencyKey: "k1", chaveDeduplicacao: null }, agora)).rejects.toMatchObject({ code: 11000 });
      await mensagensRepo.reservar({ ...base, idempotencyKey: "k3", chaveDeduplicacao: "ANIVERSARIO:2026:x" }, agora);
      await expect(mensagensRepo.reservar({ ...base, idempotencyKey: "k4", chaveDeduplicacao: "ANIVERSARIO:2026:x" }, agora)).rejects.toMatchObject({
        code: 11000,
      });
    });
  });

  describe("envio e idempotência", () => {
    it("envio aceito: telefone do CADASTRO, parâmetros derivados, registro aceito e resposta mascarada", async () => {
      const cliente = await novoCliente("Joana Prado");
      const { mensagem, nova } = await service.enviar(pedido(cliente.id), "usuario-1");

      expect(nova).toBe(true);
      expect(provedor.chamadas).toHaveLength(1);
      expect(provedor.chamadas[0]!.telefoneE164).toBe(e164(cliente.telefone));
      expect(provedor.chamadas[0]!.parametros).toEqual(["Joana"]);
      expect(provedor.chamadas[0]!.referenciaInterna).toBe(mensagem.id);
      expect(mensagem.estado).toBe("aceita");
      expect(mensagem.destinatario.telefoneMascarado).toContain("****");
      expect(JSON.stringify(mensagem)).not.toContain(cliente.telefone);

      const doc = await mensagemModel.findById(mensagem.id).lean();
      expect(doc?.wamid).toBe(`wamid.${mensagem.id}`);
      expect(doc?.enviandoEm).not.toBeNull();
      expect(doc?.usuarioId).toBe("usuario-1");
    });

    it("repetição com a mesma chave devolve o MESMO registro e NÃO chama o provedor", async () => {
      const cliente = await novoCliente();
      const p = pedido(cliente.id);
      const primeira = await service.enviar(p, null);
      const segunda = await service.enviar(p, null);
      expect(segunda.nova).toBe(false);
      expect(segunda.mensagem.id).toBe(primeira.mensagem.id);
      expect(provedor.chamadas).toHaveLength(1);
    });

    it("mesma chave com conteúdo diferente → 409 sem chamar o provedor", async () => {
      const a = await novoCliente();
      const b = await novoCliente();
      const p = pedido(a.id);
      await service.enviar(p, null);
      await expect(service.enviar({ ...p, destinatario: { tipo: "CLIENTE", id: b.id } }, null)).rejects.toMatchObject({
        code: "WHATSAPP_IDEMPOTENCIA_CONFLITO",
      });
      expect(provedor.chamadas).toHaveLength(1);
    });

    it("CONCORRÊNCIA: 8 requisições simultâneas com a mesma chave → 1 chamada ao provedor, 1 registro", async () => {
      const cliente = await novoCliente();
      const p = pedido(cliente.id);
      provedor.atrasoMs = 80;
      const resultados = await Promise.all(Array.from({ length: 8 }, () => service.enviar({ ...p }, null)));
      expect(provedor.chamadas).toHaveLength(1);
      expect(new Set(resultados.map((r) => r.mensagem.id)).size).toBe(1);
      expect(resultados.filter((r) => r.nova)).toHaveLength(1);
      expect(await mensagemModel.countDocuments({ idempotencyKey: p.idempotencyKey })).toBe(1);
    });

    it("timeout/exceção do provedor → indeterminada; repetir NÃO reenvia", async () => {
      const cliente = await novoCliente();
      provedor.resultado = async () => {
        throw new Error("timeout");
      };
      const p = pedido(cliente.id);
      const { mensagem } = await service.enviar(p, null);
      expect(mensagem.estado).toBe("indeterminada");
      expect(mensagem.erro?.codigo).toBe("INDETERMINADO");
      const repetida = await service.enviar(p, null);
      expect(repetida.nova).toBe(false);
      expect(repetida.mensagem.estado).toBe("indeterminada");
      expect(provedor.chamadas).toHaveLength(1);
    });

    it("resultado indeterminado informado pelo provedor → indeterminada", async () => {
      const cliente = await novoCliente();
      provedor.resultado = async () => ({ resultado: "indeterminada", codigoProvedor: "HTTP_503" });
      const { mensagem } = await service.enviar(pedido(cliente.id), null);
      expect(mensagem.estado).toBe("indeterminada");
      expect((await mensagemModel.findById(mensagem.id).lean())?.erroCodigoProvedor).toBe("HTTP_503");
    });

    it("recusa comprovada (sem WhatsApp) → falha classificada; repetir NÃO reenvia", async () => {
      const cliente = await novoCliente();
      provedor.resultado = async () => ({ resultado: "recusada", codigo: "SEM_WHATSAPP", codigoProvedor: "131026" });
      const p = pedido(cliente.id);
      const { mensagem } = await service.enviar(p, null);
      expect(mensagem.estado).toBe("falha");
      expect(mensagem.erro?.codigo).toBe("SEM_WHATSAPP");
      await service.enviar(p, null);
      expect(provedor.chamadas).toHaveLength(1);
    });

    it("recusas ANTES do envio não gravam mensagem nem chamam o provedor (404, 400, 422, 503)", async () => {
      const cliente = await novoCliente();
      await expect(service.enviar(pedido("65f1a2b3c4d5e6f7a8b9c0d1"), null)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(service.enviar(pedido(cliente.id, { template: "inexistente" }), null)).rejects.toMatchObject({
        code: "WHATSAPP_TEMPLATE_INDISPONIVEL",
      });
      const invalido = await clientes.criar({ nome: "Telefone Curto", telefone: `83${String(++contador).padStart(8, "0")}` }, null);
      await connection.collection("clientes").updateOne({ _id: invalido._id }, { $set: { telefone: "123" } });
      await expect(service.enviar(pedido(invalido.id), null)).rejects.toMatchObject({ code: "WHATSAPP_INVALID_NUMBER" });
      provedor.ativo = false;
      await expect(service.enviar(pedido(cliente.id), null)).rejects.toMatchObject({ code: "WHATSAPP_NOT_CONFIGURED" });
      expect(await mensagemModel.countDocuments({})).toBe(0);
      expect(provedor.chamadas).toHaveLength(0);
    });
  });

  describe("templates: aprovação confirmada no provedor", () => {
    it("pendente, divergente ou consulta falhando → 422 sem gravar nem enviar", async () => {
      const cliente = await novoCliente();
      provedor.info = async () => ({ nomeMeta: "mariela_aniversario_v2", idioma: "pt_BR", status: "PENDING", categoria: "MARKETING", quantidadeParametros: 1 });
      await expect(service.enviar(pedido(cliente.id), null)).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_INDISPONIVEL" });
      templates.invalidar("aniversario_v2");
      provedor.info = async () => ({ nomeMeta: "mariela_aniversario_v2", idioma: "pt_BR", status: "APPROVED", categoria: "UTILITY", quantidadeParametros: 1 });
      await expect(service.enviar(pedido(cliente.id), null)).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_INDISPONIVEL" });
      templates.invalidar("aniversario_v2");
      provedor.info = async () => {
        throw new Error("rede");
      };
      await expect(service.enviar(pedido(cliente.id), null)).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_INDISPONIVEL" });
      expect(await mensagemModel.countDocuments({})).toBe(0);
      expect(provedor.chamadas).toHaveLength(0);
    });

    it("recusa TEMPLATE_INVALIDO no envio invalida o cache (próximo envio consulta de novo)", async () => {
      const cliente = await novoCliente();
      provedor.resultado = async () => ({ resultado: "recusada", codigo: "TEMPLATE_INVALIDO", codigoProvedor: "132001" });
      const antes = provedor.consultas;
      await service.enviar(pedido(cliente.id), null);
      await service.enviar(pedido(cliente.id), null);
      expect(provedor.consultas - antes).toBe(2);
    });
  });

  describe("campanha de aniversário (uma por cliente por ano)", () => {
    const campanha = { campanha: { tipo: "ANIVERSARIO" as const } };

    it("CONCORRÊNCIA: 6 envios simultâneos com chaves DIFERENTES ao mesmo cliente → 1 envio, os demais 409", async () => {
      const cliente = await novoCliente();
      provedor.atrasoMs = 50;
      const resultados = await Promise.allSettled(Array.from({ length: 6 }, () => service.enviar(pedido(cliente.id, campanha), null)));
      const ok = resultados.filter((r) => r.status === "fulfilled");
      const recusados = resultados.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(recusados).toHaveLength(5);
      for (const r of recusados) expect(r.reason).toMatchObject({ code: "WHATSAPP_JA_ENVIADA_CAMPANHA" });
      expect(provedor.chamadas).toHaveLength(1);
      expect(await mensagemModel.countDocuments({ destinatarioId: cliente._id })).toBe(1);
    });

    it("ano = ano civil do envio; a reserva vale mesmo depois de falha, e no ano seguinte libera", async () => {
      const cliente = await novoCliente();
      agora = new Date("2026-12-31T20:00:00Z"); // 17h de 31/12 em São Paulo
      provedor.resultado = async () => ({ resultado: "recusada", codigo: "LIMITE_TAXA", codigoProvedor: "130429" });
      const { mensagem } = await service.enviar(pedido(cliente.id, campanha), null);
      expect(mensagem.campanha).toEqual({ tipo: "ANIVERSARIO", ano: 2026 });
      expect(mensagem.estado).toBe("falha");
      await expect(service.enviar(pedido(cliente.id, campanha), null)).rejects.toMatchObject({ code: "WHATSAPP_JA_ENVIADA_CAMPANHA" });
      agora = new Date("2027-01-01T04:00:00Z"); // 01h de 01/01 em São Paulo
      provedor.resultado = new ProvedorEnvioFalso().resultado;
      const seguinte = await service.enviar(pedido(cliente.id, campanha), null);
      expect(seguinte.mensagem.campanha).toEqual({ tipo: "ANIVERSARIO", ano: 2027 });
    });

    it("envio individual não consome a reserva da campanha", async () => {
      const cliente = await novoCliente();
      await service.enviar(pedido(cliente.id), null);
      await service.enviar(pedido(cliente.id, campanha), null);
      expect(provedor.chamadas).toHaveLength(2);
    });
  });

  describe("posse do envio e processos abandonados", () => {
    const reservaDireta = async (agoraReserva: Date) => {
      const cliente = await novoCliente();
      return mensagensRepo.reservar(
        {
          idempotencyKey: randomUUID(),
          hashConteudo: "h",
          destinatarioTipo: "CLIENTE",
          destinatarioId: cliente._id,
          telefoneE164: e164(cliente.telefone),
          templateChave: "aniversario_v2",
          templateNomeMeta: "mariela_aniversario_v2",
          templateIdioma: "pt_BR",
          templateCategoria: "MARKETING",
          origem: "INDIVIDUAL",
          campanhaTipo: null,
          campanhaAno: null,
          chaveDeduplicacao: null,
          usuarioId: null,
        },
        agoraReserva,
      );
    };

    it("posse é exclusiva: só uma de várias tentativas simultâneas assume", async () => {
      const m = await reservaDireta(agora);
      // Horários distintos: sem a condição de estado, cada tentativa MODIFICARIA o documento (e "assumiria").
      const posses = await Promise.all(Array.from({ length: 5 }, (_, i) => mensagensRepo.assumirEnvio(m._id, new Date(agora.getTime() + i))));
      expect(posses.filter(Boolean)).toHaveLength(1);
    });

    it("pendente abandonada → falha NAO_ENVIADA (comprovadamente não enviada) e ninguém assume depois", async () => {
      const m = await reservaDireta(new Date(agora.getTime() - PRAZO_POSSE_MS - 1));
      const r = await mensagensRepo.converterAbandonadas(agora);
      expect(r.naoEnviadas).toBe(1);
      const doc = await mensagemModel.findById(m._id).lean();
      expect(doc?.estado).toBe("falha");
      expect(doc?.erroCodigo).toBe("NAO_ENVIADA");
      expect(await mensagensRepo.assumirEnvio(m._id, agora)).toBe(false);
    });

    it("pendente recente NÃO é convertida (o dono ainda pode assumir)", async () => {
      const m = await reservaDireta(new Date(agora.getTime() - PRAZO_POSSE_MS + 5_000));
      expect((await mensagensRepo.converterAbandonadas(agora)).naoEnviadas).toBe(0);
      expect(await mensagensRepo.assumirEnvio(m._id, agora)).toBe(true);
    });

    it("enviando abandonada → indeterminada; resposta tardia ainda registra o aceite", async () => {
      const m = await reservaDireta(new Date(agora.getTime() - PRAZO_ENVIANDO_MS - 10_000));
      await mensagensRepo.assumirEnvio(m._id, new Date(agora.getTime() - PRAZO_ENVIANDO_MS - 1));
      expect((await mensagensRepo.converterAbandonadas(agora)).indeterminadas).toBe(1);
      expect((await mensagemModel.findById(m._id).lean())?.estado).toBe("indeterminada");
      expect(await mensagensRepo.registrarAceita(m._id, "wamid.tardio", null, agora)).toBe(true);
      expect((await mensagemModel.findById(m._id).lean())?.estado).toBe("aceita");
    });
  });

  describe("liberação manual de reenvio", () => {
    const campanha = { campanha: { tipo: "ANIVERSARIO" as const } };

    it("falha: libera, preserva o original e move a reserva da campanha; nova chave envia de novo", async () => {
      const cliente = await novoCliente();
      provedor.resultado = async () => ({ resultado: "recusada", codigo: "LIMITE_TAXA", codigoProvedor: null });
      const { mensagem } = await service.enviar(pedido(cliente.id, campanha), null);
      const liberada = await service.liberarReenvio(mensagem.id, { motivo: "Limite de taxa resolvido" }, "admin-1");
      expect(liberada.estado).toBe("falha");
      expect(liberada.liberacao?.motivo).toBe("Limite de taxa resolvido");
      const doc = await mensagemModel.findById(mensagem.id).lean();
      expect(doc?.chaveDeduplicacao).toBeNull();
      expect(doc?.chaveDeduplicacaoLiberada).toBe(`ANIVERSARIO:2026:${cliente.id}`);
      expect(doc?.liberadaPor).toBe("admin-1");
      await expect(service.liberarReenvio(mensagem.id, { motivo: "Segunda tentativa" }, "admin-1")).rejects.toMatchObject({
        code: "WHATSAPP_LIBERACAO_NAO_PERMITIDA",
      });
      provedor.resultado = new ProvedorEnvioFalso().resultado;
      const reenvio = await service.enviar(pedido(cliente.id, campanha), null);
      expect(reenvio.mensagem.estado).toBe("aceita");
      expect(await mensagemModel.countDocuments({ destinatarioId: cliente._id })).toBe(2); // nada apagado
    });

    it("indeterminada: exige confirmação de risco e 24 h desde o envio; antes disso recusa", async () => {
      const cliente = await novoCliente();
      provedor.resultado = async () => ({ resultado: "indeterminada", codigoProvedor: null });
      const { mensagem } = await service.enviar(pedido(cliente.id), null);
      await expect(service.liberarReenvio(mensagem.id, { motivo: "Sem retorno do provedor" }, null)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      await expect(
        service.liberarReenvio(mensagem.id, { motivo: "Sem retorno do provedor", confirmoRiscoDeDuplicidade: true }, null),
      ).rejects.toMatchObject({ code: "WHATSAPP_LIBERACAO_NAO_PERMITIDA" });
      agora = new Date(agora.getTime() + PRAZO_MINIMO_LIBERAR_INDETERMINADA_MS);
      const ok = await service.liberarReenvio(mensagem.id, { motivo: "Sem retorno do provedor", confirmoRiscoDeDuplicidade: true }, "admin-2");
      expect(ok.estado).toBe("indeterminada"); // estado preservado
      expect(ok.liberacao).not.toBeNull();
    });

    it("aceita não pode ser liberada; liberações simultâneas resultam em uma só", async () => {
      const cliente = await novoCliente();
      const { mensagem } = await service.enviar(pedido(cliente.id), null);
      await expect(service.liberarReenvio(mensagem.id, { motivo: "Tentativa indevida" }, null)).rejects.toMatchObject({
        code: "WHATSAPP_LIBERACAO_NAO_PERMITIDA",
      });

      provedor.resultado = async () => ({ resultado: "recusada", codigo: "SEM_WHATSAPP", codigoProvedor: null });
      const outra = await service.enviar(pedido(cliente.id), null);
      const corrida = await Promise.allSettled(
        Array.from({ length: 4 }, () => service.liberarReenvio(outra.mensagem.id, { motivo: "Liberação concorrente" }, null)),
      );
      expect(corrida.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });
  });

  describe("bloqueio por número", () => {
    it("bloqueio manual impede o envio (sem gravar nem chamar o provedor); desbloqueio libera e preserva histórico", async () => {
      const cliente = await novoCliente();
      await bloqueios.bloquearCliente(cliente.id, "Pediu para não receber", "admin-1");
      await expect(service.enviar(pedido(cliente.id), null)).rejects.toMatchObject({ code: "WHATSAPP_CONTATO_BLOQUEADO" });
      expect(provedor.chamadas).toHaveLength(0);
      expect(await mensagemModel.countDocuments({})).toBe(0);

      await bloqueios.desbloquearCliente(cliente.id, "Cliente voltou a autorizar", "admin-1");
      await service.enviar(pedido(cliente.id), null);
      expect(provedor.chamadas).toHaveLength(1);
      const historico = await bloqueioModel.find({ chave: e164(cliente.telefone) }).lean();
      expect(historico).toHaveLength(1);
      expect(historico[0]?.ativo).toBe(false);
      expect(historico[0]?.motivoDesbloqueio).toBe("Cliente voltou a autorizar");
    });

    it("CONCORRÊNCIA: bloqueios simultâneos do mesmo número → um único bloqueio ativo", async () => {
      const cliente = await novoCliente();
      const r = await Promise.all(Array.from({ length: 6 }, () => bloqueios.bloquearCliente(cliente.id, null, null)));
      expect(r.filter((x) => x.criado)).toHaveLength(1);
      expect(new Set(r.map((x) => x.bloqueio.id)).size).toBe(1);
      expect(await bloqueioModel.countDocuments({ chave: e164(cliente.telefone), ativo: true })).toBe(1);
    });

    it("sobrevive à exclusão do cliente: recadastro com o mesmo número continua bloqueado", async () => {
      const telefone = telefoneUnico();
      const antigo = await clientes.criar({ nome: "Cliente Antigo", telefone }, null);
      await bloqueios.bloquearCliente(antigo.id, null, null);
      await clientes.excluir(antigo.id, null);
      const novo = await clientes.criar({ nome: "Cliente Novo", telefone }, null);
      await expect(service.enviar(pedido(novo.id), null)).rejects.toMatchObject({ code: "WHATSAPP_CONTATO_BLOQUEADO" });
    });

    it("troca de telefone: o número antigo segue bloqueado; o novo NÃO herda o bloqueio", async () => {
      const cliente = await novoCliente();
      const antigo = e164(cliente.telefone);
      await bloqueios.bloquearCliente(cliente.id, null, null);
      await clientes.atualizar(cliente.id, { nome: cliente.nome, telefone: telefoneUnico() }, null);
      const { mensagem } = await service.enviar(pedido(cliente.id), null);
      expect(mensagem.estado).toBe("aceita");
      expect(await bloqueioModel.countDocuments({ chave: antigo, ativo: true })).toBe(1);
    });

    it("bloqueio por waId devolvido pelo provedor impede envio ao número que o originou (sem aproximação)", async () => {
      const cliente = await novoCliente();
      provedor.resultado = async (i) => ({ resultado: "aceita", wamid: `wamid.${i.referenciaInterna}`, waId: "558399990000" });
      await service.enviar(pedido(cliente.id), null);
      await bloqueiosRepo.bloquear(
        { chave: "558399990000", tipoChave: "WAID", clienteId: null, origem: "PALAVRA_CHAVE", motivo: null, usuarioId: null },
        agora,
      );
      await expect(service.enviar(pedido(cliente.id), null)).rejects.toMatchObject({ code: "WHATSAPP_CONTATO_BLOQUEADO" });
      // Outro número (que não recebeu aquele waId) não é afetado.
      const outro = await novoCliente();
      provedor.resultado = new ProvedorEnvioFalso().resultado;
      expect((await service.enviar(pedido(outro.id), null)).mensagem.estado).toBe("aceita");
    });

    it("opt-out de marketing informado pelo provedor entra na lista de bloqueio", async () => {
      const cliente = await novoCliente();
      provedor.resultado = async () => ({ resultado: "recusada", codigo: "OPT_OUT_MARKETING", codigoProvedor: "131050" });
      await service.enviar(pedido(cliente.id), null);
      const b = await bloqueioModel.findOne({ chave: e164(cliente.telefone), ativo: true }).lean();
      expect(b?.origem).toBe("META_OPT_OUT");
      await expect(service.enviar(pedido(cliente.id), null)).rejects.toMatchObject({ code: "WHATSAPP_CONTATO_BLOQUEADO" });
    });

    it("bloqueio sem cliente ativo aparece na listagem e pode ser removido por id; re-bloquear depois funciona", async () => {
      const { bloqueio } = await bloqueiosRepo.bloquear(
        { chave: "+5583912345678", tipoChave: "E164", clienteId: null, origem: "PALAVRA_CHAVE", motivo: null, usuarioId: null },
        agora,
      );
      const lista = await bloqueios.listar(true, 1, 20);
      expect(lista.data.map((b) => b.id)).toContain(String(bloqueio._id));
      expect(lista.data[0]!.numeroMascarado).toBe("+55 83 9****-5678");
      await bloqueios.desbloquearPorId(String(bloqueio._id), "Engano", "admin-1");
      await expect(bloqueios.desbloquearPorId(String(bloqueio._id), "Engano", "admin-1")).rejects.toMatchObject({ code: "CONFLICT" });
      const denovo = await bloqueiosRepo.bloquear(
        { chave: "+5583912345678", tipoChave: "E164", clienteId: null, origem: "ADMIN", motivo: null, usuarioId: null },
        agora,
      );
      expect(denovo.criado).toBe(true);
      expect(await bloqueioModel.countDocuments({ chave: "+5583912345678" })).toBe(2);
    });
  });

  describe("logs", () => {
    let espiaLog: ReturnType<typeof spyOn>;
    let espiaWarn: ReturnType<typeof spyOn>;
    beforeEach(() => {
      espiaLog = spyOn(Logger.prototype, "log");
      espiaWarn = spyOn(Logger.prototype, "warn");
    });
    afterEach(() => {
      espiaLog.mockRestore();
      espiaWarn.mockRestore();
    });

    it("nunca registram telefone (nem parcial), nome ou texto da mensagem", async () => {
      const cliente = await novoCliente("Beatriz Sigilosa");
      await service.enviar(pedido(cliente.id), "admin-1");
      await bloqueios.bloquearCliente(cliente.id, null, "admin-1");
      provedor.resultado = async () => {
        throw new Error(`falhou para ${cliente.telefone}`); // mesmo se o provedor vazar o número no erro
      };
      const outro = await novoCliente("Carla Sigilosa");
      await service.enviar(pedido(outro.id), null);

      const linhas = [...espiaLog.mock.calls, ...espiaWarn.mock.calls].map((c) => String(c[0]));
      expect(linhas.length).toBeGreaterThan(0);
      for (const linha of linhas) {
        for (const tel of [cliente.telefone, outro.telefone]) {
          expect(linha).not.toContain(tel);
          expect(linha).not.toContain(tel.slice(-8));
        }
        expect(linha).not.toContain("Beatriz");
        expect(linha).not.toContain("Carla");
        expect(linha).not.toContain("aniversário");
      }
    });
  });
});
