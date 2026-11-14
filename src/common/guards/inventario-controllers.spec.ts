import { describe, expect, it } from "bun:test";
import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { GUARDS_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES_KEY, Roles } from "../decorators/roles.decorator.js";
import { PdvJwtAuthGuard } from "../../modules/pdv-auth/guards/pdv-jwt-auth.guard.js";
import { AuthController } from "../../modules/auth/auth.controller.js";
import { PdvAuthController } from "../../modules/pdv-auth/pdv-auth.controller.js";
import { SaudeController } from "../../modules/saude/saude.controller.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { RolesGuard } from "./roles.guard.js";

/**
 * Fase 22.8.1 — inventário AUTOMÁTICO de autenticação/autorização de TODOS os controllers.
 *
 * O `JwtAuthGuard` é aplicado por controller (não há guard global de autenticação — só o throttler é `APP_GUARD`).
 * Este teste transforma "todo controller está protegido" numa propriedade verificada a cada execução:
 *
 *   - DESCOBERTA sem lista fixa: varre `src/**\/*.controller.ts` (todas as classes com `@Controller`) E os
 *     `controllers: [...]` de todos os `src/**\/*.module.ts`; classifica a UNIÃO e exige que os dois conjuntos
 *     coincidam (controller fora de módulo, ou registrado fora de um `*.controller.ts`, falha). Cada módulo com
 *     controllers precisa estar importado no `AppModule` (conferência textual — subir o `AppModule` exigiria o ambiente).
 *   - CLASSIFICAÇÃO pelos metadados reais do Nest (`__guards__`, `path`, `roles`), em três categorias exclusivas:
 *       ADMIN  — `@UseGuards(JwtAuthGuard, RolesGuard)` nessa ORDEM (o RolesGuard lê `request.user`, preenchido pelo
 *                JwtAuthGuard) + `@Roles("ADMIN")` na classe; nenhum handler pode sobrescrever os papéis (o
 *                `RolesGuard` usa `getAllAndOverride` com o handler PRIMEIRO — um `@Roles()` vazio liberaria a rota);
 *                caminho fora de `pdv/`; sem `PdvJwtAuthGuard`.
 *       PDV    — `@UseGuards(PdvJwtAuthGuard)` (o guard que relê o vendedor e exige `ativo`), sem os guards ADMIN,
 *                sem `@Roles`, caminho `pdv/...`.
 *       PÚBLICO — SOMENTE os controllers listados em `PUBLICOS`, com classificação MÉTODO A MÉTODO: cada handler é
 *                declarado público (com justificativa) ou protegido por um guard específico. Handler novo não
 *                declarado → falha. Ausência de guard NUNCA é tratada como "público".
 *   - Qualquer outro caso → falha, com o motivo.
 *
 * Os casos sintéticos no fim do arquivo provam que o classificador REPROVA controllers mal protegidos.
 */

type Classe = abstract new (...args: never[]) => unknown;
type Guard = new (...args: never[]) => unknown;

interface ExpectativaPublica {
  justificativa: string;
  /** handler → justificativa de ser público. */
  publicos: Record<string, string>;
  /** handler → guard exigido no próprio método. */
  protegidos: Record<string, Guard>;
}

/** ÚNICOS controllers sem guard de classe. Incluir um controller aqui é uma decisão consciente, revisável no diff. */
const PUBLICOS = new Map<Classe, ExpectativaPublica>([
  [
    AuthController,
    {
      justificativa: "Autenticação administrativa: obter/renovar/encerrar a sessão não pode exigir sessão.",
      publicos: {
        login: "credenciais no corpo; throttle dedicado",
        refresh: "o próprio refresh token (opaco, rotacionado) é a credencial",
        logout: "revoga o refresh token informado; idempotente",
      },
      protegidos: { me: JwtAuthGuard },
    },
  ],
  [
    PdvAuthController,
    {
      justificativa: "Autenticação do PDV: mesmas razões do login administrativo, com segredo e guard próprios.",
      publicos: {
        login: "credenciais no corpo; throttle dedicado",
        refresh: "o próprio refresh token do PDV é a credencial",
        logout: "revoga o refresh token informado",
      },
      protegidos: { me: PdvJwtAuthGuard },
    },
  ],
  [
    SaudeController,
    {
      justificativa: "Health check de infraestrutura (Render): status da API e do banco, sem dados de negócio.",
      publicos: { verificar: "sonda de disponibilidade" },
      protegidos: {},
    },
  ],
]);

