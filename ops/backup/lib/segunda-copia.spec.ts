import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256DoArquivo } from "./archive.js";
import {
  criarTransporteGoogleDrive,
  enviarEVerificar,
  iniciarRegistro,
  registrarCifrado,
  registrarEnviado,
  registrarVerificado,
  TransicaoInvalidaErro,
  type RegistroSegundaCopia,
  type TransporteRemoto,
} from "./segunda-copia.js";

/** Fase 60.4.3.4.21.2 — a segunda cópia só chega a VERIFICADO_NUVEM com download + SHA-256 igual (transportes falsos). */

const AGORA = new Date("2026-11-09T23:59:00-03:00");
let dir: string;
let cifrado: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "segunda-copia-"));
  cifrado = join(dir, "mariela_prod_20261109_234500.7z");
  writeFileSync(cifrado, Buffer.from("conteudo-cifrado-sintetico".repeat(100)));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function registroCifrado(): Promise<RegistroSegundaCopia> {
  const r = iniciarRegistro("mariela_prod_20261109_234500", "A".repeat(64), AGORA);
  return registrarCifrado(r, { arquivoCifrado: cifrado, sha256Cifrado: await sha256DoArquivo(cifrado), tamanhoCifrado: statSync(cifrado).size }, AGORA);
}

/** "Nuvem" de mentira numa pasta, com defeitos configuráveis. */
function transporte(defeito: "nenhum" | "nao_existe" | "tamanho_errado" | "download_corrompido" | "upload_lanca"): TransporteRemoto {
  const remoto = join(dir, "remoto.bin");
  return {
    nome: `falso:${defeito}`,
    async enviar(caminho) {
      if (defeito === "upload_lanca") throw new Error("HTTP 500");
      if (defeito !== "nao_existe") copyFileSync(caminho, remoto);
      return { idRemoto: "id-1" };
    },
    async consultar() {
      if (defeito === "nao_existe") return { existe: false, tamanho: null };
      const t = statSync(remoto).size;
      return { existe: true, tamanho: defeito === "tamanho_errado" ? t + 1 : t };
    },
    async baixar(_id, destino) {
      copyFileSync(remoto, destino);
      if (defeito === "download_corrompido") writeFileSync(destino, Buffer.alloc(statSync(remoto).size, 0x41));
    },
  };
}

describe("segunda cópia — estados", () => {
  it("caminho feliz: VALIDO_LOCAL → CIFRADO → ENVIADO → VERIFICADO_NUVEM, com histórico de evidências", async () => {
    const r = await enviarEVerificar(await registroCifrado(), transporte("nenhum"), join(dir, "baixado.bin"), () => AGORA);
    expect(r.estado).toBe("VERIFICADO_NUVEM");
    expect(r.falha).toBeNull();
    expect(r.sha256Baixado).toBe(r.sha256Cifrado!);
    expect(r.historico.map((h) => h.estado)).toEqual(["VALIDO_LOCAL", "CIFRADO", "ENVIADO", "VERIFICADO_NUVEM"]);
  });

  it("upload 'ok' mas arquivo remoto inexistente → continua CIFRADO", async () => {
    const r = await enviarEVerificar(await registroCifrado(), transporte("nao_existe"), join(dir, "b.bin"), () => AGORA);
    expect(r.estado).toBe("CIFRADO");
    expect(r.falha).toContain("inexistente");
  });

  it("tamanho remoto diferente → continua CIFRADO", async () => {
    const r = await enviarEVerificar(await registroCifrado(), transporte("tamanho_errado"), join(dir, "b.bin"), () => AGORA);
    expect(r.estado).toBe("CIFRADO");
  });

  it("download de verificação com hash diferente → fica ENVIADO, NUNCA verificado", async () => {
    const r = await enviarEVerificar(await registroCifrado(), transporte("download_corrompido"), join(dir, "b.bin"), () => AGORA);
    expect(r.estado).toBe("ENVIADO");
    expect(r.falha).toContain("SHA-256");
  });

  it("erro no upload → continua CIFRADO com a falha registrada", async () => {
    const r = await enviarEVerificar(await registroCifrado(), transporte("upload_lanca"), join(dir, "b.bin"), () => AGORA);
    expect(r.estado).toBe("CIFRADO");
    expect(r.falha).toBe("HTTP 500");
  });

  it("transições fora de ordem ou sem evidência são recusadas", async () => {
    const inicial = iniciarRegistro("x", "A".repeat(64), AGORA);
    expect(() => registrarEnviado(inicial, { idRemoto: "a", existe: true, tamanhoRemoto: 1 }, AGORA)).toThrow(TransicaoInvalidaErro);
    expect(() => registrarVerificado(inicial, { sha256Baixado: "A".repeat(64) }, AGORA)).toThrow(TransicaoInvalidaErro);
    expect(() => registrarCifrado(inicial, { arquivoCifrado: "x", sha256Cifrado: "nao-hex", tamanhoCifrado: 1 }, AGORA)).toThrow(TransicaoInvalidaErro);
    expect(() => registrarCifrado(inicial, { arquivoCifrado: "x", sha256Cifrado: "A".repeat(64), tamanhoCifrado: 0 }, AGORA)).toThrow(TransicaoInvalidaErro);
  });

  it("Google Drive: transporte NÃO implementado nesta fase — recusa explicitamente", () => {
    expect(() => criarTransporteGoogleDrive()).toThrow(/BLOQUEADO/);
  });
});
