import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection } from "mongoose";
import configuration from "../../config/configuration.js";
import { validateEnv } from "../../config/env.validation.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import type { CriarVendedorDto } from "../vendedores/dto/criar-vendedor.dto.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import { PdvAuthModule } from "./pdv-auth.module.js";
import { PdvAuthRepository } from "./pdv-auth.repository.js";
import { PdvAuthService } from "./pdv-auth.service.js";

let contador = 0;
function sufixo(): string {
  contador += 1;
  return String(contador);
}

// `VendedoresController` (importado transitivamente via `VendedoresModule`)
// usa `JwtAuthGuard` do ADMIN via `@UseGuards`, que precisa de um `JwtService`
// GLOBAL para resolver — nada a ver com a autenticação do PDV em si (que usa
// o `JwtModule` próprio registrado dentro de `PdvAuthModule`). Mesmo padrão
// de `vendas.service.spec.ts`.
const JWT_ADMIN_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-admin-de-teste",
  signOptions: { expiresIn: "15m" },
});

describe("PdvAuthService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: PdvAuthService;
  let vendedoresService: VendedoresService;
  let pdvAuthRepository: PdvAuthRepository;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseModuloDeTeste(),
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
        JWT_ADMIN_MODULO_DE_TESTE,
        PdvAuthModule,
      ],
    }).compile();
    service = moduleRef.get(PdvAuthService);
    vendedoresService = moduleRef.get(VendedoresService);
    pdvAuthRepository = moduleRef.get(PdvAuthRepository);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["vendedor"] } });
    await moduleRef.close();
  });

  const CONTEXTO = { ip: "127.0.0.1", userAgent: "bun:test" };

  async function criarVendedor(overrides: Partial<CriarVendedorDto> = {}) {
    const s = sufixo();
    const dto: CriarVendedorDto = {
      nome: `Vendedor PDV ${s}`,
      telefone: `1196${String(contador).padStart(6, "0")}`,
      ativo: true,
      senha: "senha123",
      ...overrides,
    };
    return vendedoresService.criar(dto, null);
  }

  describe("login", () => {
    it("vendedor válido: devolve accessToken, refreshToken, expiresIn e a identidade pública do vendedor", async () => {
      const vendedor = await criarVendedor();
      const resultado = await service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO);

      expect(resultado.accessToken).toBeTruthy();
      expect(resultado.refreshToken).toBeTruthy();
      expect(resultado.expiresIn).toBeGreaterThan(0);
      expect(resultado.vendedor).toEqual({
        id: vendedor.id,
        codigo: vendedor.codigo,
        nome: vendedor.nome,
        foto: null,
        ativo: true,
      });
    });

    it("nunca inclui senhaHash na resposta do login", async () => {
      const vendedor = await criarVendedor();
      const resultado = await service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO);
      expect(Object.keys(resultado.vendedor)).toEqual(["id", "codigo", "nome", "foto", "ativo"]);
      expect(JSON.stringify(resultado)).not.toContain("senhaHash");
    });

    it("código inexistente rejeita com credenciais inválidas", async () => {
      await expect(service.login({ codigo: "VEN-9999", senha: "qualquer" }, CONTEXTO)).rejects.toThrow(ApiException);
    });

    it("senha incorreta rejeita com credenciais inválidas", async () => {
      const vendedor = await criarVendedor();
      await expect(service.login({ codigo: vendedor.codigo, senha: "senha-errada" }, CONTEXTO)).rejects.toThrow(ApiException);
    });

    it("vendedor inativo é rejeitado", async () => {
      const vendedor = await criarVendedor({ ativo: false });
      await expect(service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO)).rejects.toThrow(ApiException);
    });

    it("vendedor excluído é rejeitado", async () => {
      const vendedor = await criarVendedor();
      await vendedoresService.excluir(vendedor.id, null);
      await expect(service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO)).rejects.toThrow(ApiException);
    });

    it("código é normalizado (minúsculo/espaços) na hora do login", async () => {
      const vendedor = await criarVendedor();
      const resultado = await service.login({ codigo: `  ${vendedor.codigo.toLowerCase()}  `, senha: "senha123" }, CONTEXTO);
      expect(resultado.vendedor.id).toBe(vendedor.id);
    });
  });

  describe("refresh + rotation", () => {
    it("refresh válido: revoga o token antigo e emite um par novo", async () => {
      const vendedor = await criarVendedor();
      const login = await service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO);

      const renovado = await service.refresh({ refreshToken: login.refreshToken }, CONTEXTO);
      expect(renovado.accessToken).toBeTruthy();
      expect(renovado.refreshToken).not.toBe(login.refreshToken);
      expect(renovado.vendedor.id).toBe(vendedor.id);

      // O token antigo, já rotacionado, não pode ser usado de novo.
      await expect(service.refresh({ refreshToken: login.refreshToken }, CONTEXTO)).rejects.toThrow(ApiException);
    });

    it("refresh token inexistente é rejeitado", async () => {
      await expect(service.refresh({ refreshToken: "token-que-nunca-existiu" }, CONTEXTO)).rejects.toThrow(ApiException);
    });

    it("refresh token expirado é rejeitado", async () => {
      const vendedor = await criarVendedor();
      const login = await service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO);

      // Simula expiração real: recua `expiresAt` para o passado diretamente no banco.
      await connection.collection("vendedor_refresh_tokens").updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

      await expect(service.refresh({ refreshToken: login.refreshToken }, CONTEXTO)).rejects.toThrow(ApiException);
    });

    it("reutilização de um refresh token já revogado (rotation) é detectada e revoga toda a família", async () => {
      const vendedor = await criarVendedor();
      const login = await service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO);
      const renovado = await service.refresh({ refreshToken: login.refreshToken }, CONTEXTO);

      // Reapresenta o token JÁ ROTACIONADO (reuso) — deve derrubar até o token novo.
      await expect(service.refresh({ refreshToken: login.refreshToken }, CONTEXTO)).rejects.toThrow(ApiException);
      await expect(service.refresh({ refreshToken: renovado.refreshToken }, CONTEXTO)).rejects.toThrow(ApiException);
    });

    it("Etapa 18.22 — duas requisições CONCORRENTES com o MESMO refresh token: só uma rotaciona, a outra é rejeitada (CAS real, nunca duas sessões válidas)", async () => {
      const vendedor = await criarVendedor();
      const login = await service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO);

      const resultados = await Promise.allSettled([
        service.refresh({ refreshToken: login.refreshToken }, CONTEXTO),
        service.refresh({ refreshToken: login.refreshToken }, CONTEXTO),
      ]);

      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      const falhas = resultados.filter((r) => r.status === "rejected");
      expect(sucesso).toHaveLength(1);
      expect(falhas).toHaveLength(1);

      // A corrida perdida é reconhecida como "reutilização" (o token já foi
      // revogado pela vencedora) — mata a família, inclusive o token novo da
      // rotação vencedora, mesmo comportamento já provado para reuso sequencial.
      const vencedora = (sucesso[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof service.refresh>>>).value;
      await expect(service.refresh({ refreshToken: vencedora.refreshToken }, CONTEXTO)).rejects.toThrow(ApiException);

      const totalSessoesAtivas = await connection
        .collection("vendedor_refresh_tokens")
        .countDocuments({ vendedorId: new Types.ObjectId(vendedor.id), revogadoEm: null });
      expect(totalSessoesAtivas).toBe(0);
    });

    it("vendedor desativado depois do login: o próximo refresh é rejeitado e a família inteira é revogada", async () => {
      const vendedor = await criarVendedor();
      const login = await service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO);

      await vendedoresService.alterarStatus(vendedor.id, { ativo: false }, null);

      await expect(service.refresh({ refreshToken: login.refreshToken }, CONTEXTO)).rejects.toThrow(ApiException);
    });
  });

  describe("logout", () => {
    it("revoga a sessão: o refresh token deixa de funcionar depois do logout", async () => {
      const vendedor = await criarVendedor();
      const login = await service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO);

      await service.logout({ refreshToken: login.refreshToken });

      const registro = await pdvAuthRepository.encontrarPorHash(await hashParaTeste(login.refreshToken));
      expect(registro?.revogadoEm).not.toBeNull();
      await expect(service.refresh({ refreshToken: login.refreshToken }, CONTEXTO)).rejects.toThrow(ApiException);
    });

    it("logout de uma sessão inexistente é idempotente (não lança erro)", async () => {
      await expect(service.logout({ refreshToken: "nunca-existiu" })).resolves.toBeUndefined();
    });
  });

  describe("segurança: nenhum log/evento grava segredo", () => {
    it("eventos de autenticação nunca contêm senha, hash ou tokens", async () => {
      const vendedor = await criarVendedor();
      const login = await service.login({ codigo: vendedor.codigo, senha: "senha123" }, CONTEXTO);
      await service.refresh({ refreshToken: login.refreshToken }, CONTEXTO);

      const eventos = await connection.collection("eventos_pdv_auth").find({}).toArray();
      const bruto = JSON.stringify(eventos);
      expect(bruto).not.toContain("senha123");
      expect(bruto).not.toContain(login.accessToken);
      expect(bruto).not.toContain(login.refreshToken);
      expect(bruto.toLowerCase()).not.toContain("senhahash");
    });
  });
});

/** Recalcula o hash exatamente como `PdvAuthService` faz, só para inspecionar o documento persistido no teste. */
async function hashParaTeste(tokenBruto: string): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const segredo = process.env["PDV_JWT_REFRESH_SECRET"]!;
  return createHmac("sha256", segredo).update(tokenBruto).digest("hex");
}