const GUARDS_ADMIN: readonly Guard[] = [JwtAuthGuard, RolesGuard];

function metadado<T>(chave: string, alvo: object): T | undefined {
  return Reflect.getMetadata(chave, alvo) as T | undefined;
}

function caminhoDoController(classe: Classe): string {
  const caminho = metadado<string | string[]>(PATH_METADATA, classe);
  return (Array.isArray(caminho) ? caminho.join(",") : (caminho ?? "")).replace(/^\/+/, "");
}

/** Métodos do protótipo que são rotas HTTP (têm `path` de rota). */
function handlersDe(classe: Classe): string[] {
  const prototipo = classe.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototipo).filter((nome) => {
    if (nome === "constructor") return false;
    const metodo = prototipo[nome];
    return typeof metodo === "function" && metadado(PATH_METADATA, metodo) !== undefined;
  });
}

function guardsDe(alvo: object): Guard[] {
  return metadado<Guard[]>(GUARDS_METADATA, alvo) ?? [];
}

function nomes(guards: readonly Guard[]): string {
  return `[${guards.map((g) => g.name).join(", ")}]`;
}

export type Categoria = "ADMIN" | "PDV" | "PUBLICO" | "NAO_CLASSIFICADO";

export function classificarController(
  classe: Classe,
  publicos: ReadonlyMap<Classe, ExpectativaPublica> = PUBLICOS,
): { categoria: Categoria; violacoes: string[] } {
  const violacoes: string[] = [];
  const guardsDaClasse = guardsDe(classe);
  const papeisDaClasse = metadado<string[]>(ROLES_KEY, classe);
  const caminho = caminhoDoController(classe);
  const prototipo = classe.prototype as Record<string, object>;
  const handlers = handlersDe(classe);
  if (handlers.length === 0) violacoes.push("nenhuma rota encontrada (metadados do Nest ausentes?)");

  const publico = publicos.get(classe);
  if (publico) {
    if (guardsDaClasse.length > 0) {
      violacoes.push(`controller público não deveria ter guard de classe, tem ${nomes(guardsDaClasse)}`);
    }
    if (papeisDaClasse !== undefined) violacoes.push("controller público não deveria declarar @Roles na classe");
    for (const handler of handlers) {
      const guardsDoHandler = guardsDe(prototipo[handler]!);
      const exigido = publico.protegidos[handler];
      if (exigido) {
        if (guardsDoHandler.length !== 1 || guardsDoHandler[0] !== exigido) {
          violacoes.push(`${handler}: deveria exigir exatamente [${exigido.name}], tem ${nomes(guardsDoHandler)}`);
        }
      } else if (handler in publico.publicos) {
        if (guardsDoHandler.length > 0) {
          violacoes.push(`${handler}: declarado público mas tem ${nomes(guardsDoHandler)} — atualize a classificação`);
        }
      } else {
        violacoes.push(`${handler}: rota NÃO classificada (declare-a como pública, com justificativa, ou proteja-a)`);
      }
    }
    for (const declarado of [...Object.keys(publico.publicos), ...Object.keys(publico.protegidos)]) {
      if (!handlers.includes(declarado)) violacoes.push(`${declarado}: classificado mas não existe mais`);
    }
    return { categoria: "PUBLICO", violacoes };
  }

  const temAdmin = guardsDaClasse.some((g) => g === JwtAuthGuard || g === RolesGuard);
  const temPdv = guardsDaClasse.includes(PdvJwtAuthGuard);

  if (temPdv) {
    if (temAdmin) violacoes.push(`mistura guards ADMIN e PDV: ${nomes(guardsDaClasse)}`);
    if (guardsDaClasse.length !== 1) violacoes.push(`PDV deveria usar só [PdvJwtAuthGuard], tem ${nomes(guardsDaClasse)}`);
    if (papeisDaClasse !== undefined) violacoes.push("PDV não usa @Roles (o papel ADMIN não se aplica a vendedor)");
    if (!caminho.startsWith("pdv/")) violacoes.push(`caminho de PDV deveria começar com "pdv/", é "${caminho}"`);
    for (const handler of handlers) {
      if (metadado(ROLES_KEY, prototipo[handler]!) !== undefined) violacoes.push(`${handler}: @Roles em rota PDV`);
    }
    return { categoria: "PDV", violacoes };
  }

  if (temAdmin) {
    if (guardsDaClasse.length !== 2 || guardsDaClasse[0] !== JwtAuthGuard || guardsDaClasse[1] !== RolesGuard) {
      violacoes.push(`ADMIN deveria usar ${nomes(GUARDS_ADMIN)} nessa ordem, tem ${nomes(guardsDaClasse)}`);
    }
    if (JSON.stringify(papeisDaClasse) !== JSON.stringify(["ADMIN"])) {
      violacoes.push(`ADMIN deveria declarar @Roles("ADMIN") na classe, tem ${JSON.stringify(papeisDaClasse)}`);
    }
    if (caminho.startsWith("pdv")) violacoes.push(`controller ADMIN em caminho de PDV ("${caminho}")`);
    for (const handler of handlers) {
      const papeisDoHandler = metadado<string[]>(ROLES_KEY, prototipo[handler]!);
      if (papeisDoHandler !== undefined && JSON.stringify(papeisDoHandler) !== JSON.stringify(["ADMIN"])) {
        violacoes.push(`${handler}: sobrescreve os papéis da classe com ${JSON.stringify(papeisDoHandler)}`);
      }
    }
    return { categoria: "ADMIN", violacoes };
  }

  violacoes.push(
    `sem guard de autenticação na classe e fora da lista PUBLICOS (guards: ${nomes(guardsDaClasse)}) — ` +
      "proteja com JwtAuthGuard+RolesGuard+@Roles(\"ADMIN\"), PdvJwtAuthGuard, ou classifique explicitamente como público",
  );
  return { categoria: "NAO_CLASSIFICADO", violacoes };
}

