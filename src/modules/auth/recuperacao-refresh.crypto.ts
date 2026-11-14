import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Fase 22.8.7.2 — criptografia da RECUPERAÇÃO IDEMPOTENTE da rotação do refresh token administrativo (cenário 10c:
 * o Backend rotacionou R1 → R2, mas a resposta se perdeu; o cliente repete R1 com a MESMA `Idempotency-Key`).
 *
 * Funções puras, sem I/O e sem log. Nada aqui registra, devolve em erro ou persiste R1, R2, a chave de idempotência
 * ou a chave derivada.
 *
 * ─── Hash da chave de idempotência ────────────────────────────────────────────────────────────────────────────────
 *   chaveHash = HMAC-SHA256(REFRESH_IDEMPOTENCIA_HMAC_SECRET, "mariela/refresh-idempotencia/v1|" ‖ chave), em hex
 *   (64 caracteres). Segredo PRÓPRIO, independente dos segredos JWT. Comparação em tempo constante.
 *
 * ─── Selagem do sucessor R2 (formato v1) ─────────────────────────────────────────────────────────────────────────
 *   chave AES = HKDF-SHA256(ikm = R1 (UTF-8), salt = _id do documento de R1 (12 bytes do ObjectId),
 *                           info = "mariela/refresh-recuperacao/v1|" ‖ chave de idempotência, L = 32 bytes)
 *   AES-256-GCM, nonce aleatório de 12 bytes NOVO a cada selagem, tag de 16 bytes,
 *   AAD = "mariela/refresh-recuperacao/v1|<_id hex>|<usuarioId hex>|<familiaId>" (campos de tamanho fixo/sem "|")
 *   plaintext = R2 (UTF-8).
 *   Persistido como subdocumento { v: 1, nonce, ct, tag }, cada binário em base64url sem padding.
 *
 *   O servidor nunca guarda R1 nem a chave de idempotência em claro (só HMACs) — então quem tiver SÓ o banco não
 *   consegue derivar a chave AES nem abrir R2. Só quem apresenta R1 E a chave correta abre o sucessor. A chave
 *   derivada vive apenas na memória da requisição.
 */

export const VERSAO_SELO = 1 as const;
export const TAMANHO_NONCE = 12;
export const TAMANHO_TAG = 16;
const ROTULO_HMAC = "mariela/refresh-idempotencia/v1|";
const ROTULO_HKDF = "mariela/refresh-recuperacao/v1|";
const ALGORITMO = "aes-256-gcm";

/** UUID canônico (RFC 9562, versões 1–8, variante 10xx), 36 caracteres — o formato de `crypto.randomUUID()`. */
const FORMATO_CHAVE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;

export interface SucessorSelado {
  v: number;
  nonce: string;
  ct: string;
  tag: string;
}

export interface ContextoSelo {
  /** Refresh token apresentado (R1) — material de entrada do HKDF. */
  r1: string;
  /** `Idempotency-Key` já normalizada. */
  chave: string;
  /** `_id` (hex) do documento de R1. */
  documentoId: string;
  /** `usuarioId` (hex) do documento de R1. */
  usuarioId: string;
  /** `familiaId` do documento de R1. */
  familiaId: string;
}

export class ChaveIdempotenciaInvalidaError extends Error {
  constructor() {
    super("Idempotency-Key inválida: use um UUID canônico (36 caracteres).");
    this.name = "ChaveIdempotenciaInvalidaError";
  }
}

/**
 * Lê o cabeçalho `Idempotency-Key`: ausente → `null` (cliente antigo, sem recuperação). Presente → precisa ser um UUID
 * canônico de 36 caracteres (maiúsculas aceitas, normalizado para minúsculas); vazio, longo, repetido (o Node junta
 * valores repetidos com ", ") ou malformado → `ChaveIdempotenciaInvalidaError`. Nunca inclui o valor no erro.
 */
