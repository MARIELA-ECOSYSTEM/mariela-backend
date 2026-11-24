import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { validateEnv } from "./env.validation.js";

const SEGREDO_VALIDO_CURTO = "segredo-de-teste-123";
const SEGREDO_VALIDO_LONGO = "a".repeat(32);
/** Fase 22.8.9.2 (B-02) — URI fictícia apontando para o banco oficial: obrigatória em qualquer configuração de produção. */
const URI_PRODUCAO_FICTICIA = "mongodb+srv://usuario:senha@cluster0.exemplo.mongodb.net/marielaDB?retryWrites=true&w=majority";

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MONGODB_URI: "mongodb://localhost:27017/mariela",
    JWT_ACCESS_SECRET: SEGREDO_VALIDO_CURTO,
    JWT_REFRESH_SECRET: SEGREDO_VALIDO_CURTO,
    PDV_JWT_ACCESS_SECRET: SEGREDO_VALIDO_CURTO,
    PDV_JWT_REFRESH_SECRET: SEGREDO_VALIDO_CURTO,
    ...overrides,
  };
}

describe("validateEnv — provedor do envio de WhatsApp por template (Fase 22.8.9.10.4)", () => {
  it("ausente, vazio, 'desativado' ou 'meta-cloud-api' são aceitos", () => {
    for (const valor of ["", "desativado", "meta-cloud-api"]) {
      expect(() => validateEnv(baseEnv({ WHATSAPP_PROVEDOR_ENVIO: valor }))).not.toThrow();
    }
    expect(() => validateEnv(baseEnv())).not.toThrow();
  });

  it("nome desconhecido impede o boot (erro de digitação nunca vira outro provedor)", () => {
    expect(() => validateEnv(baseEnv({ WHATSAPP_PROVEDOR_ENVIO: "meta" }))).toThrow(/WHATSAPP_PROVEDOR_ENVIO/);
    expect(() => validateEnv(baseEnv({ WHATSAPP_PROVEDOR_ENVIO: "evolution" }))).toThrow(/WHATSAPP_PROVEDOR_ENVIO/);
  });

  it("META_WHATSAPP_* incompletas ou malformadas NÃO impedem o boot (só desativam o envio em tempo de execução)", () => {
    expect(() =>
      validateEnv(
        baseEnv({
          WHATSAPP_PROVEDOR_ENVIO: "meta-cloud-api",
          META_WHATSAPP_GRAPH_API_VERSION: "invalida",
          META_WHATSAPP_PHONE_NUMBER_ID: "",
          META_WHATSAPP_ACCESS_TOKEN: "",
          META_WHATSAPP_TIMEOUT_MS: "abc",
        }),
      ),
    ).not.toThrow();
  });

  it("META_WHATSAPP_WEBHOOK_VERIFY_TOKEN / META_WHATSAPP_APP_SECRET ausentes ou curtas NÃO impedem o boot (Fase 22.8.9.10.5)", () => {
    expect(() => validateEnv(baseEnv({ META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: "curto", META_WHATSAPP_APP_SECRET: "" }))).not.toThrow();
  });
});

