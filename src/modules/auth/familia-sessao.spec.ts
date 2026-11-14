import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection, type Model } from "mongoose";
import { AppModule } from "../../app.module.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { ERROR_CODES } from "../../common/constants/error-codes.constant.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "./auth.service.js";
import { RefreshToken, type RefreshTokenDocument } from "./schemas/refresh-token.schema.js";

/**
 * Fase 22.8.7.1 — FAMÍLIAS DE SESSÃO do refresh token administrativo (integração — MongoDB real, o mesmo replica set
 * da suíte). Toda asserção de estado lê DIRETAMENTE a coleção `refresh_tokens` (pelo HMAC do token, como o serviço),
 * nunca só o resultado da API. Concorrência real com `Promise.allSettled` em várias rodadas — sem sleeps.
 *
 * Política (decisão do projeto): reuso suspeito revoga SÓ a família; logout revoga a família inteira. Documentos
 * legados (sem `familiaId`) mantêm o comportamento anterior.
 */

const SENHA = "senha-correta-familia-123";
const contexto = { ip: "127.0.0.1", userAgent: "bun-test-familia" };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let contador = 0;
const emailUnico = (sufixo: string) => `teste.familia.${sufixo.toLowerCase()}.${Date.now()}.${++contador}@mariela.dev`;

