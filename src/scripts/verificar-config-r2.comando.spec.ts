import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { fileURLToPath } from "node:url";
import type { AmbienteDeExecucao } from "./comando-local.util.js";
import { CODIGOS_DE_SAIDA, executarComando } from "./verificar-config-r2.comando.js";

/** Fase 60.4.1 — verificação offline da configuração do R2 (valores fictícios; nenhuma rede). */

const EXECUCAO_LOCAL: AmbienteDeExecucao = {
  arquivoDeEntrada: fileURLToPath(new URL("./verificar-config-r2.ts", import.meta.url)),
  variaveis: {},
  existeArquivo: () => false,
};
const VALIDAS = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "fedcba9876543210fedcba9876543210",
  R2_SECRET_ACCESS_KEY: "a".repeat(64),
  R2_BUCKET_NAME: "mariela-midia-teste",
  R2_PUBLIC_BASE_URL: "https://midia.exemplo.com",
};

function executar(variaveis: Record<string, string>, opcoes: { argv?: string[]; execucao?: AmbienteDeExecucao } = {}) {
  const saida: string[] = [];
  const codigo = executarComando({ argv: opcoes.argv ?? [], variaveis, escrever: (linha) => saida.push(linha), execucao: opcoes.execucao ?? EXECUCAO_LOCAL });
  return { codigo, texto: saida.join("\n") };
}

describe("comando verificar-config-r2 (Fase 60.4.1)", () => {
  let chamadasDeRede = 0;
  const espioes: { mockRestore(): void }[] = [];
  beforeEach(() => {
    chamadasDeRede = 0;
    // O comando nem importa o SDK; este espião só prova que nenhuma chamada ao storage acontece.
    espioes.push(
      spyOn(S3Client.prototype, "send").mockImplementation(async () => {
        chamadasDeRede += 1;
        throw new Error("rede proibida neste teste");
      }),
    );
  });
  afterEach(() => {
    for (const espiao of espioes.splice(0)) espiao.mockRestore();
  });

  it("configuração completa e válida: sucesso, padrões de transporte, e nenhum valor das variáveis R2 impresso", () => {
    const { codigo, texto } = executar(VALIDAS);
    expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
    expect(texto).toContain("[OK] R2_BUCKET_NAME: presente, nome válido");
    expect(texto).toContain("R2_MAX_ATTEMPTS: não definida — padrão do projeto 2");
    expect(texto).toContain("Prazo por tentativa: 13000 ms; tentativas: 2");
    expect(texto).toContain("NÃO verificado por este comando");
    for (const valor of Object.values(VALIDAS)) expect(texto).not.toContain(valor);
    expect(chamadasDeRede).toBe(0);
  });

  it("variáveis ausentes são erros (código 1) e citadas só pelo nome", () => {
    const { codigo, texto } = executar({ R2_ACCOUNT_ID: VALIDAS.R2_ACCOUNT_ID });
    expect(codigo).toBe(CODIGOS_DE_SAIDA.configuracaoInvalida);
    for (const nome of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_BASE_URL"]) expect(texto).toContain(`[ERRO] ${nome}: ausente`);
    expect(chamadasDeRede).toBe(0);
  });

  it("formato: bucket e base pública inválidos são erros; formatos incomuns de conta/chave são só avisos; http e caminho na base geram aviso", () => {
    const invalido = executar({ ...VALIDAS, R2_BUCKET_NAME: "Bucket_Errado", R2_PUBLIC_BASE_URL: "midia.exemplo.com" });
    expect(invalido.codigo).toBe(CODIGOS_DE_SAIDA.configuracaoInvalida);
    expect(invalido.texto).toContain("[ERRO] R2_BUCKET_NAME: nome inválido");
    expect(invalido.texto).toContain("[ERRO] R2_PUBLIC_BASE_URL: formato inválido");

    const incomum = executar({ ...VALIDAS, R2_ACCOUNT_ID: "conta-x", R2_ACCESS_KEY_ID: "curta", R2_SECRET_ACCESS_KEY: "curto", R2_PUBLIC_BASE_URL: "http://midia.exemplo.com/sub/" });
    expect(incomum.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
    expect(incomum.texto).toContain("[AVISO] R2_ACCOUNT_ID");
    expect(incomum.texto).toContain("[AVISO] R2_ACCESS_KEY_ID");
    expect(incomum.texto).toContain("[AVISO] R2_SECRET_ACCESS_KEY");
    expect(incomum.texto).toContain("usa http");
    expect(incomum.texto).toContain("tem caminho");
    for (const valor of ["conta-x", "curta", "curto", "/sub"]) expect(incomum.texto).not.toContain(valor);
  });

  it("transporte: sobrescritas válidas aparecem; fora da faixa ou não inteiras são erros", () => {
    const ok = executar({ ...VALIDAS, R2_CONNECTION_TIMEOUT_MS: "1500", R2_REQUEST_TIMEOUT_MS: "4000", R2_MAX_ATTEMPTS: "3" });
    expect(ok.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
    expect(ok.texto).toContain("Prazo por tentativa: 5500 ms; tentativas: 3");
    const ruim = executar({ ...VALIDAS, R2_MAX_ATTEMPTS: "9", R2_REQUEST_TIMEOUT_MS: "x" });
    expect(ruim.codigo).toBe(CODIGOS_DE_SAIDA.configuracaoInvalida);
    expect(ruim.texto).toContain("[ERRO] R2_MAX_ATTEMPTS: inválida (inteiro entre 1 e 5)");
    expect(ruim.texto).toContain("[ERRO] R2_REQUEST_TIMEOUT_MS: inválida");
  });

  it("recusa parâmetros e execução fora da máquina do operador (artefato compilado, produção, Render, Docker)", () => {
    expect(executar(VALIDAS, { argv: ["--apply"] }).codigo).toBe(CODIGOS_DE_SAIDA.recusado);
    expect(executar(VALIDAS, { argv: [VALIDAS.R2_SECRET_ACCESS_KEY] }).texto).not.toContain(VALIDAS.R2_SECRET_ACCESS_KEY);
    for (const execucao of [
      { ...EXECUCAO_LOCAL, arquivoDeEntrada: "/app/dist/scripts/verificar-config-r2.js" },
      { ...EXECUCAO_LOCAL, variaveis: { NODE_ENV: "production" } },
      { ...EXECUCAO_LOCAL, variaveis: { RENDER_SERVICE_ID: "srv" } },
      { ...EXECUCAO_LOCAL, existeArquivo: (caminho: string) => caminho === "/.dockerenv" },
    ]) {
      expect(executar(VALIDAS, { execucao }).codigo).toBe(CODIGOS_DE_SAIDA.recusado);
    }
    expect(chamadasDeRede).toBe(0);
  });
});
