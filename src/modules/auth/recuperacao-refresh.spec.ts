import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { ERROR_CODES } from "../../common/constants/error-codes.constant.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { JANELA_RECUPERACAO_REFRESH_MS, LIMITE_RECUPERACOES_REFRESH } from "./auth.constants.js";
import { AuthService } from "./auth.service.js";
import { hashDaChave } from "./recuperacao-refresh.crypto.js";
import { RefreshTokensRepository } from "./refresh-tokens.repository.js";

/**
 * Fase 22.8.7.2 — RECUPERAÇÃO IDEMPOTENTE da rotação do refresh token (integração — MongoDB real, replica set da
 * suíte). Toda asserção de estado lê a coleção `refresh_tokens` diretamente. Concorrência real com
 * `Promise.allSettled`; o único entrelaçamento forçado (candidato × decisão atômica) é feito envolvendo o repositório,
 * sem sleeps. Segredos, tokens e chaves são gerados só para o teste.
 */

const SENHA = "senha-correta-recuperacao-123";
const contexto = { ip: "127.0.0.1", userAgent: "bun-test-recuperacao" };
const SEGREDO_RECUPERACAO = `segredo-recuperacao-teste-${randomBytes(24).toString("base64url")}`;
let contador = 0;
const emailUnico = (sufixo: string) => `teste.recuperacao.${sufixo.toLowerCase()}.${Date.now()}.${++contador}@mariela.dev`;

/** Monta o AppModule com (ou sem) o segredo da recuperação; restaura o ambiente anterior ao fechar. */
async function montarModulo(comSegredo: boolean) {
  const anterior = process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"];
  process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
  if (comSegredo) process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"] = SEGREDO_RECUPERACAO;
  else delete process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  const restaurar = async () => {
    if (anterior === undefined) delete process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"];
    else process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"] = anterior;
    await moduleRef.close();
  };
  return { moduleRef, restaurar };
}

