import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { ClientesService } from "../clientes/clientes.service.js";
import { FornecedoresService } from "../fornecedores/fornecedores.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import type { EnviarTextoWhatsappInput, EnviarTextoWhatsappResultado, WhatsappProvider } from "./providers/whatsapp-provider.interface.js";
import { WHATSAPP_PROVIDER } from "./whatsapp.constants.js";
import { WhatsappModule } from "./whatsapp.module.js";
import { WhatsappService } from "./whatsapp.service.js";
import type { StatusWhatsapp } from "./whatsapp.types.js";

/**
 * Nunca chama a Evolution API de verdade: o provider real
 * (`EvolutionApiProvider`) é substituído por este dublê controlado — o
 * objetivo aqui é testar a RESOLUÇÃO de destinatário (Cliente/Fornecedor/
 * Vendedor → telefone real do cadastro), não a integração HTTP externa (essa
 * fica em `evolution-api.provider.spec.ts`).
 */
class WhatsappProviderFalso implements WhatsappProvider {
  ultimoEnvio: EnviarTextoWhatsappInput | null = null;
  proximoResultado: EnviarTextoWhatsappResultado = { idExterno: "msg-fake-1" };

  async obterStatus(): Promise<StatusWhatsapp> {
    return { provider: "evolution-api", transporte: "baileys", instance: "teste", status: "CONNECTED", numero: null, qrCode: null };
  }
  async conectar(): Promise<StatusWhatsapp> {
    return this.obterStatus();
  }
  async desconectar(): Promise<StatusWhatsapp> {
    return this.obterStatus();
  }
  async enviarTexto(input: EnviarTextoWhatsappInput): Promise<EnviarTextoWhatsappResultado> {
    this.ultimoEnvio = input;
    return this.proximoResultado;
  }
}

const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

