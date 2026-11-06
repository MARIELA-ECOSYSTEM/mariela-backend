import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { randomBytes } from "node:crypto";
import { Types, type Connection, type Model } from "mongoose";
import { AppModule } from "../../app.module.js";
import { ERROR_CODES, type ErrorCode } from "../../common/constants/error-codes.constant.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { Configuration } from "../../config/configuration.js";
import { liberarTudo, novoPonto } from "../../test-utils/barreira.util.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "./auth.service.js";
import { DesativacaoAdminService, FalhaDesativacaoAdmin, ORIGEM_DESATIVACAO_ADMIN, type ResultadoDesativacao } from "./desativacao-admin.service.js";
import { RefreshTokensRepository } from "./refresh-tokens.repository.js";
import { EventoAuth, type EventoAuthDocument } from "./schemas/evento-auth.schema.js";
import { UsuariosRepository } from "./usuarios.repository.js";

/**
 * Fase 60.4.3.1.5 — desativação administrativa (integração, MongoDB REAL `mariela_test`). O `AuthService` é o real
 * (mesmas instâncias de repositório que a desativação usa), então login, refresh e a corrida entre eles e a
 * desativação são exercitados de verdade. Cada teste só cria e só limpa os próprios usuários (prefixo de e-mail).
 */

const contexto = { ip: "127.0.0.1", userAgent: "bun-test-desativacao" };
const SENHA = "senha-correta-123";
const PREFIXO_EMAIL = "teste.desativacao.";
const MOTIVO = "Encerramento da conta temporária de testes";

let contador = 0;
function emailUnico(sufixo: string): string {
  contador += 1;
  return `${PREFIXO_EMAIL}${sufixo.toLowerCase()}.${Date.now()}.${contador}@mariela.dev`;
}

async function falhaDe(promessa: Promise<unknown>): Promise<unknown> {
  try {
    await promessa;
  } catch (erro) {
    return erro;
  }
  throw new Error("a operação deveria ter falhado");
}

