import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { ConfiguracoesModule } from "./configuracoes.module.js";
import { ConfiguracoesService } from "./configuracoes.service.js";
import type { AtualizarLojaDto } from "./dto/atualizar-loja.dto.js";

// `ConfiguracoesController` usa `@UseGuards(JwtAuthGuard)`, que injeta
// `JwtService` — só disponível globalmente via `AppModule` de verdade. Este
// teste foca no service, então basta um `JwtModule` local mínimo (mesmo
// padrão de `adquirentes.service.spec.ts`).
const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

function lojaValida(extra: Partial<AtualizarLojaDto> = {}): AtualizarLojaDto {
  return {
    nome: "Loja Exemplo",
    logo: "https://exemplo.com/logo.png",
    telefone: "1130000000",
    whatsapp: "11999990000",
    email: "contato@loja.com",
    endereco: { cep: "01310-100", logradouro: "Av. Paulista", numero: "1000", complemento: "", bairro: "Bela Vista", cidade: "São Paulo", estado: "SP" },
    ...extra,
  };
}

describe("ConfiguracoesService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: ConfiguracoesService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, ConfiguracoesModule],
    }).compile();
    service = moduleRef.get(ConfiguracoesService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("configuracoes").deleteMany({});
    await moduleRef.close();
  });

  describe("singleton", () => {
    it("obter() cria o documento na primeira chamada com defaults vazios", async () => {
      const configuracao = await service.obter();
      expect(configuracao.categorias).toEqual([]);
      expect(configuracao.tamanhos).toEqual([]);
      expect(configuracao.cores).toEqual([]);
      expect(configuracao.formasPagamento).toEqual([]);
      expect(configuracao.loja.nome).toBe("");

      const total = await connection.collection("configuracoes").countDocuments({});
      expect(total).toBe(1); // nunca mais de um documento
    });

    it("chamadas repetidas de obter() sempre devolvem o MESMO documento (nunca cria um segundo)", async () => {
      const primeira = await service.obter();
      const segunda = await service.obter();
      expect(String(primeira._id)).toBe(String(segunda._id));

      const total = await connection.collection("configuracoes").countDocuments({});
      expect(total).toBe(1);
    });

    it("dez chamadas concorrentes a obter() nunca criam mais de um documento", async () => {
      await connection.collection("configuracoes").deleteMany({});
      await Promise.all(Array.from({ length: 10 }, () => service.obter()));
      const total = await connection.collection("configuracoes").countDocuments({});
      expect(total).toBe(1);
    });
  });

  describe("atualizarLoja", () => {
    it("substitui os dados da loja e atualiza atualizadoEm", async () => {
      const antes = await service.obter();
      const antesDoUpdate = antes.atualizadoEm.getTime();
      await new Promise((resolve) => setTimeout(resolve, 5));

      const atualizada = await service.atualizarLoja(lojaValida());
      expect(atualizada.loja.nome).toBe("Loja Exemplo");
      expect(atualizada.loja.endereco.cidade).toBe("São Paulo");
      expect(atualizada.atualizadoEm.getTime()).toBeGreaterThan(antesDoUpdate);
    });

    it("aplica trim nos campos da loja", async () => {
      const atualizada = await service.atualizarLoja(lojaValida({ nome: "  Loja Com Espaços  " }));
      expect(atualizada.loja.nome).toBe("Loja Com Espaços");
    });

    it("uma segunda atualização substitui a anterior por inteiro", async () => {
      await service.atualizarLoja(lojaValida({ nome: "Primeira" }));
      const segunda = await service.atualizarLoja(lojaValida({ nome: "Segunda" }));
      expect(segunda.loja.nome).toBe("Segunda");

      const total = await connection.collection("configuracoes").countDocuments({});
      expect(total).toBe(1);
    });
  });

  describe("listas: adicionar/remover", () => {
    it("adiciona categoria, tamanho, cor e forma de pagamento", async () => {
      const chave = Date.now();
      const apos1 = await service.adicionarItem("categorias", `Vestidos-${chave}`);
      expect(apos1.categorias).toContain(`Vestidos-${chave}`);

      const apos2 = await service.adicionarItem("tamanhos", `M-${chave}`);
      expect(apos2.tamanhos).toContain(`M-${chave}`);

      const apos3 = await service.adicionarItem("cores", `Azul-${chave}`);
      expect(apos3.cores).toContain(`Azul-${chave}`);

      const apos4 = await service.adicionarItem("formasPagamento", `PIX-${chave}`);
      expect(apos4.formasPagamento).toContain(`PIX-${chave}`);
    });

    it("aplica trim no valor antes de adicionar", async () => {
      const chave = `Trim-${Date.now()}`;
      const resultado = await service.adicionarItem("categorias", `  ${chave}  `);
      expect(resultado.categorias).toContain(chave);
      expect(resultado.categorias).not.toContain(`  ${chave}  `);
    });

    it("rejeita valor vazio (só espaços) com VALIDATION_ERROR", async () => {
      await expect(service.adicionarItem("categorias", "   ")).rejects.toThrow(ApiException);
    });

    it("rejeita item duplicado com CONFLICT, nunca duplica na lista", async () => {
      const chave = `Duplicada-${Date.now()}`;
      await service.adicionarItem("cores", chave);
      await expect(service.adicionarItem("cores", chave)).rejects.toThrow(ApiException);

      const configuracao = await service.obter();
      expect(configuracao.cores.filter((item) => item === chave)).toHaveLength(1);
    });

    it("remove item existente", async () => {
      const chave = `Remover-${Date.now()}`;
      await service.adicionarItem("tamanhos", chave);
      const apos = await service.removerItem("tamanhos", chave);
      expect(apos.tamanhos).not.toContain(chave);
    });

    it("rejeita remoção de item inexistente com NOT_FOUND", async () => {
      await expect(service.removerItem("tamanhos", `Inexistente-${Date.now()}`)).rejects.toThrow(ApiException);
    });

    it("rejeita lista inválida tanto para adicionar quanto para remover", async () => {
      await expect(service.adicionarItem("promocoes", "valor")).rejects.toThrow(ApiException);
      await expect(service.removerItem("promocoes", "valor")).rejects.toThrow(ApiException);
    });

    it("listas ficam vazias novamente após remover o único item — contrato permite listas vazias", async () => {
      const chave = `Sozinho-${Date.now()}`;
      await service.adicionarItem("formasPagamento", chave);
      const apos = await service.removerItem("formasPagamento", chave);
      expect(apos.formasPagamento).not.toContain(chave);
    });
  });

  describe("concorrência", () => {
    it("N adições concorrentes de valores DIFERENTES: todas persistem, nenhuma perdida (nunca lost update)", async () => {
      const chave = Date.now();
      const valores = Array.from({ length: 10 }, (_, indice) => `Concorrente-${chave}-${indice}`);

      const resultados = await Promise.allSettled(valores.map((valor) => service.adicionarItem("categorias", valor)));
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

      const final = await service.obter();
      for (const valor of valores) {
        expect(final.categorias).toContain(valor);
      }
    });

    it("N adições concorrentes do MESMO valor: só uma persiste, as demais rejeitam por conflito", async () => {
      const chave = `Corrida-${Date.now()}`;
      const resultados = await Promise.allSettled(Array.from({ length: 5 }, () => service.adicionarItem("cores", chave)));

      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(4);

      const final = await service.obter();
      expect(final.cores.filter((item) => item === chave)).toHaveLength(1);
    });
  });
});