describe("WhatsappService (integração — MongoDB real, provider falso)", () => {
  let moduleRef: TestingModule;
  let service: WhatsappService;
  let providerFalso: WhatsappProviderFalso;
  let clientesService: ClientesService;
  let fornecedoresService: FornecedoresService;
  let vendedoresService: VendedoresService;
  let connection: Connection;

  beforeAll(async () => {
    providerFalso = new WhatsappProviderFalso();

    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, WhatsappModule],
    })
      .overrideProvider(WHATSAPP_PROVIDER)
      .useValue(providerFalso)
      .compile();

    service = moduleRef.get(WhatsappService);
    clientesService = moduleRef.get(ClientesService);
    fornecedoresService = moduleRef.get(FornecedoresService);
    vendedoresService = moduleRef.get(VendedoresService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection("fornecedores").deleteMany({});
    await connection.collection("eventos_fornecedor").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("sequencias").deleteMany({});
    await moduleRef.close();
  });

  describe("enviarMensagem", () => {
    it("cliente inexistente: lança 404 sem chamar o provider", async () => {
      providerFalso.ultimoEnvio = null;
      await expect(
        service.enviarMensagem({ tipo: "CLIENTE", id: "65f1a2b3c4d5e6f7a8b9c0d1" }, null),
      ).rejects.toThrow(ApiException);
      expect(providerFalso.ultimoEnvio).toBeNull();
    });

    it("resolve telefone do CADASTRO do cliente (nunca aceita telefone arbitrário) e envia", async () => {
      const cliente = await clientesService.criar(
        { nome: "Maria Teste WhatsApp", telefone: "83999990001" },
        null,
      );

      const resultado = await service.enviarMensagem({ tipo: "CLIENTE", id: cliente.id }, "usuario-1");

      expect(providerFalso.ultimoEnvio?.telefone).toBe("+5583999990001");
      expect(resultado.destinatario).toBe("+5583999990001");
      expect(resultado.tipo).toBe("CLIENTE");
      expect(resultado.status).toBe("enviada");
    });

    it("usa o template padrão quando `mensagem` não é informada", async () => {
      const cliente = await clientesService.criar(
        { nome: "Joana Sem Mensagem", telefone: "83999990002" },
        null,
      );

      await service.enviarMensagem({ tipo: "CLIENTE", id: cliente.id }, null);

      expect(providerFalso.ultimoEnvio?.mensagem).toContain("Joana");
    });

    it("usa a mensagem informada (composta/editada no Backoffice) quando presente", async () => {
      const cliente = await clientesService.criar(
        { nome: "Ana Com Mensagem", telefone: "83999990003" },
        null,
      );

      await service.enviarMensagem({ tipo: "CLIENTE", id: cliente.id, mensagem: "Mensagem customizada" }, null);

      expect(providerFalso.ultimoEnvio?.mensagem).toBe("Mensagem customizada");
    });

    it("resolve telefone do cadastro de FORNECEDOR", async () => {
      const fornecedor = await fornecedoresService.criar(
        { nome: "Fornecedor Teste WhatsApp", contato: "Fulano", telefone: "83999990004" },
        null,
      );

      const resultado = await service.enviarMensagem({ tipo: "FORNECEDOR", id: fornecedor.id }, null);

      expect(providerFalso.ultimoEnvio?.telefone).toBe("+5583999990004");
      expect(resultado.tipo).toBe("FORNECEDOR");
    });

    it("resolve telefone do cadastro de VENDEDOR", async () => {
      const vendedor = await vendedoresService.criar(
        { nome: "Vendedora Teste WhatsApp", telefone: "83999990005", ativo: true, senha: "senha123" },
        null,
      );

      const resultado = await service.enviarMensagem({ tipo: "VENDEDOR", id: vendedor.id }, null);

      expect(providerFalso.ultimoEnvio?.telefone).toBe("+5583999990005");
      expect(resultado.tipo).toBe("VENDEDOR");
    });

    it("provider desabilitado (NOT_CONFIGURED via provider real) — aqui simulado lançando no provider falso", async () => {
      const cliente = await clientesService.criar(
        { nome: "Cliente Provider Indisponivel", telefone: "83999990006" },
        null,
      );

      const providerComErro: WhatsappProvider = {
        obterStatus: () => providerFalso.obterStatus(),
        conectar: () => providerFalso.conectar(),
        desconectar: () => providerFalso.desconectar(),
        enviarTexto: async () => {
          throw ApiException.whatsappNotConfigured();
        },
      };
      const moduleComErro = await Test.createTestingModule({
        imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, WhatsappModule],
      })
        .overrideProvider(WHATSAPP_PROVIDER)
        .useValue(providerComErro)
        .compile();
      const servicoComErro = moduleComErro.get(WhatsappService);

      await expect(servicoComErro.enviarMensagem({ tipo: "CLIENTE", id: cliente.id }, null)).rejects.toThrow(
        ApiException,
      );
      await moduleComErro.close();
    });

    it("erro do provider (ex.: falha de envio) propaga sem mascarar como sucesso", async () => {
      const cliente = await clientesService.criar(
        { nome: "Cliente Erro Envio", telefone: "83999990007" },
        null,
      );

      const providerComFalha: WhatsappProvider = {
        obterStatus: () => providerFalso.obterStatus(),
        conectar: () => providerFalso.conectar(),
        desconectar: () => providerFalso.desconectar(),
        enviarTexto: async () => {
          throw ApiException.whatsappSendFailed();
        },
      };
      const moduleComFalha = await Test.createTestingModule({
        imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, WhatsappModule],
      })
        .overrideProvider(WHATSAPP_PROVIDER)
        .useValue(providerComFalha)
        .compile();
      const servicoComFalha = moduleComFalha.get(WhatsappService);

      await expect(servicoComFalha.enviarMensagem({ tipo: "CLIENTE", id: cliente.id }, null)).rejects.toThrow(
        ApiException,
      );
      await moduleComFalha.close();
    });

    it("cliente sem telefone (defensivo): rejeita antes de chamar o provider", async () => {
      // `ClientesService.criar` já exige telefone válido na entrada (10-11
      // dígitos) — este cenário só é alcançável defensivamente, então o
      // registro é inserido diretamente no banco, sem passar pela validação
      // do módulo Clientes, para exercitar a defesa de `WhatsappService`.
      providerFalso.ultimoEnvio = null;
      const clienteSemTelefone = await connection.collection("clientes").insertOne({
        codigo: "CLI-9999",
        nome: "Cliente Sem Telefone",
        foto: null,
        telefone: "",
        telefoneNormalizado: "",
        dataNascimento: null,
        observacao: "",
        compras: 0,
        totalComprado: 0,
        ultimaCompra: null,
        excluidoEm: null,
        criadoEm: new Date(),
        atualizadoEm: new Date(),
      });

      await expect(
        service.enviarMensagem({ tipo: "CLIENTE", id: String(clienteSemTelefone.insertedId) }, null),
      ).rejects.toThrow(ApiException);
      expect(providerFalso.ultimoEnvio).toBeNull();
    });

    it("fornecedor sem telefone (campo opcional no cadastro real): rejeita antes de chamar o provider", async () => {
      const fornecedor = await fornecedoresService.criar({ nome: "Fornecedor Sem Telefone" }, null);
      await expect(service.enviarMensagem({ tipo: "FORNECEDOR", id: fornecedor.id }, null)).rejects.toThrow(
        ApiException,
      );
    });
  });

  describe("obterStatus/conectar/desconectar", () => {
    it("delega ao provider configurado", async () => {
      expect((await service.obterStatus()).status).toBe("CONNECTED");
      expect((await service.conectar()).status).toBe("CONNECTED");
      expect((await service.desconectar()).status).toBe("CONNECTED");
    });
  });
});