describe("DesativacaoAdminService (integração — MongoDB real, Fase 60.4.3.1.5)", () => {
  let moduleRef: TestingModule;
  let auth: AuthService;
  let desativacao: DesativacaoAdminService;
  let usuarios: UsuariosRepository;
  let tokens: RefreshTokensRepository;
  let eventos: Model<EventoAuthDocument>;
  let jwt: JwtService;
  let config: ConfigService<Configuration>;
  let connection: Connection;
  const restaurar: { mockRestore(): void }[] = [];

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    auth = moduleRef.get(AuthService);
    usuarios = moduleRef.get(UsuariosRepository, { strict: false });
    tokens = moduleRef.get(RefreshTokensRepository, { strict: false });
    eventos = moduleRef.get<Model<EventoAuthDocument>>(getModelToken(EventoAuth.name), { strict: false });
    jwt = moduleRef.get(JwtService, { strict: false });
    config = moduleRef.get<ConfigService<Configuration>>(ConfigService, { strict: false });
    connection = moduleRef.get(getConnectionToken());
    // As MESMAS instâncias de repositório que o `AuthService` usa: os espiões pausam o login/refresh reais.
    desativacao = new DesativacaoAdminService(usuarios, tokens, eventos);
  });

  afterEach(() => {
    for (const espiao of restaurar.splice(0)) espiao.mockRestore();
  });

  afterAll(async () => {
    const meus = await connection.collection("usuarios").find({ email: { $regex: `^${PREFIXO_EMAIL.replaceAll(".", "\\.")}` } }).toArray();
    const ids = meus.map((usuario) => usuario["_id"]);
    await connection.collection("refresh_tokens").deleteMany({ usuarioId: { $in: ids } });
    await connection.collection("eventos_auth").deleteMany({ usuarioId: { $in: ids } });
    await connection.collection("usuarios").deleteMany({ _id: { $in: ids } });
    await moduleRef.close();
  });

  async function criarAdmin(sufixo: string) {
    const email = emailUnico(sufixo);
    const { usuario } = await auth.criarAdminSeed({ nome: `Desativação ${sufixo}`, email, senha: SENHA });
    return { email, id: usuario.id, objectId: new Types.ObjectId(usuario.id) };
  }

  const desativar = (email: string, executor: string | null = "operador-de-teste") => desativacao.desativar({ email, motivo: MOTIVO, executor });
  const login = (email: string) => auth.login({ usuario: email, senha: SENHA }, contexto);
  const validas = (usuarioId: Types.ObjectId) => tokens.contarValidosDoUsuario(usuarioId, new Date());
  const eventosDe = (usuarioId: Types.ObjectId, tipo: string) => connection.collection("eventos_auth").find({ usuarioId, tipo }).toArray();
  const documento = (email: string) => connection.collection("usuarios").findOne({ email });
  /** Mesma verificação do `JwtAuthGuard` (assinatura + expiração), com o segredo do Backoffice — não o do PDV. */
  const verificarAccessToken = (token: string) => jwt.verifyAsync<{ sub: string }>(token, { secret: config.get("jwt.accessSecret", { infer: true }) });

  function esperarConcluido(resultado: ResultadoDesativacao) {
    if (resultado.status !== "desativado" && resultado.status !== "ja_inativo") throw new Error(`desfecho inesperado: ${resultado.status}`);
    return resultado;
  }

  async function esperarCodigo(promessa: Promise<unknown>, codigo: ErrorCode) {
    const erro = await falhaDe(promessa);
    expect(erro).toBeInstanceOf(ApiException);
    if (erro instanceof ApiException) expect(erro.code).toBe(codigo);
  }

  describe("regras de negócio", () => {
    it("ADMIN ativo com várias sessões: ativo=false, TODAS revogadas, evento ADMIN_DEACTIVATED, documento preservado", async () => {
      const alvo = await criarAdmin("ativo");
      const sessoes = [await login(alvo.email), await login(alvo.email), await login(alvo.email)];
      expect(await validas(alvo.objectId)).toBe(3);
      const antes = await documento(alvo.email);

      const resultado = esperarConcluido(await desativar(alvo.email));

      expect(resultado.status).toBe("desativado");
      expect(resultado.sessoesRevogadas).toBe(3);
      expect(resultado.sessoesRemanescentes).toBe(0);
      expect(resultado.auditoria).toBe("registrada");
      expect(await validas(alvo.objectId)).toBe(0);

      const depois = await documento(alvo.email);
      expect(depois?.["ativo"]).toBe(false);
      expect(depois?.["desativadoEm"]).toBeInstanceOf(Date);
      expect(depois?.["desativacaoAuditadaEm"]).toBeInstanceOf(Date);
      for (const campo of ["senhaHash", "role", "codigo", "nome", "email", "criadoEm", "ultimoLoginEm"]) expect(depois?.[campo]).toEqual(antes?.[campo]);

      const [evento, ...outros] = await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED");
      expect(outros).toEqual([]);
      expect(evento).toMatchObject({ motivo: MOTIVO, executor: "operador-de-teste", origem: ORIGEM_DESATIVACAO_ADMIN, sessoesRevogadas: 3, reconciliado: false });
      expect(evento?.["desativadoEm"]).toEqual(depois?.["desativadoEm"]);
      const textoDoEvento = JSON.stringify(evento);
      for (const sessao of sessoes) expect(textoDoEvento).not.toContain(sessao.refreshToken);
      expect(textoDoEvento).not.toContain(String(antes?.["senhaHash"]));

      // Login e refresh bloqueados depois da desativação.
      await esperarCodigo(login(alvo.email), ERROR_CODES.INVALID_CREDENTIALS);
      for (const sessao of sessoes) expect(await falhaDe(auth.refresh({ refreshToken: sessao.refreshToken }, contexto))).toBeInstanceOf(ApiException);
      expect(await validas(alvo.objectId)).toBe(0);
    });

    it("executor ausente não é gravado; o motivo sempre é", async () => {
      const alvo = await criarAdmin("sem-executor");
      esperarConcluido(await desativar(alvo.email, null));
      const [evento] = await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED");
      expect(evento?.["motivo"]).toBe(MOTIVO);
      expect(evento && "executor" in evento).toBe(false);
    });

    it("e-mail com maiúsculas e espaços é normalizado (mesma regra do login)", async () => {
      const alvo = await criarAdmin("normaliza");
      const resultado = esperarConcluido(await desativar(`  ${alvo.email.toUpperCase()}  `));
      expect(resultado.alvo.email).toBe(alvo.email);
      expect((await documento(alvo.email))?.["ativo"]).toBe(false);
    });

    it("reexecução é idempotente: nenhuma transição, nenhum evento novo, nada revogado de novo", async () => {
      const alvo = await criarAdmin("idempotente");
      await login(alvo.email);
      esperarConcluido(await desativar(alvo.email));
      const depoisDaPrimeira = await documento(alvo.email);

      const segunda = esperarConcluido(await desativar(alvo.email));

      expect(segunda).toMatchObject({ status: "ja_inativo", sessoesRevogadas: 0, sessoesRemanescentes: 0, auditoria: "ja_registrada", eventoDeSessoes: false });
      expect(await documento(alvo.email)).toEqual(depoisDaPrimeira);
      expect(await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED")).toHaveLength(1);
      expect(await eventosDe(alvo.objectId, "ADMIN_SESSIONS_REVOKED")).toHaveLength(0);
    });

    it("ADMIN já inativo (por outro meio) com sessões remanescentes: revoga e registra ADMIN_DEACTIVATED reconciliado, uma vez", async () => {
      const alvo = await criarAdmin("ja-inativo");
      await login(alvo.email);
      await login(alvo.email);
      await connection.collection("usuarios").updateOne({ email: alvo.email }, { $set: { ativo: false } });

      const resultado = esperarConcluido(await desativar(alvo.email));

      expect(resultado).toMatchObject({ status: "ja_inativo", sessoesRevogadas: 2, sessoesRemanescentes: 0, auditoria: "reconciliada", eventoDeSessoes: false });
      const [evento, ...outros] = await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED");
      expect(outros).toEqual([]);
      expect(evento).toMatchObject({ reconciliado: true, sessoesRevogadas: 2 });
      expect(evento && "desativadoEm" in evento).toBe(false); // não foi este comando que desativou
      expect(await validas(alvo.objectId)).toBe(0);
    });

    it("já inativo e auditado, com uma sessão remanescente: revoga e registra ADMIN_SESSIONS_REVOKED (sem duplicar ADMIN_DEACTIVATED)", async () => {
      const alvo = await criarAdmin("remanescente");
      esperarConcluido(await desativar(alvo.email));
      await tokens.criar({ usuarioId: alvo.objectId, tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 60_000), userAgent: null, ip: null });

      const resultado = esperarConcluido(await desativar(alvo.email));

      expect(resultado).toMatchObject({ status: "ja_inativo", sessoesRevogadas: 1, auditoria: "ja_registrada", eventoDeSessoes: true });
      expect(await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED")).toHaveLength(1);
      const [sessoes] = await eventosDe(alvo.objectId, "ADMIN_SESSIONS_REVOKED");
      expect(sessoes).toMatchObject({ sessoesRevogadas: 1, motivo: MOTIVO, origem: ORIGEM_DESATIVACAO_ADMIN });
    });

    it("usuário inexistente: recusado, nada criado", async () => {
      const email = emailUnico("inexistente");
      expect(await desativar(email)).toEqual({ status: "nao_encontrado" });
      expect(await documento(email)).toBeNull();
    });

    it("usuário não ADMIN: recusado, documento intacto, nenhuma sessão revogada", async () => {
      const email = emailUnico("nao-admin");
      const _id = new Types.ObjectId();
      // O schema só admite ADMIN hoje; o documento cru simula um papel futuro (ou um dado inconsistente).
      await connection.collection("usuarios").insertOne({ _id, codigo: `USR-T${Date.now()}`, nome: "Não admin", email, senhaHash: "x", role: "OPERADOR", ativo: true });
      await tokens.criar({ usuarioId: _id, tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 60_000), userAgent: null, ip: null });
      const antes = await documento(email);

      const resultado = await desativar(email);

      expect(resultado.status).toBe("nao_admin");
      expect(await documento(email)).toEqual(antes);
      expect(await validas(_id)).toBe(1);
      expect(await eventosDe(_id, "ADMIN_DEACTIVATED")).toHaveLength(0);
    });

    it("nunca toca outros usuários: outro ADMIN continua ativo e com a sessão válida", async () => {
      const alvo = await criarAdmin("alvo");
      const outro = await criarAdmin("outro");
      await login(alvo.email);
      const sessaoDoOutro = await login(outro.email);
      const outroAntes = await documento(outro.email);

      esperarConcluido(await desativar(alvo.email));

      expect(await documento(outro.email)).toEqual(outroAntes);
      expect(await validas(outro.objectId)).toBe(1);
      expect((await auth.refresh({ refreshToken: sessaoDoOutro.refreshToken }, contexto)).refreshToken).toBeString();
    });

    it("avaliar (dry-run) não altera nada e descreve o estado", async () => {
      const alvo = await criarAdmin("avaliar");
      await login(alvo.email);
      const antes = await documento(alvo.email);
      expect(await desativacao.avaliar(alvo.email)).toMatchObject({ status: "ativo", sessoesValidas: 1, auditoriaRegistrada: false });
      expect(await documento(alvo.email)).toEqual(antes);
      expect(await validas(alvo.objectId)).toBe(1);
      expect(await desativacao.avaliar(emailUnico("ninguem"))).toEqual({ status: "nao_encontrado" });
    });

    it("limitação documentada: o access token emitido ANTES da desativação continua válido (JWT stateless)", async () => {
      const alvo = await criarAdmin("jwt");
      const sessao = await login(alvo.email);
      esperarConcluido(await desativar(alvo.email));
      const payload = await verificarAccessToken(sessao.accessToken);
      expect(payload.sub).toBe(alvo.id);
    });
  });

  describe("falhas de persistência", () => {
    it("falha na transição: nada muda, nenhum evento", async () => {
      const alvo = await criarAdmin("falha-transicao");
      await login(alvo.email);
      restaurar.push(spyOn(usuarios, "desativarSeAtivo").mockImplementation(async () => {
        throw new Error("falha simulada de escrita");
      }));

      const erro = await falhaDe(desativar(alvo.email));

      expect(erro).toBeInstanceOf(FalhaDesativacaoAdmin);
      if (erro instanceof FalhaDesativacaoAdmin) expect({ etapa: erro.etapa, usuarioInativo: erro.usuarioInativo }).toEqual({ etapa: "transicao", usuarioInativo: false });
      expect((await documento(alvo.email))?.["ativo"]).toBe(true);
      expect(await validas(alvo.objectId)).toBe(1);
      expect(await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED")).toHaveLength(0);
    });

    it("falha na revogação: usuário já inativo (login e refresh recusados); a reexecução revoga e audita (reconciliado)", async () => {
      const alvo = await criarAdmin("falha-revogacao");
      const sessao = await login(alvo.email);
      const original = tokens.revogarTodosDoUsuario.bind(tokens);
      let falhar = true;
      restaurar.push(spyOn(tokens, "revogarTodosDoUsuario").mockImplementation(async (usuarioId, agora) => {
        if (falhar) {
          falhar = false;
          throw new Error("falha simulada de escrita");
        }
        return original(usuarioId, agora);
      }));

      const erro = await falhaDe(desativar(alvo.email));
      expect(erro).toBeInstanceOf(FalhaDesativacaoAdmin);
      if (erro instanceof FalhaDesativacaoAdmin) expect({ etapa: erro.etapa, usuarioInativo: erro.usuarioInativo }).toEqual({ etapa: "revogacao", usuarioInativo: true });
      expect(await validas(alvo.objectId)).toBe(1); // a revogação não aconteceu...
      await esperarCodigo(login(alvo.email), ERROR_CODES.INVALID_CREDENTIALS); // ...mas o login já é recusado

      const retomada = esperarConcluido(await desativar(alvo.email));
      expect(retomada).toMatchObject({ status: "ja_inativo", sessoesRevogadas: 1, sessoesRemanescentes: 0, auditoria: "reconciliada" });
      expect(await falhaDe(auth.refresh({ refreshToken: sessao.refreshToken }, contexto))).toBeInstanceOf(ApiException);
      expect(await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED")).toHaveLength(1);
    });

    it("falha na verificação: etapa identificada; a reexecução conclui", async () => {
      const alvo = await criarAdmin("falha-verificacao");
      await login(alvo.email);
      restaurar.push(spyOn(tokens, "contarValidosDoUsuario").mockImplementation(async () => {
        throw new Error("falha simulada de leitura");
      }));
      const erro = await falhaDe(desativar(alvo.email));
      expect(erro instanceof FalhaDesativacaoAdmin && erro.etapa).toBe("verificacao");
      for (const espiao of restaurar.splice(0)) espiao.mockRestore();

      expect(esperarConcluido(await desativar(alvo.email))).toMatchObject({ status: "ja_inativo", sessoesRemanescentes: 0, auditoria: "reconciliada" });
      expect(await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED")).toHaveLength(1);
    });

    it("falha ao gravar o evento: a marca é desfeita e a reexecução grava o evento UMA vez", async () => {
      const alvo = await criarAdmin("falha-evento");
      await login(alvo.email);
      restaurar.push(spyOn(eventos, "create").mockImplementation(async () => {
        throw new Error("falha simulada de escrita");
      }));

      const erro = await falhaDe(desativar(alvo.email));
      expect(erro).toBeInstanceOf(FalhaDesativacaoAdmin);
      if (erro instanceof FalhaDesativacaoAdmin) expect({ etapa: erro.etapa, reivindicacaoPresa: erro.reivindicacaoPresa }).toEqual({ etapa: "auditoria", reivindicacaoPresa: false });
      expect((await documento(alvo.email))?.["desativacaoAuditadaEm"]).toBeNull();
      expect(await validas(alvo.objectId)).toBe(0); // inativo e sessões revogadas antes da auditoria
      for (const espiao of restaurar.splice(0)) espiao.mockRestore();

      expect(esperarConcluido(await desativar(alvo.email)).auditoria).toBe("reconciliada");
      expect(esperarConcluido(await desativar(alvo.email)).auditoria).toBe("ja_registrada");
      expect(await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED")).toHaveLength(1);
    });

    it("falha ao gravar o evento E ao desfazer a marca: sinalizado como intervenção manual (nunca grava evento duplicado)", async () => {
      const alvo = await criarAdmin("falha-marca");
      restaurar.push(spyOn(eventos, "create").mockImplementation(async () => {
        throw new Error("falha simulada de escrita");
      }));
      restaurar.push(spyOn(usuarios, "liberarAuditoriaDesativacao").mockImplementation(async () => {
        throw new Error("falha simulada de escrita");
      }));

      const erro = await falhaDe(desativar(alvo.email));
      expect(erro instanceof FalhaDesativacaoAdmin && erro.reivindicacaoPresa).toBe(true);
      for (const espiao of restaurar.splice(0)) espiao.mockRestore();

      expect(esperarConcluido(await desativar(alvo.email)).auditoria).toBe("ja_registrada");
      expect(await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED")).toHaveLength(0);
    });
  });

  describe("concorrência com login, refresh e outra desativação (intercalações determinísticas)", () => {
    it("refresh parado DEPOIS de gravar o candidato e ANTES de ler `ativo`: ao retomar, vê inativo e é recusado; nenhuma sessão válida", async () => {
      const alvo = await criarAdmin("corrida-refresh-1");
      const sessao = await login(alvo.email);
      const ponto = novoPonto();
      const original = tokens.revogarSeValido.bind(tokens);
      let pausar = true;
      restaurar.push(spyOn(tokens, "revogarSeValido").mockImplementation(async (hash, agora) => {
        const anterior = await original(hash, agora);
        if (pausar) {
          pausar = false;
          ponto.chegou.liberar();
          await ponto.liberacao.promessa;
        }
        return anterior;
      }));

      try {
        const refresh = falhaDe(auth.refresh({ refreshToken: sessao.refreshToken }, contexto));
        await ponto.chegou.promessa;
        esperarConcluido(await desativar(alvo.email));
        ponto.liberacao.liberar();
        const erro = await refresh;
        expect(erro instanceof ApiException && erro.code).toBe(ERROR_CODES.USER_INACTIVE);
      } finally {
        liberarTudo(ponto);
      }
      expect(await validas(alvo.objectId)).toBe(0);
    });

    it("refresh parado DEPOIS de ler `ativo` (ainda true): conclui, mas o refresh token devolvido já nasce revogado; só o access token sobrevive até expirar", async () => {
      const alvo = await criarAdmin("corrida-refresh-2");
      const sessao = await login(alvo.email);
      const ponto = novoPonto();
      const original = tokens.marcarSubstituto.bind(tokens);
      restaurar.push(spyOn(tokens, "marcarSubstituto").mockImplementation(async (antigo, novo) => {
        ponto.chegou.liberar();
        await ponto.liberacao.promessa;
        return original(antigo, novo);
      }));

      let renovado: Awaited<ReturnType<AuthService["refresh"]>> | null = null;
      try {
        const refresh = auth.refresh({ refreshToken: sessao.refreshToken }, contexto);
        await ponto.chegou.promessa;
        esperarConcluido(await desativar(alvo.email));
        ponto.liberacao.liberar();
        renovado = await refresh;
      } finally {
        liberarTudo(ponto);
      }
      for (const espiao of restaurar.splice(0)) espiao.mockRestore();
      if (!renovado) throw new Error("o refresh deveria ter concluído");

      expect(await validas(alvo.objectId)).toBe(0);
      expect(await falhaDe(auth.refresh({ refreshToken: renovado.refreshToken }, contexto))).toBeInstanceOf(ApiException);
      expect((await verificarAccessToken(renovado.accessToken)).sub).toBe(alvo.id); // resíduo do JWT stateless
    });

    it("login parado ANTES de gravar a sessão (já passou da senha): a releitura vê inativo, revoga a sessão nova e recusa", async () => {
      const alvo = await criarAdmin("corrida-login-1");
      const ponto = novoPonto();
      const original = tokens.criar.bind(tokens);
      let pausar = true;
      restaurar.push(spyOn(tokens, "criar").mockImplementation(async (dados) => {
        if (pausar) {
          pausar = false;
          ponto.chegou.liberar();
          await ponto.liberacao.promessa;
        }
        return original(dados);
      }));

      try {
        const tentativa = falhaDe(login(alvo.email));
        await ponto.chegou.promessa;
        esperarConcluido(await desativar(alvo.email));
        ponto.liberacao.liberar();
        const erro = await tentativa;
        expect(erro instanceof ApiException && erro.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
      } finally {
        liberarTudo(ponto);
      }
      expect(await validas(alvo.objectId)).toBe(0);
      expect(await connection.collection("refresh_tokens").countDocuments({ usuarioId: alvo.objectId })).toBe(1); // a sessão existiu, revogada
    });

    it("login parado DEPOIS de gravar a sessão e ANTES da releitura: a revogação da desativação a alcança; o login é recusado", async () => {
      const alvo = await criarAdmin("corrida-login-2");
      const ponto = novoPonto();
      const original = usuarios.encontrarPorId.bind(usuarios);
      let pausar = true;
      restaurar.push(spyOn(usuarios, "encontrarPorId").mockImplementation(async (id) => {
        if (pausar) {
          pausar = false;
          ponto.chegou.liberar();
          await ponto.liberacao.promessa;
        }
        return original(id);
      }));

      try {
        const tentativa = falhaDe(login(alvo.email));
        await ponto.chegou.promessa;
        expect(await validas(alvo.objectId)).toBe(1); // a sessão do login já está gravada
        esperarConcluido(await desativar(alvo.email));
        ponto.liberacao.liberar();
        const erro = await tentativa;
        expect(erro instanceof ApiException && erro.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
      } finally {
        liberarTudo(ponto);
      }
      expect(await validas(alvo.objectId)).toBe(0);
    });

    it("duas desativações concorrentes: uma faz a transição, a outra não; exatamente UM evento ADMIN_DEACTIVATED", async () => {
      const alvo = await criarAdmin("dupla");
      await login(alvo.email);
      const resultados = await Promise.all([desativar(alvo.email), desativar(alvo.email)]);
      expect(resultados.map((resultado) => resultado.status).sort()).toEqual(["desativado", "ja_inativo"]);
      expect(await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED")).toHaveLength(1);
      expect(await validas(alvo.objectId)).toBe(0);
    });

    it("a outra desativação audita PRIMEIRO enquanto a vencedora está parada: ainda assim um único evento", async () => {
      const alvo = await criarAdmin("dupla-parada");
      const ponto = novoPonto();
      const original = usuarios.reivindicarAuditoriaDesativacao.bind(usuarios);
      let pausar = true;
      restaurar.push(spyOn(usuarios, "reivindicarAuditoriaDesativacao").mockImplementation(async (id, marca) => {
        if (pausar) {
          pausar = false;
          ponto.chegou.liberar();
          await ponto.liberacao.promessa;
        }
        return original(id, marca);
      }));

      let vencedora: ResultadoDesativacao | null = null;
      try {
        const primeira = desativar(alvo.email);
        await ponto.chegou.promessa;
        const segunda = esperarConcluido(await desativar(alvo.email));
        expect(segunda).toMatchObject({ status: "ja_inativo", auditoria: "reconciliada" });
        ponto.liberacao.liberar();
        vencedora = await primeira;
      } finally {
        liberarTudo(ponto);
      }
      if (!vencedora) throw new Error("a primeira desativação deveria ter concluído");
      expect(esperarConcluido(vencedora)).toMatchObject({ status: "desativado", auditoria: "ja_registrada" });
      expect(await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED")).toHaveLength(1);
    });
  });

  describe("concorrência real (estresse)", () => {
    it("20 rodadas de refresh + login + desativação simultâneos: depois de tudo, nenhuma sessão válida, login e refresh recusados", async () => {
      for (let rodada = 0; rodada < 20; rodada += 1) {
        const alvo = await criarAdmin(`estresse-${rodada}`);
        const sessao = await login(alvo.email);

        const [refresh, novoLogin, resultado] = await Promise.allSettled([
          auth.refresh({ refreshToken: sessao.refreshToken }, contexto),
          login(alvo.email),
          desativar(alvo.email),
        ]);

        expect(resultado.status).toBe("fulfilled");
        expect(await validas(alvo.objectId)).toBe(0);
        for (const tentativa of [refresh, novoLogin]) {
          if (tentativa.status === "fulfilled") expect(await falhaDe(auth.refresh({ refreshToken: tentativa.value.refreshToken }, contexto))).toBeInstanceOf(ApiException);
        }
        await esperarCodigo(login(alvo.email), ERROR_CODES.INVALID_CREDENTIALS);
        expect(await eventosDe(alvo.objectId, "ADMIN_DEACTIVATED")).toHaveLength(1);
      }
    }, 60_000); // argon2id real em cada seed/login, mais I/O de Mongo por rodada
  });
});