// ─── Descoberta ────────────────────────────────────────────────────────────────────────────────────────────────────

const RAIZ_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function arquivos(padrao: string): Promise<string[]> {
  const encontrados: string[] = [];
  for await (const arquivo of new Bun.Glob(padrao).scan({ cwd: RAIZ_SRC, absolute: true })) {
    if (!/\.spec\.ts$/.test(arquivo)) encontrados.push(arquivo);
  }
  return encontrados.sort();
}

interface Inventario {
  controllersDeArquivos: Map<Classe, string>;
  controllersDeModulos: Map<Classe, string>;
  modulosComControllers: { nome: string; arquivo: string }[];
}

async function descobrir(): Promise<Inventario> {
  const controllersDeArquivos = new Map<Classe, string>();
  for (const arquivo of await arquivos("**/*.controller.ts")) {
    const exportado = (await import(arquivo)) as Record<string, unknown>;
    for (const valor of Object.values(exportado)) {
      // `@Controller` grava `path` na CLASSE; métodos de rota gravam no método — só classes contam aqui.
      if (typeof valor === "function" && metadado(PATH_METADATA, valor) !== undefined && valor.prototype) {
        controllersDeArquivos.set(valor as Classe, relative(RAIZ_SRC, arquivo));
      }
    }
  }

  const controllersDeModulos = new Map<Classe, string>();
  const modulosComControllers: { nome: string; arquivo: string }[] = [];
  for (const arquivo of await arquivos("**/*.module.ts")) {
    if (relative(RAIZ_SRC, arquivo) === "app.module.ts") continue; // importá-lo validaria o ambiente (ConfigModule)
    const exportado = (await import(arquivo)) as Record<string, unknown>;
    for (const [nome, valor] of Object.entries(exportado)) {
      if (typeof valor !== "function") continue;
      const controllers = metadado<Classe[]>(MODULE_METADATA.CONTROLLERS, valor) ?? [];
      if (controllers.length === 0) continue;
      modulosComControllers.push({ nome, arquivo: relative(RAIZ_SRC, arquivo) });
      for (const controller of controllers) controllersDeModulos.set(controller, nome);
    }
  }
  return { controllersDeArquivos, controllersDeModulos, modulosComControllers };
}

