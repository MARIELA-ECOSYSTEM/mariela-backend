import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { CriarClienteDto } from "./dto/criar-cliente.dto.js";
import type { ListarClientesQueryDto } from "./dto/listar-clientes-query.dto.js";
import { ClientesModule } from "./clientes.module.js";
import { ClientesService } from "./clientes.service.js";

// `ClientesController` usa `@UseGuards(JwtAuthGuard)`, que injeta `JwtService`
// — só disponível globalmente via `AppModule` de verdade. Este teste foca no
// service (não no HTTP/guard), então basta um `JwtModule` local mínimo para o
// grafo de DI compilar; nenhum token é de fato emitido/validado aqui.
const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

let contadorTelefone = 0;
/** Cada chamada gera um telefone novo e válido (10 dígitos) — telefone é único. */
function telefoneUnico(): string {
  contadorTelefone += 1;
  return `8300${String(contadorTelefone).padStart(6, "0")}`;
}

function payloadCliente(sufixo: string, extra: Partial<CriarClienteDto> = {}): CriarClienteDto {
  return {
    nome: `Cliente Teste ${sufixo}`,
    telefone: telefoneUnico(),
    ...extra,
  };
}

function queryPadrao(extra: Partial<ListarClientesQueryDto> = {}): ListarClientesQueryDto {
  return {
    ordenarPor: "nome",
    ordem: "asc",
    recencia: [],
    historico: [],
    aniversario: [],
    observacao: [],
    page: 1,
    limit: 20,
    ...extra,
  };
}