describe("validateEnv", () => {
  it("aceita uma configuração válida mínima (development)", () => {
    const validado = validateEnv(baseEnv());
    expect(validado.NODE_ENV).toBe("development" as never);
    expect(validado.JWT_ACCESS_SECRET).toBe(SEGREDO_VALIDO_CURTO);
  });

  it("rejeita MONGODB_URI ausente", () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>)["MONGODB_URI"];
    expect(() => validateEnv(env)).toThrow();
  });

  describe("Fase 48.1-B — MONGODB_URI exige um banco explícito no path", () => {
    it("aceita mongodb:// com banco explícito", () => {
      expect(() => validateEnv(baseEnv({ MONGODB_URI: "mongodb://localhost:27017/marielaDB" }))).not.toThrow();
    });

    it("aceita mongodb+srv:// (Atlas) com banco explícito e query string", () => {
      expect(() =>
        validateEnv(baseEnv({ MONGODB_URI: "mongodb+srv://usuario:senha@cluster0.exemplo.mongodb.net/marielaDB?retryWrites=true&w=majority" })),
      ).not.toThrow();
    });

    it("rejeita a URI padrão copiada do Atlas Connect > Drivers, SEM banco no path (cairia em 'test' silenciosamente)", () => {
      expect(() =>
        validateEnv(baseEnv({ MONGODB_URI: "mongodb+srv://usuario:senha@cluster0.exemplo.mongodb.net/?retryWrites=true&w=majority" })),
      ).toThrow(/MONGODB_URI/);
    });

    it("rejeita a URI terminando só na barra, sem nome de banco", () => {
      expect(() => validateEnv(baseEnv({ MONGODB_URI: "mongodb://localhost:27017/" }))).toThrow(/MONGODB_URI/);
    });

    it("rejeita a URI sem barra alguma após o host (nenhum path)", () => {
      expect(() => validateEnv(baseEnv({ MONGODB_URI: "mongodb://localhost:27017" }))).toThrow(/MONGODB_URI/);
    });

    it("a mensagem de erro explica a causa (driver cairia no banco 'test')", () => {
      try {
        validateEnv(baseEnv({ MONGODB_URI: "mongodb://localhost:27017" }));
        throw new Error("deveria ter lançado");
      } catch (erro) {
        expect((erro as Error).message).toContain("test");
      }
    });
  });

  describe("Fase 40 — variáveis do storage R2 (opcionais)", () => {
    it("aceita a configuração sem nenhuma variável R2 (upload apenas desabilitado)", () => {
      expect(() => validateEnv(baseEnv())).not.toThrow();
    });

    it("aceita as 5 variáveis R2 com uma base pública https válida", () => {
      const env = baseEnv({
        R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        R2_ACCESS_KEY_ID: "id",
        R2_SECRET_ACCESS_KEY: "segredo",
        R2_BUCKET_NAME: "mariela-midia",
        R2_PUBLIC_BASE_URL: "https://midia.exemplo.com",
      });
      expect(validateEnv(env).R2_PUBLIC_BASE_URL).toBe("https://midia.exemplo.com");
    });

    it("aceita R2_PUBLIC_BASE_URL vazia ou só com espaços (equivale a não configurada)", () => {
      expect(() => validateEnv(baseEnv({ R2_PUBLIC_BASE_URL: "" }))).not.toThrow();
      expect(() => validateEnv(baseEnv({ R2_PUBLIC_BASE_URL: "   " }))).not.toThrow();
    });

    for (const invalida of ["midia.exemplo.com", "ftp://midia.exemplo.com", "https://", "https://midia.exemplo.com?x=1", "https://midia exemplo.com"]) {
      it(`rejeita R2_PUBLIC_BASE_URL inválida: "${invalida}"`, () => {
        expect(() => validateEnv(baseEnv({ R2_PUBLIC_BASE_URL: invalida }))).toThrow(/R2_PUBLIC_BASE_URL/);
      });
    }
  });

  describe("Etapa 18.23 — segredos JWT vazios/whitespace", () => {
    for (const campo of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "PDV_JWT_ACCESS_SECRET", "PDV_JWT_REFRESH_SECRET"]) {
      it(`rejeita ${campo} ausente`, () => {
        const env = baseEnv();
        delete (env as Record<string, string | undefined>)[campo];
        expect(() => validateEnv(env)).toThrow();
      });

      it(`rejeita ${campo} vazio`, () => {
        expect(() => validateEnv(baseEnv({ [campo]: "" }))).toThrow();
      });

      it(`rejeita ${campo} contendo somente espaços`, () => {
        expect(() => validateEnv(baseEnv({ [campo]: "   " }))).toThrow();
      });

      it(`aceita ${campo} curto (não-vazio) fora de produção`, () => {
        expect(() => validateEnv(baseEnv({ NODE_ENV: "development", [campo]: SEGREDO_VALIDO_CURTO }))).not.toThrow();
      });
    }
  });

  describe("Etapa 18.23 — tamanho mínimo de segredo em produção", () => {
    it("aceita segredos curtos (não-vazios) quando NODE_ENV=development", () => {
      expect(() => validateEnv(baseEnv({ NODE_ENV: "development" }))).not.toThrow();
    });

    it("aceita segredos curtos (não-vazios) quando NODE_ENV=test", () => {
      expect(() => validateEnv(baseEnv({ NODE_ENV: "test" }))).not.toThrow();
    });

    it("rejeita segredo curto quando NODE_ENV=production", () => {
      expect(() => validateEnv(baseEnv({ NODE_ENV: "production", MONGODB_URI: URI_PRODUCAO_FICTICIA }))).toThrow(/pelo menos 32 caracteres/);
    });

    it("aceita todos os segredos com pelo menos 32 caracteres quando NODE_ENV=production", () => {
      expect(() =>
        validateEnv(
          baseEnv({
            NODE_ENV: "production",
            MONGODB_URI: URI_PRODUCAO_FICTICIA,
            JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
            JWT_REFRESH_SECRET: SEGREDO_VALIDO_LONGO,
            PDV_JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
            PDV_JWT_REFRESH_SECRET: SEGREDO_VALIDO_LONGO,
          }),
        ),
      ).not.toThrow();
    });

    it("mensagem de erro em produção lista exatamente os campos curtos, não os já válidos", () => {
      let mensagem = "";
      try {
        validateEnv(
          baseEnv({
            NODE_ENV: "production",
            MONGODB_URI: URI_PRODUCAO_FICTICIA,
            JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
            JWT_REFRESH_SECRET: SEGREDO_VALIDO_CURTO,
            PDV_JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
            PDV_JWT_REFRESH_SECRET: SEGREDO_VALIDO_CURTO,
          }),
        );
      } catch (erro) {
        mensagem = erro instanceof Error ? erro.message : String(erro);
      }
      expect(mensagem).toContain("JWT_REFRESH_SECRET");
      expect(mensagem).toContain("PDV_JWT_REFRESH_SECRET");
      expect(mensagem).not.toContain("JWT_ACCESS_SECRET,");
    });
  });

  describe("Fase 58 — CORS_ORIGINS só aceita origens exatas", () => {
    const PRODUCAO = {
      NODE_ENV: "production",
      MONGODB_URI: URI_PRODUCAO_FICTICIA,
      JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
      JWT_REFRESH_SECRET: SEGREDO_VALIDO_LONGO,
      PDV_JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
      PDV_JWT_REFRESH_SECRET: SEGREDO_VALIDO_LONGO,
    };

    it("aceita vazio (CORS desligado) e a lista real dos frontends (dev e Tauri empacotado)", () => {
      expect(() => validateEnv(baseEnv({ CORS_ORIGINS: "" }))).not.toThrow();
      expect(() =>
        validateEnv(baseEnv({ CORS_ORIGINS: "http://localhost:8081, http://localhost:8080,http://tauri.localhost,tauri://localhost" })),
      ).not.toThrow();
    });

    it("rejeita curinga (*) em qualquer ambiente, inclusive produção — nunca vira 'qualquer origem' por acidente", () => {
      expect(() => validateEnv(baseEnv({ CORS_ORIGINS: "*" }))).toThrow(/CORS_ORIGINS contém origens inválidas: "\*" \(curinga/);
      expect(() => validateEnv(baseEnv({ ...PRODUCAO, CORS_ORIGINS: "http://tauri.localhost,*" }))).toThrow(/CORS_ORIGINS/);
      expect(() => validateEnv(baseEnv({ ...PRODUCAO, CORS_ORIGINS: "https://*.mariela.app" }))).toThrow(/curinga/);
    });

    it("rejeita origem com caminho, barra final, query ou sem esquema (nunca casaria em silêncio)", () => {
      for (const invalida of ["http://localhost:8081/", "http://localhost:8081/api", "http://localhost:8081?x=1", "localhost:8081", "ftp://host", "null"]) {
        expect(() => validateEnv(baseEnv({ CORS_ORIGINS: `http://localhost:8080,${invalida}` }))).toThrow(/CORS_ORIGINS contém origens inválidas/);
      }
    });

    it("produção com a lista explícita do Tauri empacotado é aceita", () => {
      expect(() => validateEnv(baseEnv({ ...PRODUCAO, CORS_ORIGINS: "http://tauri.localhost,tauri://localhost" }))).not.toThrow();
    });
  });
  describe("Fase 22.8.9.2 (B-02) — produção só aceita o banco marielaDB", () => {
    const SEGREDOS_PRODUCAO = {
      NODE_ENV: "production",
      JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
      JWT_REFRESH_SECRET: SEGREDO_VALIDO_LONGO,
      PDV_JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
      PDV_JWT_REFRESH_SECRET: SEGREDO_VALIDO_LONGO,
    };
    const HOST = "mongodb+srv://usuario:senha-ficticia-b02@cluster0.exemplo.mongodb.net";
    const producao = (uri: string) => () => validateEnv(baseEnv({ ...SEGREDOS_PRODUCAO, MONGODB_URI: uri }));

    function mensagemDe(fn: () => unknown): string {
      try {
        fn();
      } catch (erro) {
        return erro instanceof Error ? erro.message : String(erro);
      }
      throw new Error("deveria ter lançado");
    }

    it("produção + marielaDB: aceita (mongodb+srv com query, mongodb:// sem query)", () => {
      expect(producao(`${HOST}/marielaDB?retryWrites=true&w=majority`)).not.toThrow();
      expect(producao("mongodb://localhost:27017/marielaDB")).not.toThrow();
    });

    it("produção + test: rejeita", () => {
      expect(producao(`${HOST}/test?retryWrites=true`)).toThrow(/deve apontar para o banco "marielaDB"/);
    });

    it("produção + outro banco: rejeita (inclusive variações de caixa, prefixos, sufixos e subcaminhos)", () => {
      for (const banco of ["outroBanco", "mariela", "mariela_test", "marieladb", "MarielaDB", "MARIELADB", "marielaDB2", "xmarielaDB", "marielaDB/extra", "marielaDB%20", "admin"]) {
        expect(producao(`${HOST}/${banco}?retryWrites=true`)).toThrow(/deve apontar para o banco "marielaDB"/);
      }
    });

    it("produção sem banco: rejeita (path ausente, só a barra, só a query)", () => {
      for (const uri of [HOST, `${HOST}/`, `${HOST}/?retryWrites=true&w=majority`]) {
        expect(producao(uri)).toThrow(/MONGODB_URI/);
      }
    });

    it("produção: percent-encoding é decodificado como no driver (só vale se o resultado for exatamente marielaDB)", () => {
      expect(producao(`${HOST}/%6DarielaDB?retryWrites=true`)).not.toThrow();
      expect(producao(`${HOST}/%74est?retryWrites=true`)).toThrow(/marielaDB/);
      expect(producao(`${HOST}/mariela%ZZ?retryWrites=true`)).toThrow(/marielaDB/);
    });

    it("produção: a mensagem não expõe a URI, a credencial nem o banco recebido", () => {
      const mensagem = mensagemDe(producao(`${HOST}/bancoErradoXYZ?retryWrites=true`));
      expect(mensagem).toContain("MONGODB_URI");
      for (const proibido of ["senha-ficticia-b02", "usuario:", "cluster0", "bancoErradoXYZ", "mongodb+srv://"]) {
        expect(mensagem).not.toContain(proibido);
      }
    });

    it("produção: o banco é verificado antes dos segredos (banco errado + segredo curto aponta o banco)", () => {
      const mensagem = mensagemDe(() => validateEnv(baseEnv({ NODE_ENV: "production", MONGODB_URI: `${HOST}/test` })));
      expect(mensagem).toContain('"marielaDB"');
    });

    it("sem bypass: variáveis extras não liberam outro banco em produção", () => {
      expect(() =>
        validateEnv(
          baseEnv({
            ...SEGREDOS_PRODUCAO,
            MONGODB_URI: `${HOST}/test`,
            MONGODB_DB_NAME: "marielaDB",
            ALLOW_ANY_DATABASE: "true",
            MONGODB_BACKUP_URI: `${HOST}/marielaDB`,
          }),
        ),
      ).toThrow(/marielaDB/);
    });

    it("test + banco descartável: aceito como antes (qualquer nome explícito)", () => {
      for (const banco of ["mariela_test", "mariela_test_e2e_123", "test", "marielaDB"]) {
        expect(() => validateEnv(baseEnv({ NODE_ENV: "test", MONGODB_URI: `mongodb://127.0.0.1:27017/${banco}` }))).not.toThrow();
      }
    });

    it("development + configuração válida: comportamento anterior inalterado (banco livre, segredos curtos, sem banco ainda rejeitado)", () => {
      expect(() => validateEnv(baseEnv())).not.toThrow(); // NODE_ENV ausente = development, banco "mariela"
      expect(() => validateEnv(baseEnv({ NODE_ENV: "development", MONGODB_URI: "mongodb://localhost:27017/qualquer_banco_local" }))).not.toThrow();
      expect(() => validateEnv(baseEnv({ NODE_ENV: "development", MONGODB_URI: "mongodb://localhost:27017/" }))).toThrow(/MONGODB_URI/);
    });
  });

  describe("transporte do R2 (Fase 60.4.1)", () => {
    it("ausentes são aceitas (os padrões do projeto valem)", () => {
      const validado = validateEnv(baseEnv());
      expect(validado.R2_CONNECTION_TIMEOUT_MS).toBeUndefined();
      expect(validado.R2_MAX_ATTEMPTS).toBeUndefined();
    });

    it("vazias (como no .env.example) contam como ausentes: a API sobe com os padrões", () => {
      const validado = validateEnv(baseEnv({ R2_CONNECTION_TIMEOUT_MS: "", R2_REQUEST_TIMEOUT_MS: "  ", R2_MAX_ATTEMPTS: "" }));
      expect(validado.R2_CONNECTION_TIMEOUT_MS).toBeUndefined();
      expect(validado.R2_REQUEST_TIMEOUT_MS).toBeUndefined();
      expect(validado.R2_MAX_ATTEMPTS).toBeUndefined();
    });

    it("valores válidos são aceitos e convertidos para número", () => {
      const validado = validateEnv(baseEnv({ R2_CONNECTION_TIMEOUT_MS: "1500", R2_REQUEST_TIMEOUT_MS: "4000", R2_MAX_ATTEMPTS: "3" }));
      expect(validado.R2_CONNECTION_TIMEOUT_MS).toBe(1500);
      expect(validado.R2_REQUEST_TIMEOUT_MS).toBe(4000);
      expect(validado.R2_MAX_ATTEMPTS).toBe(3);
    });

    it("rejeita fora da faixa ou não inteiro (a API não sobe)", () => {
      for (const [nome, valor] of [
        ["R2_CONNECTION_TIMEOUT_MS", "50"],
        ["R2_CONNECTION_TIMEOUT_MS", "60001"],
        ["R2_REQUEST_TIMEOUT_MS", "99"],
        ["R2_REQUEST_TIMEOUT_MS", "120001"],
        ["R2_REQUEST_TIMEOUT_MS", "dez"],
        ["R2_MAX_ATTEMPTS", "0"],
        ["R2_MAX_ATTEMPTS", "6"],
        ["R2_MAX_ATTEMPTS", "2.5"],
      ] as const) {
        expect(() => validateEnv(baseEnv({ [nome]: valor }))).toThrow(new RegExp(nome));
      }
    });
  });

  describe("reconciliação de estoque (Fase 60.4.3.4.18)", () => {
    it("ausentes ou vazias (como no .env.example) são aceitas", () => {
      expect(() => validateEnv(baseEnv())).not.toThrow();
      const validado = validateEnv(
        baseEnv({
          RECONCILIACAO_ESTOQUE_HABILITADA: "",
          RECONCILIACAO_ESTOQUE_INTERVALO_MS: "",
          RECONCILIACAO_ESTOQUE_LOTE: "",
          RECONCILIACAO_ESTOQUE_MAX_ITENS_POR_CICLO: "",
          RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS: "",
          RECONCILIACAO_ESTOQUE_BACKOFF_BASE_MS: "",
          RECONCILIACAO_ESTOQUE_BACKOFF_MAX_MS: "",
        }),
      );
      expect(validado.RECONCILIACAO_ESTOQUE_INTERVALO_MS).toBeUndefined();
      expect(validado.RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS).toBeUndefined();
    });

    it("valores válidos são aceitos e convertidos para número", () => {
      const validado = validateEnv(
        baseEnv({ RECONCILIACAO_ESTOQUE_HABILITADA: "false", RECONCILIACAO_ESTOQUE_INTERVALO_MS: "30000", RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS: "5" }),
      );
      expect(validado.RECONCILIACAO_ESTOQUE_HABILITADA).toBe("false");
      expect(validado.RECONCILIACAO_ESTOQUE_INTERVALO_MS).toBe(30_000);
      expect(validado.RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS).toBe(5);
    });

    it("rejeita valores fora da faixa (laço agressivo, lote ilimitado) ou inválidos", () => {
      for (const [nome, valor] of [
        ["RECONCILIACAO_ESTOQUE_HABILITADA", "sim"],
        ["RECONCILIACAO_ESTOQUE_INTERVALO_MS", "1000"],
        ["RECONCILIACAO_ESTOQUE_LOTE", "0"],
        ["RECONCILIACAO_ESTOQUE_LOTE", "501"],
        ["RECONCILIACAO_ESTOQUE_MAX_ITENS_POR_CICLO", "5001"],
        ["RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS", "0"],
        ["RECONCILIACAO_ESTOQUE_BACKOFF_BASE_MS", "10"],
        ["RECONCILIACAO_ESTOQUE_BACKOFF_MAX_MS", "abc"],
      ] as const) {
        expect(() => validateEnv(baseEnv({ [nome]: valor }))).toThrow(new RegExp(nome));
      }
    });
  });
});