// ─── Inventário real ───────────────────────────────────────────────────────────────────────────────────────────────

// Descoberta no carregamento do arquivo (top-level await): os testes abaixo só rodam com o inventário completo.
const inventario = await descobrir();
const todos = new Map<Classe, string>([...inventario.controllersDeArquivos]);
for (const [classe, modulo] of inventario.controllersDeModulos) {
  if (!todos.has(classe)) todos.set(classe, `(registrado em ${modulo}, fora de *.controller.ts)`);
}

describe("Inventário de controllers — autenticação/autorização (Fase 22.8.1)", () => {
  it("a descoberta encontrou controllers e módulos (sanidade: a varredura não está vazia)", () => {
    expect(inventario.controllersDeArquivos.size).toBeGreaterThanOrEqual(25);
    expect(inventario.modulosComControllers.length).toBeGreaterThanOrEqual(24);
  });

  it("todo controller de arquivo está registrado em algum módulo, e todo controller registrado vem de *.controller.ts", () => {
    const semModulo = [...inventario.controllersDeArquivos]
      .filter(([classe]) => !inventario.controllersDeModulos.has(classe))
      .map(([classe, arquivo]) => `${classe.name} (${arquivo})`);
    const foraDeArquivo = [...inventario.controllersDeModulos]
      .filter(([classe]) => !inventario.controllersDeArquivos.has(classe))
      .map(([classe, modulo]) => `${classe.name} (em ${modulo})`);
    expect({ semModulo, foraDeArquivo }).toEqual({ semModulo: [], foraDeArquivo: [] });
  });

  it("todo módulo com controllers é importado pelo AppModule", () => {
    const fonteAppModule = readFileSync(join(RAIZ_SRC, "app.module.ts"), "utf8");
    const naoImportados = inventario.modulosComControllers
      .filter(({ nome }) => !new RegExp(`\\b${nome}\\b`).test(fonteAppModule))
      .map(({ nome, arquivo }) => `${nome} (${arquivo})`);
    expect(naoImportados).toEqual([]);
  });

  it("TODO controller é ADMIN, PDV ou PÚBLICO declarado — sem nenhuma violação", () => {
    const problemas: string[] = [];
    for (const [classe, origem] of todos) {
      const { categoria, violacoes } = classificarController(classe);
      for (const violacao of violacoes) problemas.push(`${classe.name} [${categoria}] (${origem}): ${violacao}`);
    }
    expect(problemas).toEqual([]);
  });

  it("todo controller listado em PUBLICOS existe no inventário (a lista não guarda entradas mortas)", () => {
    const ausentes = [...PUBLICOS.keys()].filter((classe) => !todos.has(classe)).map((c) => c.name);
    expect(ausentes).toEqual([]);
  });

  it("classificação registrada (documento vivo — muda no diff quando um controller entra/sai)", () => {
    const porCategoria: Record<string, string[]> = {};
    for (const [classe] of todos) {
      const { categoria } = classificarController(classe);
      (porCategoria[categoria] ??= []).push(`${classe.name} → /${caminhoDoController(classe)}`);
    }
    for (const lista of Object.values(porCategoria)) lista.sort();
    expect(Object.keys(porCategoria).sort()).toEqual(["ADMIN", "PDV", "PUBLICO"]);
    // 25 controllers = 17 ADMIN + 5 PDV + 3 públicos (a auditoria 22.8 citou "20 administrativos" por erro de soma).
    expect(porCategoria["ADMIN"]).toHaveLength(17);
    expect(porCategoria["PDV"]).toHaveLength(5);
    expect(porCategoria["PUBLICO"]).toHaveLength(3);
  });
});

// ─── Prova de que o classificador REPROVA proteção ausente ou errada ──────────────────────────────────────────────