describe("ClientesService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: ClientesService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, ClientesModule],
    }).compile();
    service = moduleRef.get(ClientesService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("clientes").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: "cliente" });
    await connection.collection("eventos_cliente").deleteMany({});
    await moduleRef.close();
  });

  describe("criação e código", () => {
    it("cria um cliente com código sequencial gerado pelo backend e agregados zerados", async () => {
      const cliente = await service.criar(payloadCliente("A"), null);
      expect(cliente.codigo).toMatch(/^CLI-\d{4}$/);
      expect(cliente.compras).toBe(0);
      expect(cliente.totalComprado).toBe(0);
      expect(cliente.ultimaCompra).toBeNull();
    });

    it("gera códigos distintos e sequenciais para clientes sucessivos", async () => {
      const primeiro = await service.criar(payloadCliente("B1"), null);
      const segundo = await service.criar(payloadCliente("B2"), null);
      const seqPrimeiro = Number(primeiro.codigo.split("-")[1]);
      const seqSegundo = Number(segundo.codigo.split("-")[1]);
      expect(seqSegundo).toBe(seqPrimeiro + 1);
    });

    it("preserva a máscara do telefone exibida, mas normaliza internamente para checar duplicidade", async () => {
      const cliente = await service.criar(payloadCliente("C", { telefone: "(83) 90000-0001" }), null);
      expect(cliente.telefone).toBe("(83) 90000-0001");
    });

    it("rejeita telefone com quantidade de dígitos inválida", async () => {
      await expect(service.criar(payloadCliente("D", { telefone: "123" }), null)).rejects.toThrow(ApiException);
    });

    it("registra o evento cliente.criado com o usuário autenticado", async () => {
      const cliente = await service.criar(payloadCliente("E"), "usuario-teste-1");
      const eventos = await connection.collection("eventos_cliente").find({ tipo: "cliente.criado" }).toArray();
      expect(
        eventos.some((item) => String(item["clienteId"]) === cliente.id && item["usuarioId"] === "usuario-teste-1"),
      ).toBe(true);
    });

    it("nunca repete nem pula código sob criações concorrentes", async () => {
      const chamadas = Array.from({ length: 15 }, (_, indice) => service.criar(payloadCliente(`CONC-${indice}`), null));
      const clientes = await Promise.all(chamadas);
      const codigos = new Set(clientes.map((cliente) => cliente.codigo));
      expect(codigos.size).toBe(15);
    });
  });

  describe("duplicidade de telefone", () => {
    it("rejeita cadastrar duas vezes o mesmo telefone (mesma máscara)", async () => {
      const telefone = telefoneUnico();
      await service.criar(payloadCliente("F1", { telefone }), null);
      await expect(service.criar(payloadCliente("F2", { telefone }), null)).rejects.toThrow(ApiException);
    });

    it("rejeita o mesmo telefone com máscara diferente", async () => {
      const digitos = telefoneUnico();
      await service.criar(payloadCliente("G1", { telefone: digitos }), null);
      const mascarado = `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
      await expect(service.criar(payloadCliente("G2", { telefone: mascarado }), null)).rejects.toThrow(ApiException);
    });

    it("permite manter o próprio telefone ao atualizar (não conflita consigo mesmo)", async () => {
      const cliente = await service.criar(payloadCliente("H"), null);
      const atualizado = await service.atualizar(cliente.id, payloadCliente("H", { telefone: cliente.telefone }), null);
      expect(atualizado.telefone).toBe(cliente.telefone);
    });
  });

  describe("busca e listagem", () => {
    it("busca um cliente pelo id", async () => {
      const criado = await service.criar(payloadCliente("I"), null);
      const encontrado = await service.obterPorId(criado.id);
      expect(encontrado.codigo).toBe(criado.codigo);
    });

    it("lança NOT_FOUND para um id inexistente", async () => {
      await expect(service.obterPorId("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("lista clientes com paginação e meta", async () => {
      const nomeUnico = `Listagem ${Date.now()}`;
      await service.criar(payloadCliente("J", { nome: nomeUnico }), null);
      const resultado = await service.listar(queryPadrao({ busca: nomeUnico }));
      expect(resultado.data).toHaveLength(1);
      expect(resultado.meta.total).toBe(1);
      expect(resultado.meta.page).toBe(1);
      expect(resultado.meta.totalPages).toBe(1);
    });

    it("busca por telefone também encontra o cliente", async () => {
      const telefone = telefoneUnico();
      await service.criar(payloadCliente("K", { telefone }), null);
      const resultado = await service.listar(queryPadrao({ busca: telefone }));
      expect(resultado.data).toHaveLength(1);
    });

    it("pagina corretamente quando há mais registros que o limite", async () => {
      const prefixo = `Pag${Date.now()}`;
      await Promise.all(
        Array.from({ length: 5 }, (_, indice) => service.criar(payloadCliente(`${prefixo}-${indice}`, { nome: `${prefixo} ${indice}` }), null)),
      );
      const primeiraPagina = await service.listar(queryPadrao({ busca: prefixo, limit: 2, page: 1 }));
      const segundaPagina = await service.listar(queryPadrao({ busca: prefixo, limit: 2, page: 2 }));
      expect(primeiraPagina.data).toHaveLength(2);
      expect(segundaPagina.data).toHaveLength(2);
      expect(primeiraPagina.meta.total).toBe(5);
      expect(primeiraPagina.meta.totalPages).toBe(3);
      expect(primeiraPagina.data[0]?.id).not.toBe(segundaPagina.data[0]?.id);
    });

    it("ordena por nome (asc/desc)", async () => {
      const prefixo = `Ord${Date.now()}`;
      await service.criar(payloadCliente("Z", { nome: `${prefixo} Zulu` }), null);
      await service.criar(payloadCliente("A", { nome: `${prefixo} Alfa` }), null);
      const asc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "asc" }));
      const desc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "desc" }));
      expect(asc.data[0]?.nome).toContain("Alfa");
      expect(desc.data[0]?.nome).toContain("Zulu");
    });
  });

  describe("filtros (facetas)", () => {
    it("filtro observacao=com só retorna clientes com observação preenchida", async () => {
      const prefixo = `Obs${Date.now()}`;
      await service.criar(payloadCliente("com-obs", { nome: `${prefixo} Com`, observacao: "Gosta de vestidos longos." }), null);
      await service.criar(payloadCliente("sem-obs", { nome: `${prefixo} Sem` }), null);

      const comObservacao = await service.listar(queryPadrao({ busca: prefixo, observacao: ["com"] }));
      expect(comObservacao.data).toHaveLength(1);
      expect(comObservacao.data[0]?.observacao).toContain("vestidos");
    });

    it("filtro historico=sem retorna clientes sem nenhuma compra (todos, hoje)", async () => {
      const prefixo = `Hist${Date.now()}`;
      await service.criar(payloadCliente("hist", { nome: prefixo }), null);
      const resultado = await service.listar(queryPadrao({ busca: prefixo, historico: ["sem"] }));
      expect(resultado.data).toHaveLength(1);
    });

    it("filtro historico=com não retorna ninguém enquanto não existir módulo de Vendas", async () => {
      const prefixo = `HistCom${Date.now()}`;
      await service.criar(payloadCliente("histcom", { nome: prefixo }), null);
      const resultado = await service.listar(queryPadrao({ busca: prefixo, historico: ["com"] }));
      expect(resultado.data).toHaveLength(0);
    });

    it("filtro aniversario=com só retorna clientes com data de nascimento cadastrada", async () => {
      const prefixo = `Aniv${Date.now()}`;
      await service.criar(payloadCliente("com-data", { nome: `${prefixo} Com`, dataNascimento: "1998-05-20" }), null);
      await service.criar(payloadCliente("sem-data", { nome: `${prefixo} Sem` }), null);

      const comData = await service.listar(queryPadrao({ busca: prefixo, aniversario: ["com"] }));
      expect(comData.data).toHaveLength(1);
      expect(comData.data[0]?.nome).toContain("Com");
    });

    it("facets do grupo observacao contam sobre o conjunto completo, não a página", async () => {
      const prefixo = `Facet${Date.now()}`;
      await service.criar(payloadCliente("f1", { nome: `${prefixo} 1`, observacao: "Nota" }), null);
      await service.criar(payloadCliente("f2", { nome: `${prefixo} 2` }), null);
      await service.criar(payloadCliente("f3", { nome: `${prefixo} 3` }), null);

      const resultado = await service.listar(queryPadrao({ busca: prefixo, limit: 1 }));
      expect(resultado.data).toHaveLength(1); // página pequena...
      const observacao = resultado.facets["observacao"] ?? [];
      const com = observacao.find((opcao) => opcao.valor === "com")?.count ?? 0;
      const sem = observacao.find((opcao) => opcao.valor === "sem")?.count ?? 0;
      expect(com).toBe(1); // ...mas o facet reflete as 3 clientes da busca, não só a página de 1
      expect(sem).toBe(2);
    });
  });

  describe("atualização", () => {
    it("atualiza os dados cadastrais do cliente", async () => {
      const criado = await service.criar(payloadCliente("L"), null);
      const atualizado = await service.atualizar(criado.id, payloadCliente("L", { nome: "Nome Atualizado", telefone: criado.telefone }), null);
      expect(atualizado.nome).toBe("Nome Atualizado");
    });

    it("lança NOT_FOUND ao atualizar um cliente inexistente", async () => {
      await expect(
        service.atualizar("65f1a2b3c4d5e6f7a8b9c0d1", payloadCliente("M"), null),
      ).rejects.toThrow(ApiException);
    });
  });

  describe("exclusão (soft delete)", () => {
    it("some da listagem/detalhe após excluído, mas o documento continua no banco", async () => {
      const criado = await service.criar(payloadCliente("N"), null);
      await service.excluir(criado.id, null);
      await expect(service.obterPorId(criado.id)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("clientes").findOne({ codigo: criado.codigo });
      expect(bruto?.["excluidoEm"]).not.toBeNull();
    });

    it("não reaproveita o código de um cliente excluído", async () => {
      const excluido = await service.criar(payloadCliente("O1"), null);
      await service.excluir(excluido.id, null);
      const novo = await service.criar(payloadCliente("O2"), null);
      expect(novo.codigo).not.toBe(excluido.codigo);
    });

    it("permite recadastrar o telefone de um cliente já excluído", async () => {
      const telefone = telefoneUnico();
      const excluido = await service.criar(payloadCliente("P1", { telefone }), null);
      await service.excluir(excluido.id, null);
      const novo = await service.criar(payloadCliente("P2", { telefone }), null);
      expect(novo.telefone).toBe(telefone);
    });
  });

  describe("histórico de vendas (Vendas ainda não implementado)", () => {
    it("devolve lista vazia para um cliente existente", async () => {
      const cliente = await service.criar(payloadCliente("Q"), null);
      const vendas = await service.listarVendas(cliente.id);
      expect(vendas.data).toEqual([]);
      expect(vendas.meta.total).toBe(0);
    });

    it("lança NOT_FOUND para um cliente inexistente", async () => {
      await expect(service.listarVendas("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });
  });
});
