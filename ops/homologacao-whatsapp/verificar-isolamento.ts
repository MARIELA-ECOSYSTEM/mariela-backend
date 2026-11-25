/**
 * Fase 22.8.9.10.7.7 — VERIFICADOR DE ISOLAMENTO do ambiente local de homologação do WhatsApp oficial.
 *
 * Executado por `iniciar.ps1` ANTES de subir o backend (e de novo depois do MongoDB, com `--banco`). Qualquer falha
 * impede a inicialização. Nunca imprime valores — só o código da regra, OK/FALHA e uma descrição genérica.
 *
 *   bun --no-env-file ops/homologacao-whatsapp/verificar-isolamento.ts            (configuração)
 *   bun --no-env-file ops/homologacao-whatsapp/verificar-isolamento.ts --banco    (configuração + conteúdo do banco)
 *
 * As variáveis vêm do PROCESSO (carregadas de `config/homologacao.env` pelo `iniciar.ps1`), nunca de um `.env`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const MARCADOR_AMBIENTE = "homologacao-whatsapp";
/** Porta própria do MongoDB de homologação — nunca a 27017 (serviço local de desenvolvimento) nem a de produção. */
export const PORTA_MONGO_HOMOLOGACAO = 27217;
const BANCO_HOMOLOGACAO = /^mariela_homologacao[a-z0-9_]{0,40}$/;
const HOSTS_LOCAIS = new Set(["127.0.0.1", "localhost"]);
const E164_BR = /^\+55\d{10,11}$/;
const ID_META = /^\d{5,30}$/;

export interface ResultadoRegra {
  regra: string;
  ok: boolean;
  descricao: string;
}

type Variaveis = Record<string, string | undefined>;

const vazio = (v: string | undefined) => v === undefined || v.trim() === "";

export function destinosPermitidos(env: Variaveis): string[] {
  return (env["HOMOLOGACAO_DESTINOS_PERMITIDOS"] ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
}

/** Banco da URI (só para conferência local; o valor nunca é impresso). */
export function lerUriMongo(uri: string | undefined): { protocolo: string; hosts: string[]; portas: number[]; banco: string } | null {
  if (!uri) return null;
  const m = /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]+)\/([^?]*)/.exec(uri.trim());
  if (!m) return null;
  const hostsPortas = m[2]!.split(",").map((h) => {
    const [host, porta] = h.split(":");
    return { host: (host ?? "").toLowerCase(), porta: porta ? Number(porta) : 27017 };
  });
  return { protocolo: m[1]!, hosts: hostsPortas.map((h) => h.host), portas: hostsPortas.map((h) => h.porta), banco: decodeURIComponent(m[3] ?? "") };
}