describe("Recuperação idempotente da rotação (Fase 22.8.7.2 — integração, MongoDB real)", () => {
  let moduleRef: TestingModule;
  let restaurar: () => Promise<void>;
  let service: AuthService;
  let repositorio: RefreshTokensRepository;
  let connection: Connection;
  let segredoRefresh: string;
  const usuariosCriados: Types.ObjectId[] = [];

  const hash = (t: string) => createHmac("sha256", segredoRefresh).update(t).digest("hex");
  const tokens = () => connection.collection("refresh_tokens");
  const doc = (t: string) => tokens().findOne({ tokenHash: hash(t) });
  const ativo = async (t: string) => {
    const d = await doc(t);
    return d != null && d["revogadoEm"] == null;
  };
  const familiaDe = async (t: string) => (await doc(t))?.["familiaId"] as string;
  const ativosDaFamilia = (familiaId: string) => tokens().countDocuments({ familiaId, revogadoEm: null });
  const ativosDoUsuario = (id: Types.ObjectId) => tokens().countDocuments({ usuarioId: id, revogadoEm: null });
  const totalDoUsuario = (id: Types.ObjectId) => tokens().countDocuments({ usuarioId: id });
  const eventos = (id: Types.ObjectId, tipo: string) => connection.collection("eventos_auth").countDocuments({ usuarioId: id, tipo });

  async function novoAdmin(sufixo: string) {
    const email = emailUnico(sufixo);
    const { usuario } = await service.criarAdminSeed({ nome: `Recuperacao ${sufixo}`, email, senha: SENHA });
    const id = new Types.ObjectId(usuario.id);
    usuariosCriados.push(id);
    return { email, id };
  }
  const login = (email: string) => service.login({ usuario: email, senha: SENHA }, contexto);
  const refresh = (t: string, chave: string | null = null) => service.refresh({ refreshToken: t }, contexto, chave);
  async function codigo(promessa: Promise<unknown>): Promise<string> {
    try {
      await promessa;
      return "OK";
    } catch (erro) {
      expect(erro).toBeInstanceOf(ApiException);
      return (erro as ApiException).code;
    }
  }
  /** Sessão nova + rotação R1 → R2 com a chave K, cuja resposta "se perde" (o teste guarda R2 só para comparar). */
  async function rotacaoComRespostaPerdida(sufixo: string) {
    const u = await novoAdmin(sufixo);
    const R1 = (await login(u.email)).refreshToken;
    const K = randomUUID();
    const R2 = (await refresh(R1, K)).refreshToken;
    return { u, R1, K, R2, familia: await familiaDe(R1) };
  }

  beforeAll(async () => {
    ({ moduleRef, restaurar } = await montarModulo(true));
    service = moduleRef.get(AuthService);
    repositorio = moduleRef.get(RefreshTokensRepository, { strict: false });
    connection = moduleRef.get(getConnectionToken());
    segredoRefresh = moduleRef.get(ConfigService).get<string>("jwt.refreshSecret")!;
  });

  afterAll(async () => {
    await tokens().deleteMany({ usuarioId: { $in: usuariosCriados } });
    await connection.collection("eventos_auth").deleteMany({ usuarioId: { $in: usuariosCriados } });
    await connection.collection("usuarios").deleteMany({ _id: { $in: usuariosCriados } });
    await restaurar();
  });

  describe("11.2 rotação normal com Idempotency-Key", () => {
    it("R2 herda a família; R1 grava substituidoPor, chaveHash, selo, janela de 15 min e contador 0 — na mesma decisão", async () => {
      const u = await novoAdmin("rotacao");
      const R1 = (await login(u.email)).refreshToken;
      const K = randomUUID();
      const R2 = (await refresh(R1, K)).refreshToken;
      const d1 = (await doc(R1))!;
      const d2 = (await doc(R2))!;
      expect(d2["familiaId"]).toBe(d1["familiaId"]);
      expect(d1["substituidoPor"]).toBe(hash(R2));
      expect(d1["chaveHash"]).toBe(hashDaChave(SEGREDO_RECUPERACAO, K));
      expect(d1["recuperacoes"]).toBe(0);
      expect((d1["recuperavelAte"] as Date).getTime() - (d1["rotacionadoEm"] as Date).getTime()).toBe(JANELA_RECUPERACAO_REFRESH_MS);
      expect(d1["sucessorSelado"]).toMatchObject({ v: 1 });
      // Nada em claro: nem R1, nem R2, nem a chave em nenhum dos dois documentos.
      const serializado = JSON.stringify([d1, d2]);
      for (const segredo of [R1, R2, K]) expect(serializado).not.toContain(segredo);
      // R2 (o sucessor) não carrega material de recuperação próprio.
      expect(d2["chaveHash"]).toBeUndefined();
      expect(d2["sucessorSelado"]).toBeUndefined();
    });

    it("sem Idempotency-Key: rotação da Fase 22.8.7.1, sem material de recuperação", async () => {
      const u = await novoAdmin("sem-chave");
      const R1 = (await login(u.email)).refreshToken;
      const R2 = (await refresh(R1)).refreshToken;
      const d1 = (await doc(R1))!;
      expect(d1["substituidoPor"]).toBe(hash(R2));
      for (const campo of ["chaveHash", "sucessorSelado", "recuperavelAte", "recuperacoes"]) expect(d1[campo]).toBeUndefined();
    });

    it("R2 só é devolvido se a decisão atômica vencer: perdida a corrida, o candidato é revogado e não sai", async () => {
      const u = await novoAdmin("corrida-candidato");
      const R1 = (await login(u.email)).refreshToken;
      const outraSessao = (await login(u.email)).refreshToken;
      // Entrelaçamento forçado (sem sleep): entre a criação do candidato e a decisão atômica, OUTRA requisição
      // (sem chave) rotaciona R1.
      let rival: string | null = null;
      const original = repositorio.rotacionarSeValido.bind(repositorio);
      repositorio.rotacionarSeValido = async (...args) => {
        repositorio.rotacionarSeValido = original;
        rival = (await refresh(R1)).refreshToken;
        return original(...args);
      };
      const resultado = await codigo(refresh(R1, randomUUID()));
      expect(rival).not.toBeNull();
      // A rival não gravou chave → para esta requisição é reuso: família derrubada, candidato nunca devolvido.
      expect(resultado).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
      expect(await ativosDaFamilia(await familiaDe(R1))).toBe(0);
      expect(await ativosDoUsuario(u.id)).toBe(1); // só a outra sessão
      expect(await ativo(outraSessao)).toBe(true);
    });
  });

  describe("11.3 recuperação", () => {
    it("resposta perdida: repetir R1 com a MESMA chave devolve o MESMO R2, sem criar R3 nem mudar substituidoPor", async () => {
      const { u, R1, K, R2 } = await rotacaoComRespostaPerdida("perdida");
      const total = await totalDoUsuario(u.id);
      const recuperado = await refresh(R1, K);
      expect(recuperado.refreshToken).toBe(R2);
      expect(recuperado.accessToken.split(".")).toHaveLength(3);
      expect(await totalDoUsuario(u.id)).toBe(total);
      expect((await doc(R1))!["substituidoPor"]).toBe(hash(R2));
      expect((await doc(R1))!["recuperacoes"]).toBe(1);
      expect(await ativo(R2)).toBe(true);
      expect(await eventos(u.id, "REFRESH_RECOVERED")).toBe(1);
      expect(await eventos(u.id, "REFRESH_REUSED")).toBe(0);
      // O R2 recuperado é um token normal: renova a sessão em seguida.
      expect(await codigo(refresh(R2))).toBe("OK");
    });

    it(`limite: ${LIMITE_RECUPERACOES_REFRESH} recuperações devolvem o mesmo R2; a ${LIMITE_RECUPERACOES_REFRESH + 1}ª não devolve e derruba só a família`, async () => {
      const { u, R1, K, R2, familia } = await rotacaoComRespostaPerdida("limite");
      const outra = (await login(u.email)).refreshToken;
      for (let i = 0; i < LIMITE_RECUPERACOES_REFRESH; i += 1) expect((await refresh(R1, K)).refreshToken).toBe(R2);
      expect((await doc(R1))!["recuperacoes"]).toBe(LIMITE_RECUPERACOES_REFRESH);
      expect(await codigo(refresh(R1, K))).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
      expect((await doc(R1))!["recuperacoes"]).toBe(LIMITE_RECUPERACOES_REFRESH);
      expect(await ativosDaFamilia(familia)).toBe(0);
      expect(await ativo(outra)).toBe(true);
      expect((await doc(R1))!["sucessorSelado"]).toBeUndefined(); // limpeza oportunista
    });

    it("chave diferente: reuso suspeito — só a família cai; outra família do usuário e outro usuário intactos", async () => {
      const { u, R1, familia } = await rotacaoComRespostaPerdida("chave-errada");
      const outra = (await login(u.email)).refreshToken;
      const x = await novoAdmin("chave-errada-outro");
      const X1 = (await login(x.email)).refreshToken;
      expect(await codigo(refresh(R1, randomUUID()))).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
      expect(await ativosDaFamilia(familia)).toBe(0);
      expect(await ativo(outra)).toBe(true);
      expect(await ativo(X1)).toBe(true);
      expect(await eventos(u.id, "REFRESH_REUSED")).toBe(1);
    });

    it("sem chave em R1 rotacionado: reuso suspeito (nenhuma heurística de recuperação)", async () => {
      const { R1, familia } = await rotacaoComRespostaPerdida("sem-chave-recuperacao");
      expect(await codigo(refresh(R1))).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
      expect(await ativosDaFamilia(familia)).toBe(0);
    });

    it("chave correta FORA da janela: REFRESH_TOKEN_INVALID, só a família, evento próprio (não é reuso), selo removido", async () => {
      const { u, R1, K, familia } = await rotacaoComRespostaPerdida("janela");
      const outra = (await login(u.email)).refreshToken;
      await tokens().updateOne({ tokenHash: hash(R1) }, { $set: { recuperavelAte: new Date(Date.now() - 1) } });
      expect(await codigo(refresh(R1, K))).toBe(ERROR_CODES.REFRESH_TOKEN_INVALID);
      expect(await ativosDaFamilia(familia)).toBe(0);
      expect(await ativo(outra)).toBe(true);
      expect(await eventos(u.id, "REFRESH_RECOVERY_EXPIRED")).toBe(1);
      expect(await eventos(u.id, "REFRESH_REUSED")).toBe(0);
      expect((await doc(R1))!["sucessorSelado"]).toBeUndefined();
      // Repetir continua INVALID (a janela não reabre).
      expect(await codigo(refresh(R1, K))).toBe(ERROR_CODES.REFRESH_TOKEN_INVALID);
    });

    it("família revogada por logout: nenhuma recuperação devolve R2 depois", async () => {
      const { R1, K, R2, familia } = await rotacaoComRespostaPerdida("apos-logout");
      await service.logout({ refreshToken: R1 });
      const r = await codigo(refresh(R1, K));
      expect(r).not.toBe("OK");
      expect(await ativosDaFamilia(familia)).toBe(0);
      expect(await ativo(R2)).toBe(false);
    });

    it("sucessor já consumido (R2 → R3): R1 + chave não recupera; é reuso e derruba a família (inclusive R3)", async () => {
      const { R1, K, R2, familia } = await rotacaoComRespostaPerdida("consumido");
      const R3 = (await refresh(R2)).refreshToken;
      expect(await codigo(refresh(R1, K))).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
      expect(await ativo(R3)).toBe(false);
      expect(await ativosDaFamilia(familia)).toBe(0);
    });

    it("sucessor apontando para OUTRA família do mesmo usuário: não recupera; é reuso só da família de R1", async () => {
      const { u, R1, K, familia } = await rotacaoComRespostaPerdida("outra-familia");
      const outraSessao = (await login(u.email)).refreshToken;
      await tokens().updateOne({ tokenHash: hash(R1) }, { $set: { substituidoPor: hash(outraSessao) } });
      expect(await codigo(refresh(R1, K))).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
      expect(await ativosDaFamilia(familia)).toBe(0);
      expect(await ativo(outraSessao)).toBe(true);
      expect(await eventos(u.id, "REFRESH_RECOVERED")).toBe(0);
    });

    for (const [nome, adulteracao] of [
      ["ciphertext adulterado", { "sucessorSelado.ct": randomBytes(43).toString("base64url") }],
      ["versão desconhecida", { "sucessorSelado.v": 99 }],
      ["substituidoPor inconsistente com o selo", "trocar-substituido"],
    ] as const) {
      it(`documento inconsistente (${nome}): não recupera; INVALID, só a família, REFRESH_RECOVERY_FAILED`, async () => {
        const { u, R1, K, familia } = await rotacaoComRespostaPerdida(`inconsistente-${nome}`);
        const outra = (await login(u.email)).refreshToken;
        if (adulteracao === "trocar-substituido") {
          // Aponta para OUTRO token ativo da mesma família (forjado no banco): o HMAC do R2 decifrado não confere.
          const forjado = randomBytes(32).toString("base64url");
          const d1 = (await doc(R1))!;
          await tokens().insertOne({ usuarioId: d1["usuarioId"], tokenHash: hash(forjado), familiaId: familia, expiresAt: new Date(Date.now() + 864e5), revogadoEm: null, rotacionadoEm: null, substituidoPor: null, userAgent: null, ip: null, criadoEm: new Date() });
          await tokens().updateOne({ tokenHash: hash(R1) }, { $set: { substituidoPor: hash(forjado) } });
        } else {
          await tokens().updateOne({ tokenHash: hash(R1) }, { $set: adulteracao });
        }
        expect(await codigo(refresh(R1, K))).toBe(ERROR_CODES.REFRESH_TOKEN_INVALID);
        expect(await ativosDaFamilia(familia)).toBe(0);
        expect(await ativo(outra)).toBe(true);
        expect(await eventos(u.id, "REFRESH_RECOVERY_FAILED")).toBe(1);
        expect(await eventos(u.id, "REFRESH_RECOVERED")).toBe(0);
      });
    }

    it("LEGADO: rotação com chave não grava recuperação no legado; repetir R1 + chave segue a regra legada (todas as sessões)", async () => {
      const u = await novoAdmin("legado");
      const outro = await novoAdmin("legado-outro");
      const X1 = (await login(outro.email)).refreshToken;
      const L1 = randomBytes(32).toString("base64url");
      await tokens().insertOne({ usuarioId: u.id, tokenHash: hash(L1), expiresAt: new Date(Date.now() + 864e5), revogadoEm: null, rotacionadoEm: null, substituidoPor: null, userAgent: null, ip: null, criadoEm: new Date() });
      const comFamilia = (await login(u.email)).refreshToken;
      const K = randomUUID();
      const L2 = (await refresh(L1, K)).refreshToken;
      const dl = (await doc(L1))!;
      expect(dl["familiaId"]).toBeUndefined();
      for (const campo of ["chaveHash", "sucessorSelado", "recuperavelAte", "recuperacoes"]) expect(dl[campo]).toBeUndefined();
      expect(await familiaDe(L2)).toMatch(/^[0-9a-f-]{36}$/); // migração: o sucessor ganha família nova
      expect(await codigo(refresh(L1, K))).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
      expect(await ativosDoUsuario(u.id)).toBe(0);
      expect(await ativo(comFamilia)).toBe(false);
      expect(await ativo(X1)).toBe(true);
    });
  });

  describe("11.4 concorrência real (Promise.allSettled, sem sleeps)", () => {
    const RODADAS = 10;

    it("duas requisições simultâneas com R1 e a MESMA chave: ambas recebem o MESMO R2; a família fica com 1 ativo", async () => {
      for (let rodada = 0; rodada < RODADAS; rodada += 1) {
        const u = await novoAdmin(`conc-mesma-chave-${rodada}`);
        const R1 = (await login(u.email)).refreshToken;
        const K = randomUUID();
        const resultados = await Promise.allSettled([refresh(R1, K), refresh(R1, K)]);
        const ok = resultados.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ refreshToken: string }>).value.refreshToken);
        expect(ok).toHaveLength(2);
        expect(ok[0]).toBe(ok[1]!);
        expect((await doc(R1))!["substituidoPor"]).toBe(hash(ok[0]!));
        expect(await ativosDaFamilia(await familiaDe(R1))).toBe(1);
        expect(await ativosDoUsuario(u.id)).toBe(1); // o candidato da perdedora não sobrevive
        expect((await doc(R1))!["recuperacoes"]).toBeLessThanOrEqual(1);
      }
    }, 120_000);

    it(`várias recuperações simultâneas nunca passam de ${LIMITE_RECUPERACOES_REFRESH}`, async () => {
      for (let rodada = 0; rodada < 5; rodada += 1) {
        const { R1, K, R2, familia } = await rotacaoComRespostaPerdida(`conc-limite-${rodada}`);
        const resultados = await Promise.allSettled(Array.from({ length: 12 }, () => refresh(R1, K)));
        const devolvidos = resultados.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ refreshToken: string }>).value.refreshToken);
        expect(devolvidos.length).toBeLessThanOrEqual(LIMITE_RECUPERACOES_REFRESH);
        for (const t of devolvidos) expect(t).toBe(R2);
        expect((await doc(R1))!["recuperacoes"]).toBeLessThanOrEqual(LIMITE_RECUPERACOES_REFRESH);
        expect(await ativosDaFamilia(familia)).toBe(0); // as excedentes são reuso: família derrubada
      }
    }, 120_000);

    it("recuperação simultânea com logout: a família termina sem ativo; nada fora dela muda", async () => {
      for (let rodada = 0; rodada < RODADAS; rodada += 1) {
        const { u, R1, K, familia } = await rotacaoComRespostaPerdida(`conc-logout-${rodada}`);
        const outra = (await login(u.email)).refreshToken;
        await Promise.allSettled([refresh(R1, K), service.logout({ refreshToken: R1 })]);
        expect(await ativosDaFamilia(familia)).toBe(0);
        expect(await ativosDoUsuario(u.id)).toBe(1);
        expect(await ativo(outra)).toBe(true);
      }
    }, 120_000);

    it("recuperação simultânea com refresh do sucessor: nunca mais de 1 ativo na família, nenhum fora dela", async () => {
      for (let rodada = 0; rodada < RODADAS; rodada += 1) {
        const { u, R1, K, R2, familia } = await rotacaoComRespostaPerdida(`conc-sucessor-${rodada}`);
        const outra = (await login(u.email)).refreshToken;
        await Promise.allSettled([refresh(R1, K), refresh(R2)]);
        expect(await ativosDaFamilia(familia)).toBeLessThanOrEqual(1);
        expect(await ativosDoUsuario(u.id)).toBe((await ativosDaFamilia(familia)) + 1);
        expect(await ativo(outra)).toBe(true);
      }
    }, 120_000);

    it("reuso com chave errada simultâneo com recuperação legítima: família derrubada, outra família intacta", async () => {
      for (let rodada = 0; rodada < RODADAS; rodada += 1) {
        const { u, R1, K, familia } = await rotacaoComRespostaPerdida(`conc-errada-${rodada}`);
        const outra = (await login(u.email)).refreshToken;
        await Promise.allSettled([refresh(R1, K), refresh(R1, randomUUID())]);
        expect(await ativosDaFamilia(familia)).toBe(0);
        expect(await ativo(outra)).toBe(true);
      }
    }, 120_000);

    it("duas famílias do mesmo usuário e outro usuário recuperando ao mesmo tempo: cada uma recebe o seu R2", async () => {
      for (let rodada = 0; rodada < RODADAS; rodada += 1) {
        const a = await rotacaoComRespostaPerdida(`conc-familias-a-${rodada}`);
        const b1 = (await login(a.u.email)).refreshToken;
        const Kb = randomUUID();
        const b2 = (await refresh(b1, Kb)).refreshToken;
        const c = await rotacaoComRespostaPerdida(`conc-familias-c-${rodada}`);
        const [ra, rb, rc] = await Promise.all([refresh(a.R1, a.K), refresh(b1, Kb), refresh(c.R1, c.K)]);
        expect([ra.refreshToken, rb.refreshToken, rc.refreshToken]).toEqual([a.R2, b2, c.R2]);
        expect(await ativosDoUsuario(a.u.id)).toBe(2);
        expect(await ativosDoUsuario(c.u.id)).toBe(1);
      }
    }, 120_000);
  });

  describe("11.6 eventos sem material secreto", () => {
    it("eventos de rotação, recuperação, reuso e logout não contêm tokens, hashes, chave, selo nem família", async () => {
      const { u, R1, K, R2, familia } = await rotacaoComRespostaPerdida("eventos");
      const recuperado = await refresh(R1, K);
      await service.logout({ refreshToken: R2 });
      await codigo(refresh(R1, randomUUID()));
      const lista = await connection.collection("eventos_auth").find({ usuarioId: u.id }).toArray();
      // `ADMIN_CREATED` = auditoria da criação do usuário de teste (`criarAdminSeed`).
      expect(lista.map((e) => e["tipo"])).toEqual(["ADMIN_CREATED", "LOGIN_SUCCESS", "REFRESH", "REFRESH_RECOVERED", "LOGOUT", "REFRESH_REUSED"]);
      const d1 = (await doc(R1))!;
      const serializado = JSON.stringify(lista);
      const proibidos = [R1, R2, K, recuperado.accessToken, hash(R1), hash(R2), d1["chaveHash"] as string, familia, JSON.stringify(d1["sucessorSelado"] ?? "∅")];
      for (const p of proibidos) expect(serializado).not.toContain(p);
    });
  });
});