describe("Classificador — casos sintéticos que DEVEM falhar (Fase 22.8.1)", () => {
  @Controller("sem-guard")
  class SemGuard {
    @Get() listar() {}
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Controller("sem-roles")
  class AdminSemRoles {
    @Get() listar() {}
  }

  @UseGuards(JwtAuthGuard)
  @Roles("ADMIN")
  @Controller("so-jwt")
  class AdminSemRolesGuard {
    @Get() listar() {}
  }

  @UseGuards(RolesGuard, JwtAuthGuard)
  @Roles("ADMIN")
  @Controller("ordem-invertida")
  class AdminOrdemInvertida {
    @Get() listar() {}
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @Controller("override")
  class AdminComHandlerLiberado {
    @Roles() // vazio: o RolesGuard (handler primeiro) deixaria passar qualquer papel
    @Get()
    listar() {}
  }

  @UseGuards(PdvJwtAuthGuard, JwtAuthGuard)
  @Controller("pdv/misturado")
  class PdvMisturado {
    @Get() listar() {}
  }

  @UseGuards(PdvJwtAuthGuard)
  @Controller("vendas-pdv-fora-do-prefixo")
  class PdvForaDoPrefixo {
    @Get() listar() {}
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @Controller("pdv/rota-admin")
  class AdminEmCaminhoPdv {
    @Get() listar() {}
  }

  @Controller("auth-falso")
  class PublicoComRotaNova {
    @Post("login") login() {}
    @Get("exportar") exportarTudo() {}
  }

  @Controller("auth-falso-2")
  class PublicoComMeDesprotegido {
    @Post("login") login() {}
    @Get("me") me() {}
  }

  const publicosSinteticos = new Map<Classe, ExpectativaPublica>([
    [PublicoComRotaNova, { justificativa: "teste", publicos: { login: "teste" }, protegidos: {} }],
    [PublicoComMeDesprotegido, { justificativa: "teste", publicos: { login: "teste" }, protegidos: { me: JwtAuthGuard } }],
  ]);

  const casos: [string, Classe, Categoria, RegExp][] = [
    ["controller novo SEM guard", SemGuard, "NAO_CLASSIFICADO", /sem guard de autenticação/],
    ["ADMIN sem @Roles", AdminSemRoles, "ADMIN", /@Roles\("ADMIN"\)/],
    ["ADMIN sem RolesGuard", AdminSemRolesGuard, "ADMIN", /nessa ordem/],
    ["ADMIN com guards em ordem invertida", AdminOrdemInvertida, "ADMIN", /nessa ordem/],
    ["ADMIN com handler que sobrescreve papéis", AdminComHandlerLiberado, "ADMIN", /sobrescreve os papéis/],
    ["PDV misturado com JWT ADMIN", PdvMisturado, "PDV", /mistura guards ADMIN e PDV/],
    ["PDV fora do prefixo pdv/", PdvForaDoPrefixo, "PDV", /deveria começar com "pdv\/"/],
    ["ADMIN em caminho de PDV", AdminEmCaminhoPdv, "ADMIN", /caminho de PDV/],
    ["público com rota nova não declarada", PublicoComRotaNova, "PUBLICO", /exportarTudo: rota NÃO classificada/],
    ["público com rota protegida sem guard", PublicoComMeDesprotegido, "PUBLICO", /me: deveria exigir exatamente \[JwtAuthGuard\]/],
  ];

  for (const [nome, classe, categoria, motivo] of casos) {
    it(`reprova: ${nome}`, () => {
      const resultado = classificarController(classe, publicosSinteticos);
      expect(resultado.categoria).toBe(categoria);
      expect(resultado.violacoes.some((v) => motivo.test(v))).toBe(true);
    });
  }

  it("aprova os modelos corretos (controle negativo)", () => {
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles("ADMIN")
    @Controller("modelo-admin")
    class ModeloAdmin {
      @Get() listar() {}
    }
    @UseGuards(PdvJwtAuthGuard)
    @Controller("pdv/modelo")
    class ModeloPdv {
      @Get() listar() {}
    }
    expect(classificarController(ModeloAdmin)).toEqual({ categoria: "ADMIN", violacoes: [] });
    expect(classificarController(ModeloPdv)).toEqual({ categoria: "PDV", violacoes: [] });
  });
});
