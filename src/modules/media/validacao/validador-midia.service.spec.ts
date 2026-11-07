import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { fileURLToPath } from "node:url";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import { arquivoDoFormato, fixtureDeMidia, FIXTURES_MIDIA } from "../../../test-utils/media-storage-falso.util.js";
import { CONCORRENCIA_VALIDACAO_MIDIA, PRAZO_VALIDACAO_MIDIA_MS } from "./validacao-midia.constants.js";
import { ValidadorMidiaService } from "./validador-midia.service.js";

/**
 * Fase 60.4.3.4.1 — o validador num SUBPROCESSO real (`bun --no-env-file`). Os cenários de falha usam scripts
 * falsos em `test-utils/validador-midia-falso/` no lugar do script real (opção `script`).
 */
const falso = (nome: string) => fileURLToPath(new URL(`../../../test-utils/validador-midia-falso/${nome}.ts`, import.meta.url));

async function erroApi(promessa: Promise<unknown>): Promise<ApiException> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof ApiException) return erro;
    throw erro;
  }
  throw new Error("Esperava uma ApiException, mas a validação concluiu.");
}

describe("ValidadorMidiaService — subprocesso isolado (Fase 60.4.3.4.1)", () => {
  const SEGREDO = "SEGREDO_DE_TESTE_DO_VALIDADOR";
  beforeAll(() => {
    process.env[SEGREDO] = "nunca-pode-chegar-ao-subprocesso";
  });
  afterAll(() => {
    delete process.env[SEGREDO];
  });

  it("padrões aprovados: prazo total de 10 s e 1 validação simultânea (Fase 60.4.3.4.3; era 2)", () => {
    expect(PRAZO_VALIDACAO_MIDIA_MS).toBe(10_000);
    expect(CONCORRENCIA_VALIDACAO_MIDIA).toBe(1);
  });

  it("script real: aceita os 5 formatos e o MP4 fragmentado; recusa o N8 (sem lançar exceção)", async () => {
    const validador = new ValidadorMidiaService();
    for (const formato of ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"]) {
      expect((await validador.validar(formato, arquivoDoFormato(formato, 1024))).valido).toBe(true);
    }
    expect((await validador.validar("video/mp4", fixtureDeMidia(FIXTURES_MIDIA.mp4Fragmentado))).valido).toBe(true);
    expect(await validador.validar("image/jpeg", fixtureDeMidia(FIXTURES_MIDIA.n8))).toMatchObject({ valido: false, motivo: "estrutura" });
    expect(validador.emExecucao).toBe(0);
  });

  it("script real com o arquivo no limite (5 MiB) responde dentro do prazo", async () => {
    const inicio = performance.now();
    expect((await new ValidadorMidiaService().validar("image/jpeg", arquivoDoFormato("image/jpeg", 5 * 1024 * 1024))).valido).toBe(true);
    expect(performance.now() - inicio).toBeLessThan(PRAZO_VALIDACAO_MIDIA_MS);
  });

  it("prazo esgotado: o subprocesso travado é encerrado e a resposta é 503 MEDIA_VALIDATION_UNAVAILABLE", async () => {
    const validador = new ValidadorMidiaService({ script: falso("processo-travado"), prazoMs: 500 });
    const inicio = performance.now();
    const erro = await erroApi(validador.validar("image/jpeg", arquivoDoFormato("image/jpeg", 1024)));
    const decorrido = performance.now() - inicio;
    expect(erro.getStatus()).toBe(503);
    expect(erro.code).toBe("MEDIA_VALIDATION_UNAVAILABLE");
    expect(decorrido).toBeGreaterThanOrEqual(450);
    expect(decorrido).toBeLessThan(3_000);
    expect(validador.emExecucao).toBe(0);
  });

  it("falha do subprocesso (crash / código ≠ 0) é 503, nunca 'arquivo válido'", async () => {
    const erro = await erroApi(new ValidadorMidiaService({ script: falso("processo-quebrado") }).validar("image/jpeg", arquivoDoFormato("image/jpeg", 1024)));
    expect(erro.getStatus()).toBe(503);
    expect(erro.code).toBe("MEDIA_VALIDATION_UNAVAILABLE");
    expect(erro.message).not.toContain("decodificador");
  });

  it("resposta fora do protocolo é 503", async () => {
    const erro = await erroApi(new ValidadorMidiaService({ script: falso("processo-lixo") }).validar("image/jpeg", arquivoDoFormato("image/jpeg", 1024)));
    expect(erro.code).toBe("MEDIA_VALIDATION_UNAVAILABLE");
  });

  it("script inexistente (falha ao iniciar ou sair) é 503", async () => {
    const erro = await erroApi(new ValidadorMidiaService({ script: falso("nao-existe") }).validar("image/jpeg", arquivoDoFormato("image/jpeg", 1024)));
    expect(erro.code).toBe("MEDIA_VALIDATION_UNAVAILABLE");
  });

  // Fase 60.4.3.4.3 — o padrão passou a 1; este teste fixa `concorrencia: 2` explicitamente para continuar provando que o
  // semáforo respeita um limite N > 1 (a asserção original, "nunca mais de 2", é mantida). O padrão 1 é coberto abaixo.
  it("concorrência (semáforo com limite explícito 2): com 6 validações simultâneas, nunca mais de 2 subprocessos ao mesmo tempo; todas concluem", async () => {
    const validador = new ValidadorMidiaService({ script: falso("processo-lento"), concorrencia: 2 });
    let maximo = 0;
    const monitor = setInterval(() => {
      maximo = Math.max(maximo, validador.emExecucao);
    }, 5);
    try {
      const resultados = await Promise.all(Array.from({ length: 6 }, () => validador.validar("image/jpeg", arquivoDoFormato("image/jpeg", 1024))));
      expect(resultados.every((resultado) => resultado.valido)).toBe(true);
    } finally {
      clearInterval(monitor);
    }
    expect(maximo).toBe(2);
    expect(validador.emExecucao).toBe(0);
  });

  it("fila: quem não consegue vaga dentro do prazo recebe 503 sem iniciar subprocesso; a vaga é devolvida", async () => {
    const validador = new ValidadorMidiaService({ script: falso("processo-lento"), concorrencia: 1, prazoMs: 250 });
    const [primeira, segunda] = await Promise.allSettled([
      validador.validar("image/jpeg", arquivoDoFormato("image/jpeg", 1024)),
      validador.validar("image/jpeg", arquivoDoFormato("image/jpeg", 1024)),
    ]);
    // A primeira (400 ms) estoura o prazo de 250 ms; a segunda nem chega a rodar.
    for (const resultado of [primeira, segunda]) {
      expect(resultado.status).toBe("rejected");
      if (resultado.status === "rejected") expect(resultado.reason).toMatchObject({ code: "MEDIA_VALIDATION_UNAVAILABLE" });
    }
    expect(validador.emExecucao).toBe(0);
  });

  it("o subprocesso recebe ambiente MÍNIMO: nenhuma variável de segredo (banco, JWT, R2) chega a ele", async () => {
    process.env["MONGODB_URI"] ??= "mongodb://ficticio/teste";
    const resultado = await new ValidadorMidiaService({ script: falso("processo-ambiente") }).validar("image/jpeg", arquivoDoFormato("image/jpeg", 1024));
    expect(resultado.valido).toBe(false);
    const nomes = resultado.valido ? [] : resultado.detalhe.split(",");
    expect(nomes).not.toContain(SEGREDO);
    for (const proibida of ["MONGODB_URI", "JWT_SECRET", "JWT_ACCESS_SECRET", "R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID"]) expect(nomes).not.toContain(proibida);
  });

  /**
   * Fase 60.4.3.4.3 — UMA validação por vez (o padrão, sem a opção `concorrencia`). O script `processo-roteiro` muda de
   * comportamento pelo MIME, então a MESMA instância (a mesma fila) alterna sucesso, recusa, erro e travamento.
   * `teste/carimbo` devolve o início e o fim medidos DENTRO do subprocesso: a prova de que os subprocessos não se sobrepõem.
   */
  describe("limite padrão de uma validação simultânea (Fase 60.4.3.4.3)", () => {
    const BYTES = arquivoDoFormato("image/jpeg", 1024);
    const intervalo = (resultado: Awaited<ReturnType<ValidadorMidiaService["validar"]>>): [number, number] => {
      if (resultado.valido) throw new Error("esperava o carimbo do subprocesso");
      const [inicio, fim] = resultado.detalhe.split("-").map(Number);
      return [inicio!, fim!];
    };

    it("uma validação executa normalmente e devolve a vaga", async () => {
      const validador = new ValidadorMidiaService({ script: falso("processo-roteiro") });
      expect(await validador.validar("image/jpeg", BYTES)).toMatchObject({ valido: true });
      expect(validador.emExecucao).toBe(0);
    });

    it("3 solicitações simultâneas: a 2ª só começa depois que a 1ª termina, a 3ª depois da 2ª; nunca mais de 1 ativa", async () => {
      const validador = new ValidadorMidiaService({ script: falso("processo-roteiro") });
      let maximo = 0;
      const monitor = setInterval(() => {
        maximo = Math.max(maximo, validador.emExecucao);
      }, 2);
      let resultados: Awaited<ReturnType<ValidadorMidiaService["validar"]>>[];
      try {
        resultados = await Promise.all([1, 2, 3].map(() => validador.validar("teste/carimbo", BYTES)));
      } finally {
        clearInterval(monitor);
      }
      const intervalos = resultados.map(intervalo).sort((a, b) => a[0] - b[0]);
      expect(intervalos[1]![0]).toBeGreaterThanOrEqual(intervalos[0]![1]);
      expect(intervalos[2]![0]).toBeGreaterThanOrEqual(intervalos[1]![1]);
      expect(maximo).toBe(1);
      expect(validador.emExecucao).toBe(0);
    });

    it("a fila libera após sucesso, arquivo inválido e erro do subprocesso: as solicitações seguintes executam", async () => {
      const validador = new ValidadorMidiaService({ script: falso("processo-roteiro") });
      const [sucesso, invalido, erro, depois] = await Promise.allSettled([
        validador.validar("image/jpeg", BYTES),
        validador.validar("teste/carimbo", BYTES),
        validador.validar("teste/quebrar", BYTES),
        validador.validar("image/jpeg", BYTES),
      ]);
      expect(sucesso).toMatchObject({ status: "fulfilled", value: { valido: true } });
      expect(invalido).toMatchObject({ status: "fulfilled", value: { valido: false, motivo: "estrutura" } });
      expect(erro).toMatchObject({ status: "rejected", reason: { code: "MEDIA_VALIDATION_UNAVAILABLE" } });
      expect(depois).toMatchObject({ status: "fulfilled", value: { valido: true } });
      expect(validador.emExecucao).toBe(0);
    });

    it("a fila libera após o arquivo inválido REAL (N8, script de produção)", async () => {
      const validador = new ValidadorMidiaService();
      const [n8, valido] = await Promise.all([validador.validar("image/jpeg", fixtureDeMidia(FIXTURES_MIDIA.n8)), validador.validar("image/jpeg", BYTES)]);
      expect(n8).toMatchObject({ valido: false, motivo: "estrutura" });
      expect(valido.valido).toBe(true);
      expect(validador.emExecucao).toBe(0);
    });

    it("a fila libera após timeout: o subprocesso travado é encerrado no prazo e a próxima validação executa", async () => {
      const validador = new ValidadorMidiaService({ script: falso("processo-roteiro"), prazoMs: 600 });
      const inicio = performance.now();
      const erro = await erroApi(validador.validar("teste/travar", BYTES));
      expect(erro.code).toBe("MEDIA_VALIDATION_UNAVAILABLE");
      expect(performance.now() - inicio).toBeGreaterThanOrEqual(550);
      expect(validador.emExecucao).toBe(0);
      expect(await validador.validar("image/jpeg", BYTES)).toMatchObject({ valido: true });
      expect(validador.emExecucao).toBe(0);
    });

    it("a fila libera após falha de inicialização do subprocesso (Bun.spawn lança): a próxima validação executa", async () => {
      const validador = new ValidadorMidiaService({ script: falso("processo-roteiro") });
      const espiao = spyOn(Bun, "spawn").mockImplementationOnce(() => {
        throw new Error("spawn ENOENT (simulado)");
      });
      try {
        const [falha, depois] = await Promise.allSettled([validador.validar("image/jpeg", BYTES), validador.validar("image/jpeg", BYTES)]);
        expect(falha).toMatchObject({ status: "rejected", reason: { code: "MEDIA_VALIDATION_UNAVAILABLE" } });
        expect(depois).toMatchObject({ status: "fulfilled", value: { valido: true } });
      } finally {
        espiao.mockRestore();
      }
      expect(validador.emExecucao).toBe(0);
    });

    it("solicitações excedentes não provocam deadlock: 6 mistas (sucesso, recusa, erro, timeout) se resolvem e a fila esvazia", async () => {
      const validador = new ValidadorMidiaService({ script: falso("processo-roteiro"), prazoMs: 4_000 });
      const inicio = performance.now();
      const tipos = ["image/jpeg", "teste/quebrar", "teste/carimbo", "image/jpeg", "teste/quebrar", "image/jpeg"];
      const resultados = await Promise.allSettled(tipos.map((tipo) => validador.validar(tipo, BYTES)));
      expect(resultados.map((resultado) => resultado.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled", "rejected", "fulfilled"]);
      expect(performance.now() - inicio).toBeLessThan(4_000);
      expect(validador.emExecucao).toBe(0);
    });

    it("prazo vencido NA FILA (vaga ocupada por um subprocesso travado) é 503 sem iniciar subprocesso; depois a fila volta a andar", async () => {
      const validador = new ValidadorMidiaService({ script: falso("processo-roteiro"), prazoMs: 500 });
      const [travado, naFila] = await Promise.allSettled([validador.validar("teste/travar", BYTES), validador.validar("image/jpeg", BYTES)]);
      expect(travado).toMatchObject({ status: "rejected", reason: { code: "MEDIA_VALIDATION_UNAVAILABLE" } });
      expect(naFila).toMatchObject({ status: "rejected", reason: { code: "MEDIA_VALIDATION_UNAVAILABLE" } });
      expect(validador.emExecucao).toBe(0);
      expect(await validador.validar("image/jpeg", BYTES)).toMatchObject({ valido: true });
    });
  });
});