/** Regras de CONFIGURAÇÃO (puras). `diretorio` = pasta de onde o backend será iniciado. */
export function avaliarConfiguracao(env: Variaveis, diretorio: string | null, existe: (p: string) => boolean = existsSync): ResultadoRegra[] {
  const r: ResultadoRegra[] = [];
  const regra = (codigo: string, ok: boolean, descricao: string) => r.push({ regra: codigo, ok, descricao });

  regra("R01", env["MARIELA_AMBIENTE"] === MARCADOR_AMBIENTE, `MARIELA_AMBIENTE identifica o ambiente como "${MARCADOR_AMBIENTE}"`);
  regra("R02", env["NODE_ENV"] === "development", "NODE_ENV=development (nunca production nem test)");

  const uri = lerUriMongo(env["MONGODB_URI"]);
  regra(
    "R03",
    uri !== null &&
      uri.protocolo === "mongodb" &&
      uri.hosts.length > 0 &&
      uri.hosts.every((h) => HOSTS_LOCAIS.has(h)) &&
      uri.portas.every((p) => p === PORTA_MONGO_HOMOLOGACAO),
    `MONGODB_URI aponta só para 127.0.0.1/localhost na porta ${PORTA_MONGO_HOMOLOGACAO} (nunca Atlas, mongodb+srv ou outra porta)`,
  );
  regra("R04", uri !== null && BANCO_HOMOLOGACAO.test(uri.banco), "banco do MongoDB começa com mariela_homologacao (nunca marielaDB, mariela ou mariela_test)");

  const origens = (env["CORS_ORIGINS"] ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");
  regra(
    "R05",
    origens.length > 0 && origens.every((o) => /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(o)),
    "CORS_ORIGINS só com origens locais (http://localhost:PORTA ou http://127.0.0.1:PORTA)",
  );
  regra("R06", vazio(env["EVOLUTION_API_URL"]) && vazio(env["EVOLUTION_API_KEY"]), "Evolution API desativada (sem URL nem chave): nenhum envio por outro provedor");
  regra(
    "R07",
    ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_BASE_URL"].every((k) => vazio(env[k])),
    "armazenamento de mídia (R2) desativado",
  );
  regra("R08", !vazio(env["PORT"]) && env["PORT"] !== "3000", "PORT própria da homologação (diferente da 3000 do desenvolvimento)");

  const provedor = (env["WHATSAPP_PROVEDOR_ENVIO"] ?? "").trim();
  regra("R09", ["", "desativado", "meta-cloud-api"].includes(provedor), "WHATSAPP_PROVEDOR_ENVIO vazio, desativado ou meta-cloud-api");

  if (provedor === "meta-cloud-api") {
    const destinos = destinosPermitidos(env);
    regra("R10", env["HOMOLOGACAO_CONFIRMO_APP_DA_META_SEPARADO"] === "sim", "operador confirmou que as credenciais são do APLICATIVO DA META DE HOMOLOGAÇÃO (HOMOLOGACAO_CONFIRMO_APP_DA_META_SEPARADO=sim)");
    regra("R11", destinos.length > 0 && destinos.length <= 5 && destinos.every((d) => E164_BR.test(d)), "HOMOLOGACAO_DESTINOS_PERMITIDOS: de 1 a 5 números autorizados em E.164 (+55...)");
    const idHomolog = (env["META_WHATSAPP_PHONE_NUMBER_ID"] ?? "").trim();
    const idProducao = (env["HOMOLOGACAO_PHONE_NUMBER_ID_PRODUCAO"] ?? "").trim();
    regra(
      "R12",
      ID_META.test(idHomolog) && ID_META.test(idProducao) && idHomolog !== idProducao,
      "Phone Number ID da homologação informado e DIFERENTE do Phone Number ID de produção (HOMOLOGACAO_PHONE_NUMBER_ID_PRODUCAO)",
    );
    const wabaHomolog = (env["META_WHATSAPP_BUSINESS_ACCOUNT_ID"] ?? "").trim();
    const wabaProducao = (env["HOMOLOGACAO_WABA_ID_PRODUCAO"] ?? "").trim();
    regra(
      "R13",
      vazio(wabaProducao) || wabaHomolog !== wabaProducao,
      "WABA ID da homologação diferente do de produção (quando HOMOLOGACAO_WABA_ID_PRODUCAO é informado)",
    );
    const dono = (env["WHATSAPP_OWNER_PHONE"] ?? "").trim();
    regra("R14", !destinos.includes(dono), "o número da loja de homologação não está entre os destinos de teste");
  }

  if (diretorio !== null) {
    regra("R15", !existe(join(diretorio, ".env")), "nenhum arquivo .env na pasta de onde o backend é iniciado (nada é herdado de outro ambiente)");
  }
  return r;
}

/** Só os dígitos, com DDI 55 — mesma forma do E.164 sem o "+". */
function digitosBr(telefone: string): string {
  const d = telefone.replace(/\D/g, "");
  return d.startsWith("55") && d.length > 11 ? d : `55${d}`;
}

/**
 * Regras do CONTEÚDO do banco de homologação (depois de subir o MongoDB): só clientes de teste. Com o provedor da Meta
 * ativo, todo cliente cadastrado precisa ter um telefone da lista de destinos autorizados — um banco com cadastro real
 * (importado por engano) impede a inicialização.
 */
export function avaliarClientes(env: Variaveis, telefones: string[]): ResultadoRegra[] {
  const provedorAtivo = (env["WHATSAPP_PROVEDOR_ENVIO"] ?? "").trim() === "meta-cloud-api";
  const permitidos = new Set(destinosPermitidos(env).map(digitosBr));
  const fora = telefones.filter((t) => !permitidos.has(digitosBr(t))).length;
  return [
    { regra: "B01", ok: telefones.length <= 20, descricao: "no máximo 20 clientes (banco de homologação, nunca uma cópia do cadastro real)" },
    {
      regra: "B02",
      ok: !provedorAtivo || fora === 0,
      descricao: provedorAtivo
        ? `todos os clientes têm telefone autorizado em HOMOLOGACAO_DESTINOS_PERMITIDOS (${fora} fora da lista)`
        : "provedor da Meta desativado: nenhum envio possível",
    },
  ];
}

export function imprimir(resultados: ResultadoRegra[], escrever: (l: string) => void = console.log): boolean {
  for (const x of resultados) escrever(`${x.ok ? "OK    " : "FALHA "} ${x.regra}  ${x.descricao}`);
  return resultados.every((x) => x.ok);
}

if (import.meta.main) {
  const comBanco = process.argv.includes("--banco");
  let ok = imprimir(avaliarConfiguracao(process.env, process.cwd()));
  if (ok && comBanco) {
    const { MongoClient } = await import("mongodb");
    const cliente = new MongoClient(process.env["MONGODB_URI"]!, { serverSelectionTimeoutMS: 10_000 });
    try {
      await cliente.connect();
      const telefones = (await cliente.db().collection("clientes").find({}, { projection: { telefone: 1 } }).toArray()).map((c) => String(c["telefone"] ?? ""));
      ok = imprimir(avaliarClientes(process.env, telefones)) && ok;
    } finally {
      await cliente.close();
    }
  }
  console.log(ok ? "ISOLAMENTO: OK" : "ISOLAMENTO: FALHOU — nada foi iniciado");
  process.exitCode = ok ? 0 : 1;
}
