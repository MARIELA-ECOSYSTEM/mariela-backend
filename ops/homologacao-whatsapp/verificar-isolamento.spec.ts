import { describe, expect, it } from "bun:test";
import { avaliarClientes, avaliarConfiguracao, lerUriMongo } from "./verificar-isolamento.js";

/** Fase 22.8.9.10.7.7 — regras do verificador de isolamento da homologação (valores fictícios; nada é conectado). */
const BASE: Record<string, string> = {
  MARIELA_AMBIENTE: "homologacao-whatsapp",
  NODE_ENV: "development",
  PORT: "3100",
  MONGODB_URI: "mongodb://127.0.0.1:27217/mariela_homologacao_whatsapp?replicaSet=rs-homologacao-whatsapp",
  CORS_ORIGINS: "http://localhost:5180",
  WHATSAPP_PROVEDOR_ENVIO: "desativado",
};
const META_OK: Record<string, string> = {
  ...BASE,
  WHATSAPP_PROVEDOR_ENVIO: "meta-cloud-api",
  META_WHATSAPP_PHONE_NUMBER_ID: "111111111111111",
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: "222222222222222",
  HOMOLOGACAO_CONFIRMO_APP_DA_META_SEPARADO: "sim",
  HOMOLOGACAO_DESTINOS_PERMITIDOS: "+5583999990001",
  HOMOLOGACAO_PHONE_NUMBER_ID_PRODUCAO: "999999999999999",
  HOMOLOGACAO_WABA_ID_PRODUCAO: "888888888888888",
  WHATSAPP_OWNER_PHONE: "+15550000000",
};
const semEnv = () => false;
const falhas = (env: Record<string, string | undefined>, existe = semEnv) =>
  avaliarConfiguracao(env, "C:\\homologacao\\backend", existe)
    .filter((r) => !r.ok)
    .map((r) => r.regra);

