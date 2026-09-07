import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import configuration from "../../config/configuration.js";
import { validateEnv } from "../../config/env.validation.js";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import type { CriarClienteDto } from "../clientes/dto/criar-cliente.dto.js";
import { ClientesService } from "../clientes/clientes.service.js";
import { PdvClientesModule } from "./pdv-clientes.module.js";
import { PdvClientesService } from "./pdv-clientes.service.js";

// `ClientesController`/`VendedoresController` (importados transitivamente)
// usam `JwtAuthGuard` do ADMIN via `@UseGuards`, que precisa de um
// `JwtService` GLOBAL para resolver — nada a ver com a autenticação do PDV.
const JWT_ADMIN_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-admin-de-teste",
  signOptions: { expiresIn: "15m" },
});

let contador = 0;
function sufixo(): string {
  contador += 1;
  return String(contador);
}

function telefoneUnico(): string {
  const s = sufixo();
  return `1191${s.padStart(6, "0")}`;
}

describe("PdvClientesService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: PdvClientesService;
  let clientesService: ClientesService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseModuloDeTeste(),
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
        JWT_ADMIN_MODULO_DE_TESTE,
        PdvClientesModule,
      ],
    }).compile();
    service = moduleRef.get(PdvClientesService);
    clientesService = moduleRef.get(ClientesService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["cliente"] } });
    await moduleRef.close();
  });

  async function criarCliente(extra: Partial<CriarClienteDto> = {}) {
    const s = sufixo();
    const dto: CriarClienteDto = {
      nome: `Cliente PDV ${s}`,
      telefone: telefoneUnico(),
      ...extra,
    };
    return clientesService.criar(dto, null);
  }

  describe("listar", () => {
    it("cliente excluído não aparece na busca", async () => {
      const cliente = await criarCliente();
      await clientesService.excluir(cliente.id, null);

      const resultado = await service.listar({ busca: cliente.nome, page: 1, limit: 20 });
      expect(resultado.data.some((item) => item.id === cliente.id)).toBe(false);
    });

    it("busca por nome é case-insensitive e server-side", async () => {
      const cliente = await criarCliente({ nome: `Vitória Catálogo ${sufixo()}` });
      const resultado = await service.listar({ busca: cliente.nome.toUpperCase(), page: 1, limit: 20 });
      expect(resultado.data.some((item) => item.id === cliente.id)).toBe(true);
    });

    it("busca por telefone encontra o cliente", async () => {
      const cliente = await criarCliente();
      const resultado = await service.listar({ busca: cliente.telefone, page: 1, limit: 20 });
      expect(resultado.data.some((item) => item.id === cliente.id)).toBe(true);
    });

    it("paginação é real (server-side): meta reflete total/página/limite pedidos", async () => {
      const nomeBase = `Paginacao PDV Clientes ${sufixo()}`;
      await criarCliente({ nome: `${nomeBase} A` });
      await criarCliente({ nome: `${nomeBase} B` });
      await criarCliente({ nome: `${nomeBase} C` });

      const pagina1 = await service.listar({ busca: nomeBase, page: 1, limit: 2 });
      expect(pagina1.data).toHaveLength(2);
      expect(pagina1.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });

      const pagina2 = await service.listar({ busca: nomeBase, page: 2, limit: 2 });
      expect(pagina2.data).toHaveLength(1);
    });

    it("ordenação é sempre por nome/asc (contrato do PDV não expõe ordenação)", async () => {
      const nomeBase = `Ordenacao PDV Clientes ${sufixo()}`;
      await criarCliente({ nome: `${nomeBase} Zebra` });
      await criarCliente({ nome: `${nomeBase} Alfa` });

      const resultado = await service.listar({ busca: nomeBase, page: 1, limit: 20 });
      expect(resultado.data[0]!.nome.endsWith("Alfa")).toBe(true);
    });

    it("busca sem resultados retorna lista vazia paginada (nunca 404)", async () => {
      const resultado = await service.listar({ busca: `Inexistente ${sufixo()}`, page: 1, limit: 20 });
      expect(resultado.data).toHaveLength(0);
      expect(resultado.meta.total).toBe(0);
    });

    it("nunca expõe campos administrativos (compras, totalComprado, ultimaCompra, dataNascimento, observacao, telefoneNormalizado)", async () => {
      const cliente = await criarCliente({ observacao: "Prefere tons pastel", dataNascimento: "1990-05-10" });

      const resultado = await service.listar({ busca: cliente.nome, page: 1, limit: 20 });
      const item = resultado.data.find((p) => p.id === cliente.id)!;
      const bruto = JSON.stringify(item);
      expect(bruto).not.toContain("compras");
      expect(bruto).not.toContain("totalComprado");
      expect(bruto).not.toContain("ultimaCompra");
      expect(bruto).not.toContain("dataNascimento");
      expect(bruto).not.toContain("observacao");
      expect(bruto).not.toContain("telefoneNormalizado");
    });
  });
});
