import { describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { validateEnv } from "../../config/env.validation.js";
import {
  abrirSucessor,
  ChaveIdempotenciaInvalidaError,
  hashDaChave,
  hashesIguais,
  lerChaveIdempotencia,
  selarSucessor,
  TAMANHO_NONCE,
  TAMANHO_TAG,
  type ContextoSelo,
  type SucessorSelado,
} from "./recuperacao-refresh.crypto.js";

/**
 * Fase 22.8.7.2 — criptografia da recuperação idempotente (unitário, sem banco) e validação do segredo HMAC.
 * Todos os tokens, chaves e segredos são gerados aqui, só para o teste.
 */

const token = () => randomBytes(32).toString("base64url");
function contexto(sobrescrever: Partial<ContextoSelo> = {}): ContextoSelo {
  return {
    r1: token(),
    chave: randomUUID(),
    documentoId: new Types.ObjectId().toHexString(),
    usuarioId: new Types.ObjectId().toHexString(),
    familiaId: randomUUID(),
    ...sobrescrever,
  };
}
/** Troca um caractere de um campo base64url (adulteração mínima). */
function adulterar(valor: string): string {
  const bytes = Buffer.from(valor, "base64url");
  bytes[0] = bytes[0]! ^ 0x01;
  return bytes.toString("base64url");
}

describe("recuperação idempotente — criptografia (Fase 22.8.7.2)", () => {
  it("sela e abre o sucessor (round-trip) no formato v1 documentado", () => {
    const ctx = contexto();
    const R2 = token();
    const selo = selarSucessor(ctx, R2);
    expect(selo.v).toBe(1);
    expect(Buffer.from(selo.nonce, "base64url")).toHaveLength(TAMANHO_NONCE);
    expect(Buffer.from(selo.tag, "base64url")).toHaveLength(TAMANHO_TAG);
    for (const campo of [selo.nonce, selo.ct, selo.tag]) expect(campo).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(abrirSucessor(ctx, selo)).toBe(R2);
  });

  it("o material selado não contém R2, R1, a chave nem a família em claro (nem em base64url)", () => {
    const ctx = contexto();
    const R2 = token();
    const serializado = JSON.stringify(selarSucessor(ctx, R2));
    for (const segredo of [R2, ctx.r1, ctx.chave, ctx.familiaId]) {
      expect(serializado).not.toContain(segredo);
      expect(serializado).not.toContain(Buffer.from(segredo).toString("base64url"));
    }
  });

  it("nonce novo a cada selagem: o mesmo R2 com o mesmo contexto gera ciphertexts diferentes", () => {
    const ctx = contexto();
    const R2 = token();
    const a = selarSucessor(ctx, R2);
    const b = selarSucessor(ctx, R2);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ct).not.toBe(b.ct);
  });

  it("operações distintas derivam chaves distintas: outro R1, outra chave, outro documento → não abre", () => {
    const ctx = contexto();
    const selo = selarSucessor(ctx, token());
    expect(abrirSucessor({ ...ctx, r1: token() }, selo)).toBeNull();
    expect(abrirSucessor({ ...ctx, chave: randomUUID() }, selo)).toBeNull();
    expect(abrirSucessor({ ...ctx, documentoId: new Types.ObjectId().toHexString() }, selo)).toBeNull();
  });

  it("adulterar ciphertext, nonce ou tag falha a autenticação GCM (null, nunca valor parcial)", () => {
    const ctx = contexto();
    const selo = selarSucessor(ctx, token());
    expect(abrirSucessor(ctx, { ...selo, ct: adulterar(selo.ct) })).toBeNull();
    expect(abrirSucessor(ctx, { ...selo, nonce: adulterar(selo.nonce) })).toBeNull();
    expect(abrirSucessor(ctx, { ...selo, tag: adulterar(selo.tag) })).toBeNull();
  });

  it("alterar qualquer dado autenticado (AAD: usuarioId, familiaId) falha", () => {
    const ctx = contexto();
    const selo = selarSucessor(ctx, token());
    expect(abrirSucessor({ ...ctx, usuarioId: new Types.ObjectId().toHexString() }, selo)).toBeNull();
    expect(abrirSucessor({ ...ctx, familiaId: randomUUID() }, selo)).toBeNull();
  });

  it("versão desconhecida, campos ausentes, malformados ou com tamanho errado são rejeitados", () => {
    const ctx = contexto();
    const selo = selarSucessor(ctx, token());
    const invalidos: unknown[] = [
      null,
      undefined,
      { ...selo, v: 2 },
      { ...selo, v: 0 },
      { ...selo, nonce: undefined },
      { ...selo, ct: "" },
      { ...selo, tag: "não-base64url!" },
      { ...selo, nonce: randomBytes(16).toString("base64url") },
      { ...selo, tag: randomBytes(12).toString("base64url") },
    ];
    for (const selado of invalidos) expect(abrirSucessor(ctx, selado as SucessorSelado)).toBeNull();
  });

  it("chave de idempotência incorreta não recupera R2", () => {
    const ctx = contexto();
    const selo = selarSucessor(ctx, token());
    expect(abrirSucessor({ ...ctx, chave: randomUUID() }, selo)).toBeNull();
  });

  it("HMAC da chave: depende do segredo e da chave; comparação em tempo constante tolera tamanhos diferentes", () => {
    const segredoA = randomBytes(48).toString("base64url");
    const segredoB = randomBytes(48).toString("base64url");
    const chave = randomUUID();
    const hash = hashDaChave(segredoA, chave);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(chave);
    expect(hashDaChave(segredoA, chave)).toBe(hash);
    expect(hashDaChave(segredoB, chave)).not.toBe(hash);
    expect(hashDaChave(segredoA, randomUUID())).not.toBe(hash);
    expect(hashesIguais(hash, hashDaChave(segredoA, chave))).toBe(true);
    expect(hashesIguais(hash, hashDaChave(segredoB, chave))).toBe(false);
    expect(hashesIguais(hash, hash.slice(0, 10))).toBe(false);
  });
});