export function lerChaveIdempotencia(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== "string" || valor.length !== 36) throw new ChaveIdempotenciaInvalidaError();
  const normalizada = valor.toLowerCase();
  if (!FORMATO_CHAVE.test(normalizada)) throw new ChaveIdempotenciaInvalidaError();
  return normalizada;
}

export function hashDaChave(segredoHmac: string, chave: string): string {
  return createHmac("sha256", segredoHmac).update(ROTULO_HMAC + chave, "utf8").digest("hex");
}

/** Comparação em tempo constante de dois hashes hex; tamanhos diferentes → `false` (sem lançar). */
export function hashesIguais(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

function validarContexto(contexto: ContextoSelo): void {
  if (!OBJECT_ID_HEX.test(contexto.documentoId) || !OBJECT_ID_HEX.test(contexto.usuarioId)) {
    throw new Error("Contexto de selagem inválido.");
  }
  if (!contexto.familiaId || contexto.familiaId.includes("|") || !contexto.r1 || !contexto.chave) {
    throw new Error("Contexto de selagem inválido.");
  }
}

function derivarChave(contexto: ContextoSelo): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(contexto.r1, "utf8"),
      Buffer.from(contexto.documentoId, "hex"),
      Buffer.from(ROTULO_HKDF + contexto.chave, "utf8"),
      32,
    ),
  );
}

function dadosAssociados(contexto: ContextoSelo): Buffer {
  return Buffer.from(`${ROTULO_HKDF}${contexto.documentoId}|${contexto.usuarioId}|${contexto.familiaId}`, "utf8");
}

export function selarSucessor(contexto: ContextoSelo, sucessor: string): SucessorSelado {
  validarContexto(contexto);
  const chaveAes = derivarChave(contexto);
  try {
    const nonce = randomBytes(TAMANHO_NONCE);
    const cifra = createCipheriv(ALGORITMO, chaveAes, nonce, { authTagLength: TAMANHO_TAG });
    cifra.setAAD(dadosAssociados(contexto));
    const ct = Buffer.concat([cifra.update(sucessor, "utf8"), cifra.final()]);
    return {
      v: VERSAO_SELO,
      nonce: nonce.toString("base64url"),
      ct: ct.toString("base64url"),
      tag: cifra.getAuthTag().toString("base64url"),
    };
  } finally {
    chaveAes.fill(0);
  }
}

/**
 * Abre o sucessor. QUALQUER problema — versão desconhecida, campos ausentes/malformados, tamanhos errados, R1/chave/
 * contexto diferentes, ciphertext/nonce/tag/AAD adulterados — devolve `null`: nunca um valor parcial, nunca lança com
 * material sensível. `decipher.final()` só conclui se a tag GCM autenticar.
 */
export function abrirSucessor(contexto: ContextoSelo, selado: SucessorSelado | null | undefined): string | null {
  if (!selado || selado.v !== VERSAO_SELO) return null;
  const { nonce, ct, tag } = selado;
  if (typeof nonce !== "string" || typeof ct !== "string" || typeof tag !== "string") return null;
  if (!BASE64URL.test(nonce) || !BASE64URL.test(ct) || !BASE64URL.test(tag)) return null;
  const nonceBytes = Buffer.from(nonce, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  const ctBytes = Buffer.from(ct, "base64url");
  if (nonceBytes.length !== TAMANHO_NONCE || tagBytes.length !== TAMANHO_TAG || ctBytes.length === 0) return null;
  try {
    validarContexto(contexto);
  } catch {
    return null;
  }
  const chaveAes = derivarChave(contexto);
  try {
    const decifra = createDecipheriv(ALGORITMO, chaveAes, nonceBytes, { authTagLength: TAMANHO_TAG });
    decifra.setAAD(dadosAssociados(contexto));
    decifra.setAuthTag(tagBytes);
    const aberto = Buffer.concat([decifra.update(ctBytes), decifra.final()]);
    return aberto.toString("utf8");
  } catch {
    return null;
  } finally {
    chaveAes.fill(0);
  }
}
