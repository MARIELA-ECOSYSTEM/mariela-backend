import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { mongo, Types, type Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { ERROR_CODES } from "../../common/constants/error-codes.constant.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService, decisaoCertamenteNaoAplicada } from "./auth.service.js";
import { RefreshTokensRepository } from "./refresh-tokens.repository.js";
import { UsuariosRepository } from "./usuarios.repository.js";

/**
 * Fase 22.8.7.5 (F5) — CANDIDATO ÓRFÃO: uma falha entre a criação do candidato R2 e a conclusão da decisão atômica
 * não pode deixar um refresh token ativo que ninguém possui — mas a limpeza também nunca pode atingir R1, a família,
 * o sucessor de outra requisição, nem um candidato que PODE ter sido adotado (resultado ambíguo).
 *
 * Integração com MongoDB real (replica set da suíte). As falhas de banco são INJETADAS envolvendo o repositório real
 * (sem sleeps): erro antes de enviar, erro definitivo do servidor, erro de rede com e sem aplicação, falha após a
 * decisão. Toda asserção de estado lê a coleção `refresh_tokens` diretamente.
 */

const SENHA = "senha-correta-candidato-123";
const contexto = { ip: "127.0.0.1", userAgent: "bun-test-candidato" };
let contador = 0;
const emailUnico = (s: string) => `teste.candidato.${s.toLowerCase()}.${Date.now()}.${++contador}@mariela.dev`;

// Erros reais do driver, como o Mongoose os propaga.
// O construtor lê `reason.error` (descrição da topologia): uma descrição mínima de topologia "Unknown" basta.
const erroSemServidor = () =>
  new mongo.MongoServerSelectionError("seleção de servidor falhou (simulada)", {
    type: "Unknown",
    servers: new Map(),
    error: undefined,
  } as never);
const erroDoServidor = () => new mongo.MongoServerError({ message: "comando recusado (simulado)", code: 2, errmsg: "BadValue" });
const erroDeRede = () => new mongo.MongoNetworkError("conexão perdida (simulada)");
const erroDeRedeAposTimeout = () => new mongo.MongoNetworkTimeoutError("timeout de rede (simulado)");
const erroDeWriteConcern = () =>
  new mongo.MongoWriteConcernError({
    errorLabels: [],
    writeConcernError: { code: 64, errmsg: "waiting for replication timed out (simulado)" },
  } as never);

describe("Candidato órfão na rotação (Fase 22.8.7.5 — F5, integração MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: AuthService;
  let repositorio: RefreshTokensRepository;
  let usuarios: UsuariosRepository;
  let connection: Connection;
  let segredoRefresh: string;
  let segredoAnterior: string | undefined;
  const criados: Types.ObjectId[] = [];
  const restaurar: (() => void)[] = [];

  const hash = (t: string) => createHmac("sha256", segredoRefresh).update(t).digest("hex");
  const tokens = () => connection.collection("refresh_tokens");
  const doc = (t: string) => tokens().findOne({ tokenHash: hash(t) });
  const familiaDe = async (t: string) => (await doc(t))!["familiaId"] as string;
  /** Documentos da família, exceto os hashes informados — ou seja, os candidatos criados nela. */
  const candidatosDaFamilia = (familiaId: string, exceto: string[]) =>
    tokens().find({ familiaId, tokenHash: { $nin: exceto } }).toArray();
  const ativosDoUsuario = (id: Types.ObjectId) => tokens().countDocuments({ usuarioId: id, revogadoEm: null });

  async function cenario(sufixo: string) {
    const email = emailUnico(sufixo);
    const { usuario } = await service.criarAdminSeed({ nome: `Candidato ${sufixo}`, email, senha: SENHA });
    const id = new Types.ObjectId(usuario.id);
    criados.push(id);
    const R1 = (await service.login({ usuario: email, senha: SENHA }, contexto)).refreshToken;
    const outraFamilia = (await service.login({ usuario: email, senha: SENHA }, contexto)).refreshToken;
    const outro = emailUnico(`${sufixo}-outro`);
    const { usuario: u2 } = await service.criarAdminSeed({ nome: "Outro", email: outro, senha: SENHA });
    criados.push(new Types.ObjectId(u2.id));
    const outroUsuario = (await service.login({ usuario: outro, senha: SENHA }, contexto)).refreshToken;
    return { id, R1, outraFamilia, outroUsuario, familia: await familiaDe(R1) };
  }
  /** Nada fora da família de R1 foi tocado. */
  async function independentesIntactos(c: { outraFamilia: string; outroUsuario: string }) {
    expect((await doc(c.outraFamilia))!["revogadoEm"]).toBeNull();
    expect((await doc(c.outroUsuario))!["revogadoEm"]).toBeNull();
  }

  /** Substitui `rotacionarSeValido` UMA vez: `aplicar` decide se a decisão real chega ao banco antes do erro. */
  function falharDecisao(erro: () => Error, aplicar: boolean) {
    const original = repositorio.rotacionarSeValido.bind(repositorio);
    repositorio.rotacionarSeValido = async (...args) => {
      repositorio.rotacionarSeValido = original;
      if (aplicar) await original(...args);
      throw erro();
    };
    restaurar.push(() => (repositorio.rotacionarSeValido = original));
  }
  async function codigo(promessa: Promise<unknown>): Promise<string> {
    try {
      await promessa;
      return "OK";
    } catch (e) {
      return e instanceof ApiException ? e.code : (e as Error).name;
    }
  }

  beforeAll(async () => {
    segredoAnterior = process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"];
    process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"] = `segredo-candidato-teste-${randomBytes(24).toString("base64url")}`;
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    service = moduleRef.get(AuthService);
    repositorio = moduleRef.get(RefreshTokensRepository, { strict: false });
    usuarios = moduleRef.get(UsuariosRepository, { strict: false });
    connection = moduleRef.get(getConnectionToken());
    segredoRefresh = moduleRef.get(ConfigService).get<string>("jwt.refreshSecret")!;
  });

  afterEach(() => {
    for (const r of restaurar.splice(0)) r();
  });

  afterAll(async () => {
    await tokens().deleteMany({ usuarioId: { $in: criados } });
    await connection.collection("eventos_auth").deleteMany({ usuarioId: { $in: criados } });
    await connection.collection("usuarios").deleteMany({ _id: { $in: criados } });
    await moduleRef.close();
    if (segredoAnterior === undefined) delete process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"];
    else process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"] = segredoAnterior;
  });

  it("classificação: só 'sem servidor' e 'recusa do servidor' são certamente não aplicados; o resto é ambíguo", () => {
    expect(decisaoCertamenteNaoAplicada(erroSemServidor())).toBe(true);
    expect(decisaoCertamenteNaoAplicada(erroDoServidor())).toBe(true);
    const recusaRetentavel = erroDoServidor();
    recusaRetentavel.addErrorLabel("RetryableWriteError");
    expect(decisaoCertamenteNaoAplicada(recusaRetentavel)).toBe(false);
    expect(decisaoCertamenteNaoAplicada(erroDeWriteConcern())).toBe(false);
    expect(decisaoCertamenteNaoAplicada(erroDeRede())).toBe(false);
    expect(decisaoCertamenteNaoAplicada(erroDeRedeAposTimeout())).toBe(false);
    expect(decisaoCertamenteNaoAplicada(new Error("desconhecido"))).toBe(false);
    expect(decisaoCertamenteNaoAplicada(null)).toBe(false);
  });

  for (const [nome, erro] of [
    ["servidor não selecionado (nunca enviada)", erroSemServidor],
    ["recusa definitiva do servidor", erroDoServidor],
  ] as const) {
    for (const comChave of [false, true]) {
      it(`falha CERTA na decisão (${nome}, ${comChave ? "com" : "sem"} Idempotency-Key): só o candidato é revogado; R1 continua válido`, async () => {
        const c = await cenario(`certa-${comChave}`);
        falharDecisao(erro, false);
        const K = comChave ? randomUUID() : null;
        expect(await codigo(service.refresh({ refreshToken: c.R1 }, contexto, K))).not.toBe("OK");

        const candidatos = await candidatosDaFamilia(c.familia, [hash(c.R1)]);
        expect(candidatos).toHaveLength(1);
        expect(candidatos[0]!["revogadoEm"]).not.toBeNull(); // o órfão foi revogado
        const d1 = (await doc(c.R1))!;
        expect(d1["revogadoEm"]).toBeNull(); // R1 NÃO é revogado pela compensação
        expect(d1["substituidoPor"]).toBeNull();
        await independentesIntactos(c);
        // O cliente repete (mesma chave, se houver) e a rotação acontece normalmente.
        const r2 = await service.refresh({ refreshToken: c.R1 }, contexto, K);
        expect((await doc(c.R1))!["substituidoPor"]).toBe(hash(r2.refreshToken));
        expect(await ativosDoUsuario(c.id)).toBe(2); // R2 + a outra família
      });
    }
  }

  it("falha ANTES da decisão — a própria gravação do candidato tem resultado ambíguo: candidato revogado (a decisão nunca saiu)", async () => {
    const c = await cenario("antes");
    const criar = repositorio.criar.bind(repositorio);
    repositorio.criar = async (dados) => {
      repositorio.criar = criar;
      await criar(dados); // gravou…
      throw erroDeRede(); // …mas a confirmação se perdeu
    };
    restaurar.push(() => (repositorio.criar = criar));
    expect(await codigo(service.refresh({ refreshToken: c.R1 }, contexto, randomUUID()))).not.toBe("OK");
    const candidatos = await candidatosDaFamilia(c.familia, [hash(c.R1)]);
    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]!["revogadoEm"]).not.toBeNull();
    expect((await doc(c.R1))!["revogadoEm"]).toBeNull();
    await independentesIntactos(c);
  });

  for (const [nome, erro] of [
    ["rede", erroDeRede],
    ["timeout de rede", erroDeRedeAposTimeout],
    ["write concern", erroDeWriteConcern],
  ] as const) {
    it(`falha AMBÍGUA DURANTE a decisão, que FOI aplicada (${nome}): candidato preservado e adotado; a mesma chave o recupera`, async () => {
      const c = await cenario(`ambigua-aplicada-${nome}`);
      falharDecisao(erro, true);
      const K = randomUUID();
      expect(await codigo(service.refresh({ refreshToken: c.R1 }, contexto, K))).not.toBe("OK");
      const d1 = (await doc(c.R1))!;
      expect(d1["revogadoEm"]).not.toBeNull(); // a rotação aconteceu
      const [candidato] = await candidatosDaFamilia(c.familia, [hash(c.R1)]);
      expect(candidato!["tokenHash"]).toBe(d1["substituidoPor"]);
      expect(candidato!["revogadoEm"]).toBeNull(); // sucessor legítimo PRESERVADO
      // Recuperação idempotente (Fase 22.8.7.2): o cliente repete R1 + K e recebe esse mesmo sucessor.
      const recuperado = await service.refresh({ refreshToken: c.R1 }, contexto, K);
      expect(hash(recuperado.refreshToken)).toBe(d1["substituidoPor"]);
      await independentesIntactos(c);
    });
  }

  it("falha AMBÍGUA durante a decisão, que NÃO foi aplicada: candidato preservado (limitação documentada); R1 intacto", async () => {
    const c = await cenario("ambigua-nao-aplicada");
    falharDecisao(erroDeRede, false);
    expect(await codigo(service.refresh({ refreshToken: c.R1 }, contexto, randomUUID()))).not.toBe("OK");
    const [candidato] = await candidatosDaFamilia(c.familia, [hash(c.R1)]);
    expect(candidato!["revogadoEm"]).toBeNull(); // não é possível provar que não foi adotado → preservado
    expect((await doc(c.R1))!["revogadoEm"]).toBeNull();
    await independentesIntactos(c);
    // Ninguém conhece o candidato; o logout da família o elimina.
    await service.logout({ refreshToken: c.R1 });
    expect(await tokens().countDocuments({ familiaId: c.familia, revogadoEm: null })).toBe(0);
  });

  it("erro 'certo' mas a decisão FOI aplicada (classificação errada): a releitura de R1 mostra a adoção e o candidato é preservado", async () => {
    const c = await cenario("certa-mas-aplicada");
    falharDecisao(erroDoServidor, true);
    const K = randomUUID();
    expect(await codigo(service.refresh({ refreshToken: c.R1 }, contexto, K))).not.toBe("OK");
    const d1 = (await doc(c.R1))!;
    const [candidato] = await candidatosDaFamilia(c.familia, [hash(c.R1)]);
    expect(candidato!["tokenHash"]).toBe(d1["substituidoPor"]);
    expect(candidato!["revogadoEm"]).toBeNull();
    expect(hash((await service.refresh({ refreshToken: c.R1 }, contexto, K)).refreshToken)).toBe(d1["substituidoPor"]);
  });

  it("banco indisponível TAMBÉM na compensação: preserva (não lança outro erro; o original chega ao cliente)", async () => {
    const c = await cenario("compensacao-falha");
    falharDecisao(erroSemServidor, false);
    const encontrar = repositorio.encontrarPorHash.bind(repositorio);
    let chamadas = 0;
    repositorio.encontrarPorHash = async (h) => {
      chamadas += 1;
      if (chamadas >= 2) throw erroSemServidor(); // 1ª = peek de R1; 2ª = releitura da compensação
      return encontrar(h);
    };
    restaurar.push(() => (repositorio.encontrarPorHash = encontrar));
    let recebido: unknown;
    try {
      await service.refresh({ refreshToken: c.R1 }, contexto, null);
    } catch (e) {
      recebido = e;
    }
    expect(recebido).toBeInstanceOf(mongo.MongoServerSelectionError);
    repositorio.encontrarPorHash = encontrar;
    const [candidato] = await candidatosDaFamilia(c.familia, [hash(c.R1)]);
    expect(candidato!["revogadoEm"]).toBeNull(); // sem confirmação possível → preservado
  });

  it("falha DEPOIS da decisão (releitura do usuário): candidato adotado nunca é compensado; a recuperação o devolve", async () => {
    const c = await cenario("depois");
    const rotacionar = repositorio.rotacionarSeValido.bind(repositorio);
    const encontrarPorId = usuarios.encontrarPorId.bind(usuarios);
    let decidido = false;
    repositorio.rotacionarSeValido = async (...args) => {
      const r = await rotacionar(...args);
      decidido = true;
      return r;
    };
    usuarios.encontrarPorId = async (id) => {
      if (decidido) {
        usuarios.encontrarPorId = encontrarPorId;
        throw erroSemServidor();
      }
      return encontrarPorId(id);
    };
    restaurar.push(() => {
      repositorio.rotacionarSeValido = rotacionar;
      usuarios.encontrarPorId = encontrarPorId;
    });
    const K = randomUUID();
    expect(await codigo(service.refresh({ refreshToken: c.R1 }, contexto, K))).not.toBe("OK");
    repositorio.rotacionarSeValido = rotacionar;
    const d1 = (await doc(c.R1))!;
    const [candidato] = await candidatosDaFamilia(c.familia, [hash(c.R1)]);
    expect(candidato!["tokenHash"]).toBe(d1["substituidoPor"]);
    expect(candidato!["revogadoEm"]).toBeNull();
    expect(hash((await service.refresh({ refreshToken: c.R1 }, contexto, K)).refreshToken)).toBe(d1["substituidoPor"]);
    await independentesIntactos(c);
  });

  it("duas rotações concorrentes: o candidato da PERDEDORA é revogado e o da VENCEDORA preservado (rodadas reais)", async () => {
    for (let rodada = 0; rodada < 10; rodada += 1) {
      const c = await cenario(`concorrente-${rodada}`);
      const resultados = await Promise.allSettled([
        service.refresh({ refreshToken: c.R1 }, contexto),
        service.refresh({ refreshToken: c.R1 }, contexto),
      ]);
      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      // Sem chave, a perdedora é reuso (Fase 22.8.7.1): a família toda cai — inclusive o sucessor da vencedora — e
      // NADA fora dela. O candidato da perdedora nunca fica ativo.
      expect(await tokens().countDocuments({ familiaId: c.familia, revogadoEm: null })).toBe(0);
      await independentesIntactos(c);
    }
  }, 120_000);

  it("duas rotações concorrentes COM a mesma chave: perdedora recupera o sucessor da vencedora; candidato perdedor revogado", async () => {
    for (let rodada = 0; rodada < 10; rodada += 1) {
      const c = await cenario(`concorrente-chave-${rodada}`);
      const K = randomUUID();
      const [a, b] = await Promise.all([
        service.refresh({ refreshToken: c.R1 }, contexto, K),
        service.refresh({ refreshToken: c.R1 }, contexto, K),
      ]);
      expect(a.refreshToken).toBe(b.refreshToken);
      const d1 = (await doc(c.R1))!;
      const candidatos = await candidatosDaFamilia(c.familia, [hash(c.R1)]);
      const ativos = candidatos.filter((x) => x["revogadoEm"] == null);
      expect(ativos.map((x) => x["tokenHash"])).toEqual([d1["substituidoPor"]]); // só o vencedor
      expect(candidatos.length).toBeLessThanOrEqual(2);
      await independentesIntactos(c);
    }
  }, 120_000);

  it("rotação de token LEGADO com falha certa: o candidato (de família nova) é revogado; o legado continua válido", async () => {
    const email = emailUnico("legado");
    const { usuario } = await service.criarAdminSeed({ nome: "Legado", email, senha: SENHA });
    const id = new Types.ObjectId(usuario.id);
    criados.push(id);
    const L1 = randomBytes(32).toString("base64url");
    await tokens().insertOne({ usuarioId: id, tokenHash: hash(L1), expiresAt: new Date(Date.now() + 864e5), revogadoEm: null, rotacionadoEm: null, substituidoPor: null, userAgent: null, ip: null, criadoEm: new Date() });
    falharDecisao(erroSemServidor, false);
    expect(await codigo(service.refresh({ refreshToken: L1 }, contexto, randomUUID()))).not.toBe("OK");
    const candidatos = await tokens().find({ usuarioId: id, tokenHash: { $ne: hash(L1) } }).toArray();
    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]!["revogadoEm"]).not.toBeNull();
    expect((await doc(L1))!["revogadoEm"]).toBeNull();
    expect((await doc(L1))!["familiaId"]).toBeUndefined();
    expect(await codigo(service.refresh({ refreshToken: L1 }, contexto))).toBe("OK"); // e a migração segue normal
  });

  it("recuperação idempotente após resposta perdida continua funcionando (regressão)", async () => {
    const c = await cenario("regressao");
    const K = randomUUID();
    const R2 = (await service.refresh({ refreshToken: c.R1 }, contexto, K)).refreshToken; // resposta "perdida"
    expect((await service.refresh({ refreshToken: c.R1 }, contexto, K)).refreshToken).toBe(R2);
    expect(await codigo(service.refresh({ refreshToken: c.R1 }, contexto, randomUUID()))).toBe(ERROR_CODES.REFRESH_TOKEN_REUSED);
    await independentesIntactos(c);
  });
});