describe("Idempotency-Key — leitura e validação do cabeçalho", () => {
  it("ausente → null (cliente antigo); UUID canônico → normalizado em minúsculas", () => {
    expect(lerChaveIdempotencia(undefined)).toBeNull();
    const chave = randomUUID();
    expect(lerChaveIdempotencia(chave)).toBe(chave);
    expect(lerChaveIdempotencia(chave.toUpperCase())).toBe(chave);
  });

  it("vazio, curto, longo, com chaves, repetido ou malformado → erro sem ecoar o valor", () => {
    const chave = randomUUID();
    const invalidos = [
      "",
      " ",
      "abc",
      `${chave}0`,
      `{${chave}}`,
      `${chave}, ${chave}`,
      chave.replace(/-/g, ""),
      "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz",
      "00000000-0000-0000-0000-000000000000",
      "x".repeat(10_000),
    ];
    for (const valor of invalidos) {
      let erro: unknown;
      try {
        lerChaveIdempotencia(valor);
      } catch (e) {
        erro = e;
      }
      expect(erro).toBeInstanceOf(ChaveIdempotenciaInvalidaError);
      if (valor.trim()) expect((erro as Error).message).not.toContain(valor);
    }
  });
});

describe("REFRESH_IDEMPOTENCIA_HMAC_SECRET — validação de ambiente (sem fallback)", () => {
  const base = {
    NODE_ENV: "test",
    MONGODB_URI: "mongodb://127.0.0.1:27017/validacao_ficticia",
    JWT_ACCESS_SECRET: "access-ficticio-para-validacao-de-ambiente",
    JWT_REFRESH_SECRET: "refresh-ficticio-para-validacao-de-ambiente",
    PDV_JWT_ACCESS_SECRET: "pdv-access-ficticio-para-validacao",
    PDV_JWT_REFRESH_SECRET: "pdv-refresh-ficticio-para-validacao",
  };

  it("ausente ou vazio: aceito (mecanismo desligado, comportamento da Fase 22.8.7.1)", () => {
    expect(() => validateEnv({ ...base })).not.toThrow();
    expect(() => validateEnv({ ...base, REFRESH_IDEMPOTENCIA_HMAC_SECRET: "" })).not.toThrow();
  });

  it("presente e forte (≥ 32, distinto dos segredos JWT): aceito", () => {
    expect(() => validateEnv({ ...base, REFRESH_IDEMPOTENCIA_HMAC_SECRET: randomBytes(48).toString("base64url") })).not.toThrow();
  });

  it("presente mas curto ou só espaços: o boot falha — nunca liga o mecanismo com segredo fraco", () => {
    for (const fraco of ["curto", " ".repeat(40), `  ${"a".repeat(20)}  `]) {
      expect(() => validateEnv({ ...base, REFRESH_IDEMPOTENCIA_HMAC_SECRET: fraco })).toThrow(/REFRESH_IDEMPOTENCIA_HMAC_SECRET/);
    }
  });

  it("reutilizar qualquer segredo JWT: o boot falha, e a mensagem não contém o valor", () => {
    for (const campo of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "PDV_JWT_ACCESS_SECRET", "PDV_JWT_REFRESH_SECRET"] as const) {
      const valor = `${base[campo]}-com-tamanho-suficiente`;
      let mensagem = "";
      try {
        validateEnv({ ...base, [campo]: valor, REFRESH_IDEMPOTENCIA_HMAC_SECRET: valor });
      } catch (erro) {
        mensagem = (erro as Error).message;
      }
      expect(mensagem).toContain(campo);
      expect(mensagem).not.toContain(valor);
    }
  });
});
