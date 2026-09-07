import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { CriarVendedorDto } from "./dto/criar-vendedor.dto.js";
import type { ListarVendedoresQueryDto } from "./dto/listar-vendedores-query.dto.js";
import { VendedoresModule } from "./vendedores.module.js";
import { VendedoresService } from "./vendedores.service.js";

// `VendedoresController` usa `@UseGuards(JwtAuthGuard)`, que injeta `JwtService`
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
  return `1100${String(contadorTelefone).padStart(6, "0")}`;
}

function payloadVendedor(sufixo: string, extra: Partial<CriarVendedorDto> = {}): CriarVendedorDto {
  return {
    nome: `Vendedor Teste ${sufixo}`,
    telefone: telefoneUnico(),
    ativo: true,
    senha: "senha123",
    ...extra,
  };
}

function queryPadrao(extra: Partial<ListarVendedoresQueryDto> = {}): ListarVendedoresQueryDto {
  return {
    ordenarPor: "nome",
    ordem: "asc",
    status: [],
    vendas: [],
    valor: [],
    ultimaVenda: [],
    nascimento: [],
    observacao: [],
    page: 1,
    limit: 20,
    ...extra,
  };
}

describe("VendedoresService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: VendedoresService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, VendedoresModule],
    }).compile();
    service = moduleRef.get(VendedoresService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: "vendedor" });
    await connection.collection("eventos_vendedor").deleteMany({});
    await moduleRef.close();
  });

  describe("criação, código e senha", () => {
    it("cria um vendedor com código sequencial gerado pelo backend e agregados zerados", async () => {
      const vendedor = await service.criar(payloadVendedor("A"), null);
      expect(vendedor.codigo).toMatch(/^VEN-\d{4}$/);
      expect(vendedor.vendas).toBe(0);
      expect(vendedor.totalVendido).toBe(0);
      expect(vendedor.ultimaVenda).toBeNull();
    });

    it("gera códigos distintos e sequenciais para vendedores sucessivos", async () => {
      const primeiro = await service.criar(payloadVendedor("B1"), null);
      const segundo = await service.criar(payloadVendedor("B2"), null);
      const seqPrimeiro = Number(primeiro.codigo.split("-")[1]);
      const seqSegundo = Number(segundo.codigo.split("-")[1]);
      expect(seqSegundo).toBe(seqPrimeiro + 1);
    });

    it("rejeita criação sem senha", async () => {
      const { senha: _senha, ...semSenha } = payloadVendedor("C");
      await expect(service.criar(semSenha as CriarVendedorDto, null)).rejects.toThrow(ApiException);
    });

    it("nunca expõe senha nem senhaHash na resposta pública", async () => {
      const vendedor = await service.criar(payloadVendedor("D"), null);
      const serializado = JSON.parse(JSON.stringify(vendedor)) as Record<string, unknown>;
      expect(serializado["senha"]).toBeUndefined();
      expect(serializado["senhaHash"]).toBeUndefined();
    });

    it("grava um hash argon2id verificável, nunca a senha em texto puro", async () => {
      const vendedor = await service.criar(payloadVendedor("E", { senha: "minhaSenhaSegura" }), null);
      const bruto = await connection.collection("vendedores").findOne({ codigo: vendedor.codigo });
      expect(bruto?.["senhaHash"]).not.toBe("minhaSenhaSegura");
      expect(typeof bruto?.["senhaHash"]).toBe("string");
      expect(await Bun.password.verify("minhaSenhaSegura", bruto!["senhaHash"] as string)).toBe(true);
    });

    it("registra o evento vendedor.criado com o usuário autenticado, sem detalhes sensíveis", async () => {
      const vendedor = await service.criar(payloadVendedor("F"), "usuario-teste-1");
      const eventos = await connection.collection("eventos_vendedor").find({ tipo: "vendedor.criado" }).toArray();
      const evento = eventos.find((item) => String(item["vendedorId"]) === vendedor.id);
      expect(evento?.["usuarioId"]).toBe("usuario-teste-1");
      expect(JSON.stringify(evento?.["detalhes"])).not.toContain("senha");
    });

    it("nunca repete nem pula código sob criações concorrentes", async () => {
      const chamadas = Array.from({ length: 15 }, (_, indice) => service.criar(payloadVendedor(`CONC-${indice}`), null));
      const vendedores = await Promise.all(chamadas);
      const codigos = new Set(vendedores.map((vendedor) => vendedor.codigo));
      expect(codigos.size).toBe(15);
    });
  });

  describe("duplicidade de telefone", () => {
    it("rejeita cadastrar duas vezes o mesmo telefone", async () => {
      const telefone = telefoneUnico();
      await service.criar(payloadVendedor("G1", { telefone }), null);
      await expect(service.criar(payloadVendedor("G2", { telefone }), null)).rejects.toThrow(ApiException);
    });

    it("permite manter o próprio telefone ao atualizar", async () => {
      const vendedor = await service.criar(payloadVendedor("H"), null);
      const atualizado = await service.atualizar(vendedor.id, payloadVendedor("H", { telefone: vendedor.telefone }), null);
      expect(atualizado.telefone).toBe(vendedor.telefone);
    });

    it("rejeita telefone com quantidade de dígitos inválida", async () => {
      await expect(service.criar(payloadVendedor("I", { telefone: "123" }), null)).rejects.toThrow(ApiException);
    });
  });

  describe("atualização e senha", () => {
    it("atualiza dados cadastrais sem alterar a senha quando ela não é enviada", async () => {
      const vendedor = await service.criar(payloadVendedor("J", { senha: "senhaOriginal" }), null);
      const antes = await connection.collection("vendedores").findOne({ codigo: vendedor.codigo });

      const { senha: _semSenha, ...payloadSemSenha } = payloadVendedor("J", { telefone: vendedor.telefone });
      const atualizado = await service.atualizar(vendedor.id, { ...payloadSemSenha, nome: "Nome Atualizado" } as CriarVendedorDto, null);
      const depois = await connection.collection("vendedores").findOne({ codigo: vendedor.codigo });

      expect(atualizado.nome).toBe("Nome Atualizado");
      expect(depois?.["senhaHash"]).toBe(antes?.["senhaHash"]);
    });

    it("substitui a senha quando enviada em atualizar()", async () => {
      const vendedor = await service.criar(payloadVendedor("K", { senha: "senhaAntiga1" }), null);
      await service.atualizar(vendedor.id, payloadVendedor("K", { telefone: vendedor.telefone, senha: "senhaNova12" }), null);
      const bruto = await connection.collection("vendedores").findOne({ codigo: vendedor.codigo });
      expect(await Bun.password.verify("senhaNova12", bruto!["senhaHash"] as string)).toBe(true);
    });

    it("lança NOT_FOUND ao atualizar um vendedor inexistente", async () => {
      await expect(service.atualizar("65f1a2b3c4d5e6f7a8b9c0d1", payloadVendedor("L"), null)).rejects.toThrow(ApiException);
    });
  });

  describe("redefinição dedicada de senha", () => {
    it("substitui o hash e registra evento sem senha nos detalhes", async () => {
      const vendedor = await service.criar(payloadVendedor("M", { senha: "senhaInicial1" }), null);
      await service.redefinirSenha(vendedor.id, { senha: "senhaRedefinida1" }, "admin-teste");
      const bruto = await connection.collection("vendedores").findOne({ codigo: vendedor.codigo });
      expect(await Bun.password.verify("senhaRedefinida1", bruto!["senhaHash"] as string)).toBe(true);

      const eventos = await connection.collection("eventos_vendedor").find({ tipo: "vendedor.senha_redefinida" }).toArray();
      const evento = eventos.find((item) => String(item["vendedorId"]) === vendedor.id);
      expect(evento?.["usuarioId"]).toBe("admin-teste");
      expect(JSON.stringify(evento?.["detalhes"] ?? {})).not.toContain("senha");
    });
  });

  describe("status (ativo/inativo)", () => {
    it("inativa e reativa um vendedor", async () => {
      const vendedor = await service.criar(payloadVendedor("N"), null);
      const inativado = await service.alterarStatus(vendedor.id, { ativo: false }, null);
      expect(inativado.ativo).toBe(false);
      const reativado = await service.alterarStatus(vendedor.id, { ativo: true }, null);
      expect(reativado.ativo).toBe(true);
    });
  });

  describe("busca, paginação e ordenação", () => {
    it("lista vendedores com paginação e meta", async () => {
      const nomeUnico = `Listagem ${Date.now()}`;
      await service.criar(payloadVendedor("O", { nome: nomeUnico }), null);
      const resultado = await service.listar(queryPadrao({ busca: nomeUnico }));
      expect(resultado.data).toHaveLength(1);
      expect(resultado.meta.total).toBe(1);
      expect(resultado.meta.page).toBe(1);
      expect(resultado.meta.totalPages).toBe(1);
    });

    it("busca por código e por telefone também encontra o vendedor", async () => {
      const vendedor = await service.criar(payloadVendedor("P"), null);
      const porCodigo = await service.listar(queryPadrao({ busca: vendedor.codigo }));
      expect(porCodigo.data).toHaveLength(1);
      const porTelefone = await service.listar(queryPadrao({ busca: vendedor.telefone }));
      expect(porTelefone.data).toHaveLength(1);
    });

    it("pagina corretamente quando há mais registros que o limite", async () => {
      const prefixo = `Pag${Date.now()}`;
      await Promise.all(
        Array.from({ length: 5 }, (_, indice) => service.criar(payloadVendedor(`${prefixo}-${indice}`, { nome: `${prefixo} ${indice}` }), null)),
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
      await service.criar(payloadVendedor("Z", { nome: `${prefixo} Zulu` }), null);
      await service.criar(payloadVendedor("A", { nome: `${prefixo} Alfa` }), null);
      const asc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "asc" }));
      const desc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "desc" }));
      expect(asc.data[0]?.nome).toContain("Alfa");
      expect(desc.data[0]?.nome).toContain("Zulu");
    });
  });

  describe("filtros (facetas)", () => {
    it("filtro status=inativos só retorna vendedores inativos", async () => {
      const prefixo = `Status${Date.now()}`;
      await service.criar(payloadVendedor("ativo", { nome: `${prefixo} Ativo` }), null);
      await service.criar(payloadVendedor("inativo", { nome: `${prefixo} Inativo`, ativo: false }), null);

      const inativos = await service.listar(queryPadrao({ busca: prefixo, status: ["inativos"] }));
      expect(inativos.data).toHaveLength(1);
      expect(inativos.data[0]?.ativo).toBe(false);
    });

    it("filtro vendas=sem retorna todos, pois o módulo de Vendas ainda não existe", async () => {
      const prefixo = `Vendas${Date.now()}`;
      await service.criar(payloadVendedor("v1", { nome: prefixo }), null);
      const resultado = await service.listar(queryPadrao({ busca: prefixo, vendas: ["sem"] }));
      expect(resultado.data).toHaveLength(1);
    });

    it("filtro vendas=21+ não retorna ninguém enquanto não existir módulo de Vendas", async () => {
      const prefixo = `Vendas21${Date.now()}`;
      await service.criar(payloadVendedor("v2", { nome: prefixo }), null);
      const resultado = await service.listar(queryPadrao({ busca: prefixo, vendas: ["21+"] }));
      expect(resultado.data).toHaveLength(0);
    });

    it("filtro nascimento=com só retorna vendedores com data de nascimento cadastrada", async () => {
      const prefixo = `Nasc${Date.now()}`;
      await service.criar(payloadVendedor("com-data", { nome: `${prefixo} Com`, dataNascimento: "1994-03-12" }), null);
      await service.criar(payloadVendedor("sem-data", { nome: `${prefixo} Sem` }), null);

      const comData = await service.listar(queryPadrao({ busca: prefixo, nascimento: ["com"] }));
      expect(comData.data).toHaveLength(1);
      expect(comData.data[0]?.nome).toContain("Com");
    });

    it("facets do grupo observacao contam sobre o conjunto completo, não a página", async () => {
      const prefixo = `Facet${Date.now()}`;
      await service.criar(payloadVendedor("f1", { nome: `${prefixo} 1`, observacao: "Nota" }), null);
      await service.criar(payloadVendedor("f2", { nome: `${prefixo} 2` }), null);
      await service.criar(payloadVendedor("f3", { nome: `${prefixo} 3` }), null);

      const resultado = await service.listar(queryPadrao({ busca: prefixo, limit: 1 }));
      expect(resultado.data).toHaveLength(1); // página pequena...
      const observacao = resultado.facets["observacao"] ?? [];
      const com = observacao.find((opcao) => opcao.valor === "com")?.count ?? 0;
      const sem = observacao.find((opcao) => opcao.valor === "sem")?.count ?? 0;
      expect(com).toBe(1); // ...mas o facet reflete os 3 vendedores da busca, não só a página de 1
      expect(sem).toBe(2);
    });
  });

  describe("exclusão (soft delete)", () => {
    it("some da listagem/detalhe após excluído, mas o documento continua no banco", async () => {
      const criado = await service.criar(payloadVendedor("Q"), null);
      await service.excluir(criado.id, null);
      await expect(service.obterPorId(criado.id)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("vendedores").findOne({ codigo: criado.codigo });
      expect(bruto?.["excluidoEm"]).not.toBeNull();
    });

    it("não reaproveita o código de um vendedor excluído", async () => {
      const excluido = await service.criar(payloadVendedor("R1"), null);
      await service.excluir(excluido.id, null);
      const novo = await service.criar(payloadVendedor("R2"), null);
      expect(novo.codigo).not.toBe(excluido.codigo);
    });

    it("permite recadastrar o telefone de um vendedor já excluído", async () => {
      const telefone = telefoneUnico();
      const excluido = await service.criar(payloadVendedor("S1", { telefone }), null);
      await service.excluir(excluido.id, null);
      const novo = await service.criar(payloadVendedor("S2", { telefone }), null);
      expect(novo.telefone).toBe(telefone);
    });
  });

  describe("histórico de vendas (Vendas ainda não implementado)", () => {
    it("devolve lista vazia para um vendedor existente", async () => {
      const vendedor = await service.criar(payloadVendedor("T"), null);
      const vendas = await service.listarVendas(vendedor.id);
      expect(vendas.data).toEqual([]);
      expect(vendas.meta.total).toBe(0);
    });

    it("lança NOT_FOUND para um vendedor inexistente", async () => {
      await expect(service.listarVendas("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });
  });
});