describe("verificador de isolamento — configuração", () => {
  it("configuração padrão (provedor desativado) e configuração completa da Meta de homologação passam", () => {
    expect(falhas(BASE)).toEqual([]);
    expect(falhas(META_OK)).toEqual([]);
  });

  it("sem o marcador do ambiente, ou em production/test → recusa", () => {
    expect(falhas({ ...BASE, MARIELA_AMBIENTE: undefined })).toEqual(["R01"]);
    expect(falhas({ ...BASE, NODE_ENV: "production" })).toEqual(["R02"]);
    expect(falhas({ ...BASE, NODE_ENV: "test" })).toEqual(["R02"]);
  });

  it("MongoDB: Atlas, mongodb+srv, host remoto, porta 27017 ou banco de produção/teste → recusa", () => {
    for (const uri of [
      "mongodb+srv://usuario:senha@cluster0.exemplo.mongodb.net/mariela_homologacao_whatsapp",
      "mongodb://usuario:senha@cluster0-shard-00-00.exemplo.mongodb.net:27017/mariela_homologacao_whatsapp?ssl=true",
      "mongodb://10.0.0.5:27217/mariela_homologacao_whatsapp",
      "mongodb://127.0.0.1:27017/mariela_homologacao_whatsapp",
      "mongodb://127.0.0.1:27217,remoto.exemplo:27217/mariela_homologacao_whatsapp",
    ]) {
      expect(falhas({ ...BASE, MONGODB_URI: uri })).toContain("R03");
    }
    for (const banco of ["marielaDB", "mariela", "mariela_test", "", "homologacao"]) {
      expect(falhas({ ...BASE, MONGODB_URI: `mongodb://127.0.0.1:27217/${banco}` })).toContain("R04");
    }
    expect(falhas({ ...BASE, MONGODB_URI: undefined })).toEqual(expect.arrayContaining(["R03", "R04"]));
  });

  it("CORS só local; Evolution e R2 desligados; porta própria", () => {
    expect(falhas({ ...BASE, CORS_ORIGINS: "http://tauri.localhost" })).toEqual(["R05"]);
    expect(falhas({ ...BASE, CORS_ORIGINS: "http://localhost:5180,https://app.exemplo.com" })).toEqual(["R05"]);
    expect(falhas({ ...BASE, CORS_ORIGINS: "" })).toEqual(["R05"]);
    expect(falhas({ ...BASE, EVOLUTION_API_URL: "http://localhost:8081" })).toEqual(["R06"]);
    expect(falhas({ ...BASE, EVOLUTION_API_KEY: "qualquer" })).toEqual(["R06"]);
    expect(falhas({ ...BASE, R2_BUCKET_NAME: "bucket" })).toEqual(["R07"]);
    expect(falhas({ ...BASE, PORT: "3000" })).toEqual(["R08"]);
    expect(falhas({ ...BASE, WHATSAPP_PROVEDOR_ENVIO: "evolution" })).toEqual(["R09"]);
  });

  it("Meta ativa exige: confirmação do app separado, destinos autorizados, Phone Number ID diferente do de produção", () => {
    expect(falhas({ ...META_OK, HOMOLOGACAO_CONFIRMO_APP_DA_META_SEPARADO: "SIM " })).toEqual(["R10"]);
    expect(falhas({ ...META_OK, HOMOLOGACAO_DESTINOS_PERMITIDOS: "" })).toEqual(["R11"]);
    expect(falhas({ ...META_OK, HOMOLOGACAO_DESTINOS_PERMITIDOS: "83999990001" })).toEqual(["R11"]);
    expect(falhas({ ...META_OK, HOMOLOGACAO_DESTINOS_PERMITIDOS: "+5583999990001,+5583999990002,+5583999990003,+5583999990004,+5583999990005,+5583999990006" })).toEqual(["R11"]);
    expect(falhas({ ...META_OK, HOMOLOGACAO_PHONE_NUMBER_ID_PRODUCAO: "111111111111111" })).toEqual(["R12"]);
    expect(falhas({ ...META_OK, HOMOLOGACAO_PHONE_NUMBER_ID_PRODUCAO: "" })).toEqual(["R12"]);
    expect(falhas({ ...META_OK, HOMOLOGACAO_WABA_ID_PRODUCAO: "222222222222222" })).toEqual(["R13"]);
    expect(falhas({ ...META_OK, HOMOLOGACAO_WABA_ID_PRODUCAO: "" })).toEqual([]);
    expect(falhas({ ...META_OK, WHATSAPP_OWNER_PHONE: "+5583999990001" })).toEqual(["R14"]);
  });

  it("um .env na pasta de onde o backend sobe → recusa", () => {
    expect(falhas(BASE, (p) => p.endsWith(".env"))).toEqual(["R15"]);
  });

  it("a saída nunca contém valores da configuração", () => {
    const tudo = JSON.stringify(avaliarConfiguracao({ ...META_OK, MONGODB_URI: "mongodb+srv://usuario:SENHA-SECRETA@x.mongodb.net/BANCO_REAL_XYZ" }, "C:\\x", semEnv));
    for (const valor of ["SENHA-SECRETA", "111111111111111", "999999999999999", "+5583999990001", "mongodb.net", "BANCO_REAL_XYZ", "usuario"]) {
      expect(tudo).not.toContain(valor);
    }
  });

  it("leitura da URI (só para conferência local)", () => {
    expect(lerUriMongo("mongodb://127.0.0.1:27217/mariela_homologacao_whatsapp?replicaSet=x")).toEqual({
      protocolo: "mongodb",
      hosts: ["127.0.0.1"],
      portas: [27217],
      banco: "mariela_homologacao_whatsapp",
    });
    expect(lerUriMongo("lixo")).toBeNull();
  });
});

describe("verificador de isolamento — conteúdo do banco", () => {
  it("Meta ativa: todo cliente precisa ter telefone autorizado (com ou sem máscara/DDI)", () => {
    expect(avaliarClientes(META_OK, ["(83) 99999-0001", "5583999990001"]).every((r) => r.ok)).toBe(true);
    const r = avaliarClientes(META_OK, ["(83) 99999-0001", "(11) 98888-7777"]);
    expect(r.find((x) => x.regra === "B02")?.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("98888");
  });

  it("provedor desativado: clientes sintéticos livres (nada pode ser enviado); banco grande demais é recusado", () => {
    expect(avaliarClientes(BASE, ["(11) 98888-7777"]).every((r) => r.ok)).toBe(true);
    expect(avaliarClientes(BASE, Array.from({ length: 21 }, (_, i) => `8399999${String(i).padStart(4, "0")}`)).find((x) => x.regra === "B01")?.ok).toBe(false);
  });
});