describe("Família de sessão do refresh token (Fase 22.8.7.1 — integração, MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: AuthService;
  let connection: Connection;
  let segredo: string;
  const usuariosCriados: Types.ObjectId[] = [];

  const hash = (token: string) => createHmac("sha256", segredo).update(token).digest("hex");
  const tokens = () => connection.collection("refresh_tokens");
  const doc = (token: string) => tokens().findOne({ tokenHash: hash(token) });
  const ativo = async (token: string) => {
    const d = await doc(token);
    return d != null && d["revogadoEm"] == null;
  };
  const ativosDoUsuario = (usuarioId: Types.ObjectId) => tokens().countDocuments({ usuarioId, revogadoEm: null });
  const ativosDaFamilia = (familiaId: string) => tokens().countDocuments({ familiaId, revogadoEm: null });
  const eventos = (usuarioId: Types.ObjectId, tipo: string) =>
    connection.collection("eventos_auth").countDocuments({ usuarioId, tipo });

  async function novoAdmin(sufixo: string) {
    const email = emailUnico(sufixo);
    const { usuario } = await service.criarAdminSeed({ nome: `Familia ${sufixo}`, email, senha: SENHA });
    const id = new Types.ObjectId(usuario.id);
    usuariosCriados.push(id);
    return { email, id };
  }
  const login = (email: string) => service.login({ usuario: email, senha: SENHA }, contexto);
  const refresh = (token: string) => service.refresh({ refreshToken: token }, contexto);
  const familiaDe = async (token: string) => (await doc(token))?.["familiaId"] as string | undefined;

  async function codigoDoErro(promessa: Promise<unknown>): Promise<string> {
    try {
      await promessa;
      return "OK";
    } catch (erro) {
      expect(erro).toBeInstanceOf(ApiException);
      return (erro as ApiException).code;
    }
  }

  /** Grava um refresh token LEGADO (formato anterior à fase: SEM `familiaId`) e devolve o valor bruto. */
  async function tokenLegado(usuarioId: Types.ObjectId): Promise<string> {
    const bruto = randomBytes(32).toString("base64url");
    await tokens().insertOne({
      usuarioId,
      tokenHash: hash(bruto),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revogadoEm: null,
      rotacionadoEm: null,
      substituidoPor: null,
      userAgent: null,
      ip: null,
      criadoEm: new Date(),
    });
    return bruto;
  }

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    service = moduleRef.get(AuthService);
    connection = moduleRef.get(getConnectionToken());
    segredo = moduleRef.get(ConfigService).get<string>("jwt.refreshSecret")!;
    // Aguarda os índices do model (o mesmo `init()` que o Mongoose dispara sozinho no boot com `autoIndex`).
    await moduleRef.get<Model<RefreshTokenDocument>>(getModelToken(RefreshToken.name)).init();
  });

  afterAll(async () => {
    await tokens().deleteMany({ usuarioId: { $in: usuariosCriados } });
    await connection.collection("eventos_auth").deleteMany({ usuarioId: { $in: usuariosCriados } });
    await connection.collection("usuarios").deleteMany({ _id: { $in: usuariosCriados } });
    await moduleRef.close();
  });

  describe("9.1 login e família", () => {
    it("login cria o documento com familiaId aleatório (UUID v4) e nenhum token em texto puro", async () => {
      const { email } = await novoAdmin("login");
      const sessao = await login(email);
      const d = await doc(sessao.refreshToken);
      expect(d).not.toBeNull();
      expect(d!["familiaId"]).toMatch(UUID_V4);
      expect(d!["tokenHash"]).toBe(hash(sessao.refreshToken));
      // Nenhum campo do documento contém o refresh token (nem o access token) em claro.
      const serializado = JSON.stringify(d);
      expect(serializado).not.toContain(sessao.refreshToken);
      expect(serializado).not.toContain(sessao.accessToken);
      // A família não é o id do usuário nem deriva do e-mail.
      expect(d!["familiaId"]).not.toBe(String(d!["usuarioId"]));
      expect(serializado.includes(email)).toBe(false);
    });

    it("novo login do mesmo usuário cria OUTRA família; usuários diferentes nunca compartilham família", async () => {
      const a = await novoAdmin("duas-sessoes");
      const b = await novoAdmin("outro-usuario");
      const a1 = await login(a.email);
      const a2 = await login(a.email);
      const b1 = await login(b.email);
      const familias = await Promise.all([a1, a2, b1].map((s) => familiaDe(s.refreshToken)));
      expect(new Set(familias).size).toBe(3);
      for (const f of familias) expect(f).toMatch(UUID_V4);
    });
  });

  describe("9.2 rotação", () => {
    it("R1 → R2 → R3 preservam a família; substituidoPor continua apontando o sucessor; R1 revogado e rotacionado", async () => {
      const { email } = await novoAdmin("rotacao");
      const R1 = (await login(email)).refreshToken;
      const R2 = (await refresh(R1)).refreshToken;
      const R3 = (await refresh(R2)).refreshToken;
      const [d1, d2, d3] = await Promise.all([doc(R1), doc(R2), doc(R3)]);
      expect(d2!["familiaId"]).toBe(d1!["familiaId"]);
      expect(d3!["familiaId"]).toBe(d1!["familiaId"]);
      expect(d1!["substituidoPor"]).toBe(hash(R2));
      expect(d2!["substituidoPor"]).toBe(hash(R3));
      expect(d1!["revogadoEm"]).not.toBeNull();
      expect(d1!["rotacionadoEm"]).not.toBeNull();
      expect(d3!["revogadoEm"]).toBeNull();
      expect(await ativosDaFamilia(d1!["familiaId"])).toBe(1);
    });

    it("duas sessões do mesmo usuário rotacionam de forma independente", async () => {
      const { email, id } = await novoAdmin("independentes");
      const A1 = (await login(email)).refreshToken;
      const B1 = (await login(email)).refreshToken;
      const A2 = (await refresh(A1)).refreshToken;
      const B2 = (await refresh(B1)).refreshToken;
      expect(await familiaDe(A2)).toBe(await familiaDe(A1));
      expect(await familiaDe(B2)).toBe(await familiaDe(B1));
      expect(await familiaDe(A2)).not.toBe(await familiaDe(B2));
      expect(await ativosDoUsuario(id)).toBe(2);
    });
  });

  describe("9.3 reutilização suspeita", () => {
    it("reuso de R1 revoga a família inteira (R2) — a outra família do usuário e a de outro usuário continuam ativas", async () => {
      const u = await novoAdmin("reuso");
      const outro = await novoAdmin("reuso-outro");
      const A1 = (await login(u.email)).refreshToken;
      const B1 = (await login(u.email)).refreshToken;
      const X1 = (await login(outro.email)).refreshToken;
      const A2 = (await refresh(A1)).refreshToken;

      expect(await codigoDoErro(refresh(A1))).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);

      expect(await ativo(A2)).toBe(false);
      expect(await ativosDaFamilia((await familiaDe(A1))!)).toBe(0);
      expect(await ativo(B1)).toBe(true);
      expect(await ativo(X1)).toBe(true);
      expect(await eventos(u.id, "REFRESH_REUSED")).toBe(1);
      // A outra sessão continua de fato utilizável.
      expect(await codigoDoErro(refresh(B1))).toBe("OK");
    });

    it("token desconhecido e token expirado: REFRESH_TOKEN_INVALID, nenhuma família revogada", async () => {
      const u = await novoAdmin("desconhecido");
      const A1 = (await login(u.email)).refreshToken;
      const B1 = (await login(u.email)).refreshToken;
      expect(await codigoDoErro(refresh(randomBytes(32).toString("base64url")))).toBe(ERROR_CODES.REFRESH_TOKEN_INVALID);
      await tokens().updateOne({ tokenHash: hash(A1) }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });
      expect(await codigoDoErro(refresh(A1))).toBe(ERROR_CODES.REFRESH_TOKEN_INVALID);
      // Expirado, mas NÃO revogado por esta tentativa. O monitor TTL do MongoDB (a cada 60 s) pode já ter removido o
      // documento expirado — ausente também prova que nada foi revogado; o que não pode é `revogadoEm` preenchido.
      const dA1 = await doc(A1);
      expect(dA1 == null || dA1["revogadoEm"] == null).toBe(true);
      expect(await ativo(B1)).toBe(true);
      expect(await eventos(u.id, "REFRESH_REUSED")).toBe(0);
    });

    it("LEGADO sem família: reuso mantém a regra anterior — revoga TODAS as sessões do usuário (nunca de outro)", async () => {
      const u = await novoAdmin("legado-reuso");
      const outro = await novoAdmin("legado-reuso-outro");
      const L1 = await tokenLegado(u.id);
      const comFamilia = (await login(u.email)).refreshToken;
      const X1 = (await login(outro.email)).refreshToken;

      const L2 = (await refresh(L1)).refreshToken;
      // O legado NÃO ganhou família; o sucessor inicia uma família nova (a migração de sessões em uso).
      expect((await doc(L1))!["familiaId"]).toBeUndefined();
      expect(await familiaDe(L2)).toMatch(UUID_V4);
      expect(await familiaDe(L2)).not.toBe(await familiaDe(comFamilia));

      expect(await codigoDoErro(refresh(L1))).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
      expect(await ativosDoUsuario(u.id)).toBe(0); // L2 e a sessão com família também caem (regra legada)
      expect(await ativo(X1)).toBe(true);
    });

    it("sessão migrada (sucessor de legado): o reuso do SUCESSOR já revoga só a família nova", async () => {
      const u = await novoAdmin("migrada");
      const L1 = await tokenLegado(u.id);
      const outraSessao = (await login(u.email)).refreshToken;
      const L2 = (await refresh(L1)).refreshToken;
      const L3 = (await refresh(L2)).refreshToken;
      expect(await codigoDoErro(refresh(L2))).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
      expect(await ativo(L3)).toBe(false);
      expect(await ativo(outraSessao)).toBe(true);
    });
  });

  describe("9.4 logout", () => {
    it("logout com R1 ativo revoga a família; repetido é idempotente (200 lógico, um único evento LOGOUT)", async () => {
      const u = await novoAdmin("logout-r1");
      const A1 = (await login(u.email)).refreshToken;
      const B1 = (await login(u.email)).refreshToken;
      await service.logout({ refreshToken: A1 });
      expect(await ativo(A1)).toBe(false);
      expect(await ativo(B1)).toBe(true);
      await expect(service.logout({ refreshToken: A1 })).resolves.toBeUndefined();
      await expect(service.logout({ refreshToken: A1 })).resolves.toBeUndefined();
      expect(await eventos(u.id, "LOGOUT")).toBe(1);
      expect(await eventos(u.id, "REFRESH_REUSED")).toBe(0);
    });

    it("logout com R2 ativo revoga a MESMA família (R1 rotacionado já estava revogado)", async () => {
      const u = await novoAdmin("logout-r2");
      const A1 = (await login(u.email)).refreshToken;
      const A2 = (await refresh(A1)).refreshToken;
      const B1 = (await login(u.email)).refreshToken;
      await service.logout({ refreshToken: A2 });
      expect(await ativosDaFamilia((await familiaDe(A1))!)).toBe(0);
      expect(await ativo(B1)).toBe(true);
    });

    it("logout com R1 JÁ ROTACIONADO revoga a família — inclusive o sucessor R2 (resposta perdida) — sem disparar reuso", async () => {
      const u = await novoAdmin("logout-rotacionado");
      const A1 = (await login(u.email)).refreshToken;
      const A2 = (await refresh(A1)).refreshToken; // o cliente "não recebeu" A2
      const B1 = (await login(u.email)).refreshToken;
      await service.logout({ refreshToken: A1 });
      expect(await ativo(A2)).toBe(false);
      expect(await ativo(B1)).toBe(true);
      expect(await eventos(u.id, "REFRESH_REUSED")).toBe(0);
      expect(await eventos(u.id, "LOGOUT")).toBe(1);
    });

    it("token desconhecido: nada é revogado, de ninguém", async () => {
      const u = await novoAdmin("logout-desconhecido");
      const A1 = (await login(u.email)).refreshToken;
      const ativosAntes = await tokens().countDocuments({ revogadoEm: null });
      await expect(service.logout({ refreshToken: randomBytes(32).toString("base64url") })).resolves.toBeUndefined();
      expect(await tokens().countDocuments({ revogadoEm: null })).toBe(ativosAntes);
      expect(await ativo(A1)).toBe(true);
    });

    it("LEGADO sem família: logout mantém o comportamento anterior — revoga só aquele documento", async () => {
      const u = await novoAdmin("logout-legado");
      const L1 = await tokenLegado(u.id);
      const L2legadoIrmao = await tokenLegado(u.id);
      const comFamilia = (await login(u.email)).refreshToken;
      await service.logout({ refreshToken: L1 });
      expect(await ativo(L1)).toBe(false);
      expect(await ativo(L2legadoIrmao)).toBe(true);
      expect(await ativo(comFamilia)).toBe(true);
      expect((await doc(L1))!["familiaId"]).toBeUndefined();
    });
  });

  describe("9.5 concorrência e atomicidade (rodadas reais, sem sleeps)", () => {
    const RODADAS = 15;

    it("reuso simultâneo do mesmo R1: uma rotação vence, a família inteira cai, a outra família do usuário fica ativa", async () => {
      for (let rodada = 0; rodada < RODADAS; rodada += 1) {
        const u = await novoAdmin(`conc-reuso-${rodada}`);
        const A1 = (await login(u.email)).refreshToken;
        const B1 = (await login(u.email)).refreshToken;
        const resultados = await Promise.allSettled([refresh(A1), refresh(A1), refresh(A1)]);
        expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(await ativosDaFamilia((await familiaDe(A1))!)).toBe(0);
        // Nem o sucessor da vencedora escapa — nem para outra família: do usuário, só B1 continua ativo.
        expect(await ativo(B1)).toBe(true);
        expect(await ativosDoUsuario(u.id)).toBe(1);
      }
    }, 120_000);

    it("logout concorrente com refresh: a família termina SEMPRE sem token ativo; nada fora dela é tocado", async () => {
      for (let rodada = 0; rodada < RODADAS; rodada += 1) {
        const u = await novoAdmin(`conc-logout-refresh-${rodada}`);
        const outro = await novoAdmin(`conc-logout-refresh-outro-${rodada}`);
        const A1 = (await login(u.email)).refreshToken;
        const B1 = (await login(u.email)).refreshToken;
        const X1 = (await login(outro.email)).refreshToken;
        await Promise.allSettled([refresh(A1), service.logout({ refreshToken: A1 })]);
        expect(await ativosDaFamilia((await familiaDe(A1))!)).toBe(0);
        // Nenhum sucessor sobrevive ao logout em lugar nenhum: do usuário, só B1 continua ativo.
        expect(await ativo(B1)).toBe(true);
        expect(await ativosDoUsuario(u.id)).toBe(1);
        expect(await ativo(X1)).toBe(true);
      }
    }, 120_000);

    it("duas tentativas de logout simultâneas: família revogada, um único evento LOGOUT", async () => {
      for (let rodada = 0; rodada < RODADAS; rodada += 1) {
        const u = await novoAdmin(`conc-logout-${rodada}`);
        const A1 = (await login(u.email)).refreshToken;
        const B1 = (await login(u.email)).refreshToken;
        await Promise.all([service.logout({ refreshToken: A1 }), service.logout({ refreshToken: A1 })]);
        expect(await ativo(A1)).toBe(false);
        expect(await ativo(B1)).toBe(true);
        expect(await eventos(u.id, "LOGOUT")).toBe(1);
      }
    }, 120_000);

    it("revogações simultâneas de famílias diferentes (reuso em A, logout em B) não se cruzam; C intacta", async () => {
      for (let rodada = 0; rodada < RODADAS; rodada += 1) {
        const u = await novoAdmin(`conc-familias-${rodada}`);
        const A1 = (await login(u.email)).refreshToken;
        const B1 = (await login(u.email)).refreshToken;
        const C1 = (await login(u.email)).refreshToken;
        const A2 = (await refresh(A1)).refreshToken;
        await Promise.allSettled([refresh(A1), service.logout({ refreshToken: B1 }), refresh(C1)]);
        expect(await ativo(A2)).toBe(false);
        expect(await ativo(B1)).toBe(false);
        expect(await ativosDaFamilia((await familiaDe(C1))!)).toBe(1); // C rotacionou e segue com 1 token ativo
      }
    }, 120_000);

    it("duas sessões do mesmo usuário renovando ao mesmo tempo: ambas sucedem, cada uma na sua família", async () => {
      for (let rodada = 0; rodada < RODADAS; rodada += 1) {
        const u = await novoAdmin(`conc-sessoes-${rodada}`);
        const A1 = (await login(u.email)).refreshToken;
        const B1 = (await login(u.email)).refreshToken;
        const [a, b] = await Promise.all([refresh(A1), refresh(B1)]);
        expect(await familiaDe(a.refreshToken)).toBe(await familiaDe(A1));
        expect(await familiaDe(b.refreshToken)).toBe(await familiaDe(B1));
        expect(await ativosDoUsuario(u.id)).toBe(2);
      }
    }, 120_000);
  });

  describe("índice e eventos", () => {
    it("o índice { familiaId, revogadoEm } existe, é PARCIAL (só documentos com família) e o TTL de expiresAt continua", async () => {
      const indices = await tokens().indexes();
      const familia = indices.find((i) => JSON.stringify(i.key) === JSON.stringify({ familiaId: 1, revogadoEm: 1 }));
      expect(familia).toBeDefined();
      expect(familia!.partialFilterExpression).toEqual({ familiaId: { $exists: true } });
      const ttl = indices.find((i) => JSON.stringify(i.key) === JSON.stringify({ expiresAt: 1 }));
      expect(ttl?.expireAfterSeconds).toBe(0);
      expect(indices.find((i) => JSON.stringify(i.key) === JSON.stringify({ tokenHash: 1 }))?.unique).toBe(true);
    });

    it("eventos de segurança não contêm tokens, hashes nem a família", async () => {
      const u = await novoAdmin("eventos");
      const s = await login(u.email);
      const R2 = (await refresh(s.refreshToken)).refreshToken;
      await codigoDoErro(refresh(s.refreshToken)); // REFRESH_REUSED
      await service.logout({ refreshToken: R2 });
      const lista = await connection.collection("eventos_auth").find({ usuarioId: u.id }).toArray();
      expect(lista.map((e) => e["tipo"])).toEqual(["LOGIN_SUCCESS", "REFRESH", "REFRESH_REUSED"]);
      const serializado = JSON.stringify(lista);
      for (const segredoProibido of [s.refreshToken, s.accessToken, R2, hash(s.refreshToken), hash(R2), (await familiaDe(R2))!]) {
        expect(serializado).not.toContain(segredoProibido);
      }
    });
  });
});
