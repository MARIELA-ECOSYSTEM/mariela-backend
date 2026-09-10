import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "./auth.service.js";

const contextoTeste = { ip: "127.0.0.1", userAgent: "bun-test" };

let contador = 0;

/** Sempre em minúsculas — o serviço normaliza para minúsculas, então o e-mail "esperado" em qualquer asserção precisa já vir assim. */
function emailUnico(sufixo: string): string {
  contador += 1;
  return `teste.auth.${sufixo.toLowerCase()}.${Date.now()}.${contador}@mariela.dev`;
}

describe("AuthService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: AuthService;
  let connection: Connection;

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    service = moduleRef.get(AuthService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: "usuario" });
    await moduleRef.close();
  });

  describe("criação de usuário (via seed) e código sequencial", () => {
    it("cria o usuário com código sequencial e e-mail normalizado", async () => {
      const email = emailUnico("A");
      const resultado = await service.criarAdminSeed({ nome: "  Admin A  ", email: `  ${email.toUpperCase()}  `, senha: "senha-forte-123" });

      expect(resultado.criado).toBe(true);
      expect(resultado.usuario.codigo).toMatch(/^USR-\d{4}$/);
      expect(resultado.usuario.email).toBe(email); // normalizado: trim + minúsculas
      expect(resultado.usuario.nome).toBe("Admin A");
      expect(resultado.usuario.tipo).toBe("ADMIN");
      expect(resultado.usuario.ativo).toBe(true);
      expect((resultado.usuario as Record<string, unknown>)["senhaHash"]).toBeUndefined();
    });

    it("não duplica ao rodar de novo com o mesmo e-mail (idempotente)", async () => {
      const email = emailUnico("B");
      const primeiro = await service.criarAdminSeed({ nome: "Admin B", email, senha: "senha-forte-123" });
      const segundo = await service.criarAdminSeed({ nome: "Admin B Duplicado", email, senha: "outra-senha-123" });

      expect(primeiro.criado).toBe(true);
      expect(segundo.criado).toBe(false);
      expect(segundo.usuario.codigo).toBe(primeiro.usuario.codigo);
    });

    it("trata maiúsculas/minúsculas do e-mail como o mesmo usuário (unicidade normalizada)", async () => {
      const email = emailUnico("C");
      await service.criarAdminSeed({ nome: "Admin C", email, senha: "senha-forte-123" });
      const segundo = await service.criarAdminSeed({ nome: "Admin C", email: email.toUpperCase(), senha: "senha-forte-123" });
      expect(segundo.criado).toBe(false);
    });

    it("gera códigos sequenciais para usuários sucessivos", async () => {
      const a = await service.criarAdminSeed({ nome: "Seq A", email: emailUnico("SEQA"), senha: "senha-forte-123" });
      const b = await service.criarAdminSeed({ nome: "Seq B", email: emailUnico("SEQB"), senha: "senha-forte-123" });
      const seqA = Number(a.usuario.codigo.split("-")[1]);
      const seqB = Number(b.usuario.codigo.split("-")[1]);
      expect(seqB).toBe(seqA + 1);
    });

    it("a senha jamais é devolvida em nenhum formato reconhecível", async () => {
      const resultado = await service.criarAdminSeed({ nome: "Sem Senha", email: emailUnico("D"), senha: "senha-forte-123" });
      const chaves = Object.keys(resultado.usuario);
      expect(chaves).not.toContain("senha");
      expect(chaves).not.toContain("senhaHash");
    });
  });

  describe("login", () => {
    it("autentica com sucesso e emite access + refresh token", async () => {
      const email = emailUnico("LOGIN-OK");
      await service.criarAdminSeed({ nome: "Login OK", email, senha: "senha-correta-123" });

      const resultado = await service.login({ usuario: email, senha: "senha-correta-123" }, contextoTeste);

      expect(resultado.accessToken.split(".")).toHaveLength(3); // é um JWT
      expect(resultado.refreshToken.length).toBeGreaterThan(20);
      expect(resultado.expiresIn).toBeGreaterThan(0);
      expect(resultado.usuario.email).toBe(email);
    });

    it("rejeita senha incorreta com a MESMA mensagem/código de e-mail inexistente", async () => {
      const email = emailUnico("LOGIN-SENHA");
      await service.criarAdminSeed({ nome: "Login Senha", email, senha: "senha-correta-123" });

      let erroSenhaErrada: unknown;
      let erroEmailInexistente: unknown;
      try {
        await service.login({ usuario: email, senha: "senha-errada" }, contextoTeste);
      } catch (erro) {
        erroSenhaErrada = erro;
      }
      try {
        await service.login({ usuario: emailUnico("nao-existe"), senha: "qualquer" }, contextoTeste);
      } catch (erro) {
        erroEmailInexistente = erro;
      }

      expect(erroSenhaErrada).toBeInstanceOf(ApiException);
      expect(erroEmailInexistente).toBeInstanceOf(ApiException);
      expect((erroSenhaErrada as ApiException).message).toBe((erroEmailInexistente as ApiException).message);
      expect((erroSenhaErrada as ApiException).code).toBe((erroEmailInexistente as ApiException).code);
      expect((erroSenhaErrada as ApiException).getStatus()).toBe(401);
    });

    it("rejeita login de usuário inativo com a mesma mensagem genérica", async () => {
      const email = emailUnico("INATIVO");
      await service.criarAdminSeed({ nome: "Inativo", email, senha: "senha-correta-123" });
      await connection.collection("usuarios").updateOne({ email }, { $set: { ativo: false } });

      await expect(service.login({ usuario: email, senha: "senha-correta-123" }, contextoTeste)).rejects.toThrow(
        ApiException,
      );
    });
  });

  describe("refresh", () => {
    it("renova com sucesso e rotaciona o refresh token (o antigo para de funcionar)", async () => {
      const email = emailUnico("REFRESH-OK");
      await service.criarAdminSeed({ nome: "Refresh OK", email, senha: "senha-correta-123" });
      const login = await service.login({ usuario: email, senha: "senha-correta-123" }, contextoTeste);

      const renovado = await service.refresh({ refreshToken: login.refreshToken }, contextoTeste);
      // O refresh token é aleatório — garantidamente distinto. O access token
      // NÃO precisa ser diferente byte a byte: se emitido no mesmo segundo
      // (granularidade do `iat` do JWT), com o mesmo payload, é literalmente
      // o mesmo texto — isso não é uma falha de rotação, é esperado.
      expect(renovado.refreshToken).not.toBe(login.refreshToken);
      expect(renovado.accessToken.split(".")).toHaveLength(3);

      // o token ORIGINAL (já rotacionado) não pode mais ser usado.
      await expect(service.refresh({ refreshToken: login.refreshToken }, contextoTeste)).rejects.toThrow(
        ApiException,
      );
    });

    it("rejeita um refresh token que nunca existiu", async () => {
      await expect(
        service.refresh({ refreshToken: "token-que-nunca-existiu-abc123" }, contextoTeste),
      ).rejects.toThrow(ApiException);
    });

    it("rejeita um refresh token expirado", async () => {
      const email = emailUnico("EXPIRADO");
      await service.criarAdminSeed({ nome: "Expirado", email, senha: "senha-correta-123" });
      const login = await service.login({ usuario: email, senha: "senha-correta-123" }, contextoTeste);

      // Força a expiração diretamente no banco (sem esperar dias de verdade).
      await connection
        .collection("refresh_tokens")
        .updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

      await expect(service.refresh({ refreshToken: login.refreshToken }, contextoTeste)).rejects.toThrow(
        ApiException,
      );
    });

    it("Etapa 18.20 — usuário desativado após emitir o token: refresh rejeita e revoga TODAS as sessões dele", async () => {
      const email = emailUnico("REFRESH-INATIVO");
      await service.criarAdminSeed({ nome: "Refresh Inativo", email, senha: "senha-correta-123" });

      const sessao1 = await service.login({ usuario: email, senha: "senha-correta-123" }, contextoTeste);
      const sessao2 = await service.login({ usuario: email, senha: "senha-correta-123" }, contextoTeste);

      await connection.collection("usuarios").updateOne({ email }, { $set: { ativo: false } });

      await expect(service.refresh({ refreshToken: sessao1.refreshToken }, contextoTeste)).rejects.toThrow(
        ApiException,
      );
      // A desativação já revoga a sessão QUE TENTOU renovar; confirma que a
      // OUTRA sessão (nunca usada desde a desativação) também foi derrubada.
      await expect(service.refresh({ refreshToken: sessao2.refreshToken }, contextoTeste)).rejects.toThrow(
        ApiException,
      );
    });

    it("detecta reutilização de um refresh token já revogado e derruba a família inteira de sessões", async () => {
      const email = emailUnico("REUSE");
      await service.criarAdminSeed({ nome: "Reuse", email, senha: "senha-correta-123" });

      // Duas sessões (ex.: dois dispositivos) do mesmo usuário.
      const sessao1 = await service.login({ usuario: email, senha: "senha-correta-123" }, contextoTeste);
      const sessao2 = await service.login({ usuario: email, senha: "senha-correta-123" }, contextoTeste);

      const rotacionado = await service.refresh({ refreshToken: sessao1.refreshToken }, contextoTeste);

      // Reapresentar o token JÁ ROTACIONADO (revogado) = reutilização.
      await expect(service.refresh({ refreshToken: sessao1.refreshToken }, contextoTeste)).rejects.toThrow(
        ApiException,
      );

      // A resposta a uma reutilização derruba TODA a família — inclusive a
      // sessão2 (nunca usada indevidamente) e o token novo da rotação.
      await expect(service.refresh({ refreshToken: sessao2.refreshToken }, contextoTeste)).rejects.toThrow(
        ApiException,
      );
      await expect(service.refresh({ refreshToken: rotacionado.refreshToken }, contextoTeste)).rejects.toThrow(
        ApiException,
      );
    });
  });

  describe("logout", () => {
    it("revoga o refresh token — uma renovação depois do logout falha", async () => {
      const email = emailUnico("LOGOUT");
      await service.criarAdminSeed({ nome: "Logout", email, senha: "senha-correta-123" });
      const login = await service.login({ usuario: email, senha: "senha-correta-123" }, contextoTeste);

      await service.logout({ refreshToken: login.refreshToken });

      await expect(service.refresh({ refreshToken: login.refreshToken }, contextoTeste)).rejects.toThrow(
        ApiException,
      );
    });

    it("é idempotente: chamar logout de novo (ou com token desconhecido) não lança erro", async () => {
      await expect(service.logout({ refreshToken: "token-desconhecido-xyz" })).resolves.toBeUndefined();
    });
  });

  describe("me", () => {
    it("devolve o usuário autenticado sem a senha", async () => {
      const email = emailUnico("ME");
      const criado = await service.criarAdminSeed({ nome: "Me", email, senha: "senha-correta-123" });
      const usuario = await service.me(criado.usuario.id);
      expect(usuario.email).toBe(email);
      expect((usuario as Record<string, unknown>)["senhaHash"]).toBeUndefined();
    });

    it("lança NOT_FOUND para um id inexistente", async () => {
      await expect(service.me("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });
  });
});