describe("Recuperação DESLIGADA (segredo ausente) — comportamento da Fase 22.8.7.1, sem fallback", () => {
  let moduleRef: TestingModule;
  let restaurar: () => Promise<void>;
  let service: AuthService;
  let connection: Connection;
  let segredoRefresh: string;
  const criados: Types.ObjectId[] = [];

  beforeAll(async () => {
    ({ moduleRef, restaurar } = await montarModulo(false));
    service = moduleRef.get(AuthService);
    connection = moduleRef.get(getConnectionToken());
    segredoRefresh = moduleRef.get(ConfigService).get<string>("jwt.refreshSecret")!;
  });

  afterAll(async () => {
    await connection.collection("refresh_tokens").deleteMany({ usuarioId: { $in: criados } });
    await connection.collection("eventos_auth").deleteMany({ usuarioId: { $in: criados } });
    await connection.collection("usuarios").deleteMany({ _id: { $in: criados } });
    await restaurar();
  });

  it("com chave: a rotação não grava material de recuperação e a repetição é reuso (família)", async () => {
    const email = emailUnico("desligado");
    const { usuario } = await service.criarAdminSeed({ nome: "Desligado", email, senha: SENHA });
    criados.push(new Types.ObjectId(usuario.id));
    const R1 = (await service.login({ usuario: email, senha: SENHA }, contexto)).refreshToken;
    const K = randomUUID();
    await service.refresh({ refreshToken: R1 }, contexto, K);
    const d1 = await connection.collection("refresh_tokens").findOne({ tokenHash: createHmac("sha256", segredoRefresh).update(R1).digest("hex") });
    for (const campo of ["chaveHash", "sucessorSelado", "recuperavelAte", "recuperacoes"]) expect(d1![campo]).toBeUndefined();
    let codigoErro = "";
    try {
      await service.refresh({ refreshToken: R1 }, contexto, K);
    } catch (erro) {
      codigoErro = (erro as ApiException).code;
    }
    expect(codigoErro).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
  });
});
