import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Fase 60.4.3.4.21.2.11 (N5) — PACOTE DE EVIDÊNCIAS dos testes integrados.
 *
 * Nas 21.2.9/21.2.10 as evidências (relatórios, âncoras, logs) moravam na pasta temporária do runner e eram apagadas
 * pela limpeza. Agora o runner chama `criarPacoteEvidencias` ANTES da limpeza, com destino FORA do repositório, FORA da
 * raiz da instância isolada e FORA das pastas de origem (a limpeza não alcança o pacote).
 *
 * Conteúdo: `indice.json` (id único, origem, resumo por caso, exclusões), `resultados.json` (resultado por caso),
 * `arquivos/…` (cópias SANITIZADAS) e `MANIFESTO.sha256` (SHA-256 de cada arquivo do pacote).
 * Nunca entra: credencial (*.cred), chave (*.key, mongod.key), pasta `seguranca`, `.env*`, arquivo fora da lista de
 * extensões de texto, link simbólico. Texto: URIs mongodb, senhas/tokens em JSON ou `chave=valor`, blocos de chave
 * privada, `Authorization`/`Bearer` e os segredos LITERAIS informados pelo chamador são substituídos por marcadores.
 * Sem upload: o pacote é só local.
 */

export const EXTENSOES_TEXTO = [".json", ".jsonl", ".txt", ".log", ".md", ".csv"] as const;
const PROIBIDOS_NOME = [/\.cred$/i, /\.key$/i, /^mongod\.key$/i, /^\.env/i, /\.pem$/i, /\.pfx$/i];
const PROIBIDOS_PASTA = ["seguranca", ".git", "node_modules"];

export interface ResultadoCaso {
  id: string;
  caso: string;
  resultado: string;
  detalhe?: string;
}

export interface OpcoesPacote {
  /** Diretório onde o pacote será criado (uma subpasta nova por pacote). */
  destino: string;
  /** Pastas/arquivos de origem (relatórios, âncoras, logs). */
  origens: string[];
  resultados: ResultadoCaso[];
  /** Raiz do repositório e raiz da instância isolada: o destino não pode estar dentro delas. */
  repositorio: string;
  raizIsolada: string;
  /** Segredos LITERAIS a remover (e.g. senhas sintéticas do teste). Nunca são gravados. */
  segredos?: string[];
  descricao?: string;
  agora?: Date;
  id?: string;
}

export interface ResultadoPacote {
  id: string;
  pasta: string;
  arquivos: { caminho: string; sha256: string; bytes: number; sanitizado: boolean }[];
  excluidos: { origem: string; motivo: string }[];
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex").toUpperCase();

function dentro(filho: string, pai: string): boolean {
  const r = relative(resolve(pai), resolve(filho));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Resolve links/caminhos curtos quando existir; senão o caminho absoluto. */
function real(c: string): string {
  try {
    return realpathSync.native(c);
  } catch {
    return resolve(c);
  }
}

/** Sanitização de TEXTO (PURA). */
export function sanitizarTexto(texto: string, segredos: readonly string[] = []): { texto: string; alterado: boolean } {
  let t = texto;
  for (const s of segredos) if (s && s.length >= 4) t = t.split(s).join("[segredo-removido]");
  t = t
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[chave-privada-removida]")
    .replace(/mongodb(\+srv)?:\/\/[^\s"'<>]+/gi, "[uri-removida]")
    .replace(/("(?:senha|password|pwd|pass|token|secret|segredo|apiKey|api_key|authorization|chave)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[removido]"')
    .replace(/\b(senha|password|pwd|token|secret|segredo|api[_-]?key)=([^\s&"']+)/gi, "$1=[removido]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [removido]");
  return { texto: t, alterado: t !== texto };
}

function motivoExclusao(caminho: string): string | null {
  const nome = basename(caminho);
  if (PROIBIDOS_NOME.some((r) => r.test(nome))) return "credencial/chave/segredo";
  const partes = resolve(caminho).split(sep).map((p) => p.toLowerCase());
  if (PROIBIDOS_PASTA.some((p) => partes.includes(p))) return "pasta proibida (seguranca/.git/node_modules)";
  if (!(EXTENSOES_TEXTO as readonly string[]).includes(extname(nome).toLowerCase())) return "extensão fora da lista de texto";
  return null;
}

function listar(origem: string, excluidos: ResultadoPacote["excluidos"]): { abs: string; rel: string }[] {
  const base = resolve(origem);
  if (!existsSync(base)) {
    excluidos.push({ origem, motivo: "origem inexistente" });
    return [];
  }
  const st = lstatSync(base);
  if (st.isSymbolicLink()) {
    excluidos.push({ origem, motivo: "link simbólico" });
    return [];
  }
  if (st.isFile()) return [{ abs: base, rel: basename(base) }];
  const saida: { abs: string; rel: string }[] = [];
  const rotulo = basename(base);
  const andar = (dir: string) => {
    for (const nome of readdirSync(dir).sort()) {
      const c = join(dir, nome);
      const s = lstatSync(c);
      if (s.isSymbolicLink()) excluidos.push({ origem: c, motivo: "link simbólico" });
      else if (s.isDirectory()) {
        if (PROIBIDOS_PASTA.includes(nome.toLowerCase())) excluidos.push({ origem: c, motivo: "pasta proibida (seguranca/.git/node_modules)" });
        else andar(c);
      } else if (s.isFile()) saida.push({ abs: c, rel: join(rotulo, relative(base, c)) });
    }
  };
  andar(base);
  return saida;
}

/** Recusa destinos dentro do repositório, da raiz isolada ou de uma origem (a limpeza apagaria o pacote). */
export function conferirDestino(o: Pick<OpcoesPacote, "destino" | "origens" | "repositorio" | "raizIsolada">): string | null {
  if (!o.destino || !isAbsolute(o.destino)) return "destino deve ser um caminho absoluto";
  const d = real(o.destino);
  if (dentro(d, real(o.repositorio))) return "destino DENTRO do repositório";
  if (dentro(d, real(o.raizIsolada))) return "destino DENTRO da raiz da instância isolada";
  for (const or of o.origens) if (dentro(d, real(or))) return `destino DENTRO de uma origem (${or}) — a limpeza o apagaria`;
  return null;
}

export function criarPacoteEvidencias(o: OpcoesPacote): ResultadoPacote {
  const erro = conferirDestino(o);
  if (erro) throw new Error(`pacote de evidências recusado: ${erro}`);
  const agora = o.agora ?? new Date();
  const id = o.id ?? `${agora.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}_${randomUUID().slice(0, 8)}`;
  if (!/^[0-9A-Za-z_-]{6,80}$/.test(id)) throw new Error("id de pacote inválido");
  mkdirSync(o.destino, { recursive: true });
  const pasta = join(o.destino, `pacote_${id}`);
  mkdirSync(pasta); // falha se já existir: nunca sobrescreve um pacote
  const segredos = o.segredos ?? [];
  const excluidos: ResultadoPacote["excluidos"] = [];
  const arquivos: ResultadoPacote["arquivos"] = [];
  const gravar = (rel: string, conteudo: Buffer, sanitizado: boolean) => {
    const alvo = join(pasta, rel);
    mkdirSync(dirname(alvo), { recursive: true });
    writeFileSync(alvo, conteudo, { flag: "wx" });
    arquivos.push({ caminho: rel.split(sep).join("/"), sha256: sha(conteudo), bytes: conteudo.length, sanitizado });
  };
  const vistos = new Set<string>();
  for (const origem of o.origens) {
    for (const f of listar(origem, excluidos)) {
      const motivo = motivoExclusao(f.abs);
      if (motivo) {
        excluidos.push({ origem: f.abs, motivo });
        continue;
      }
      let rel = join("arquivos", f.rel);
      for (let n = 2; vistos.has(rel.toLowerCase()); n += 1) rel = join("arquivos", `${n}_${f.rel}`);
      vistos.add(rel.toLowerCase());
      const s = sanitizarTexto(readFileSync(f.abs, "utf8"), segredos);
      gravar(rel, Buffer.from(s.texto, "utf8"), s.alterado);
    }
  }
  const resultados = o.resultados.map((r) => ({ id: r.id, caso: sanitizarTexto(r.caso, segredos).texto, resultado: r.resultado, ...(r.detalhe !== undefined ? { detalhe: sanitizarTexto(r.detalhe, segredos).texto } : {}) }));
  gravar("resultados.json", Buffer.from(JSON.stringify(resultados, null, 2), "utf8"), false);
  const resumo = resultados.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.resultado]: (acc[r.resultado] ?? 0) + 1 }), {});
  const indice = {
    id,
    criadoEm: agora.toISOString(),
    descricao: o.descricao ? sanitizarTexto(o.descricao, segredos).texto : null,
    casos: resultados.length,
    resumo,
    arquivos: arquivos.map((a) => ({ caminho: a.caminho, sha256: a.sha256, bytes: a.bytes, sanitizado: a.sanitizado })),
    excluidos: excluidos.map((e) => ({ origem: sanitizarTexto(e.origem, segredos).texto, motivo: e.motivo })),
    aviso: "pacote LOCAL de evidências de teste (dados sintéticos); sem credenciais, chaves, tokens ou dados reais; conferir com MANIFESTO.sha256",
  };
  gravar("indice.json", Buffer.from(JSON.stringify(indice, null, 2), "utf8"), false);
  const manifesto = arquivos.map((a) => `${a.sha256}  ${a.caminho}`).join("\n") + "\n";
  writeFileSync(join(pasta, "MANIFESTO.sha256"), manifesto, { flag: "wx" });
  return { id, pasta, arquivos, excluidos };
}

/** Confere um pacote: todo arquivo listado existe com o mesmo SHA-256 e nenhum arquivo fica fora do manifesto. */
export function conferirPacote(pasta: string): { ok: boolean; problemas: string[] } {
  const problemas: string[] = [];
  const man = join(pasta, "MANIFESTO.sha256");
  if (!existsSync(man)) return { ok: false, problemas: ["MANIFESTO.sha256 ausente"] };
  const listados = new Map<string, string>();
  for (const l of readFileSync(man, "utf8").split("\n").filter(Boolean)) {
    const m = /^([0-9A-F]{64}) {2}(.+)$/.exec(l);
    if (!m) {
      problemas.push(`linha inválida no manifesto: ${l.slice(0, 80)}`);
      continue;
    }
    listados.set(m[2]!, m[1]!);
  }
  for (const [rel, h] of listados) {
    const c = join(pasta, ...rel.split("/"));
    if (!existsSync(c)) problemas.push(`ausente: ${rel}`);
    else if (sha(readFileSync(c)) !== h) problemas.push(`SHA-256 divergente: ${rel}`);
  }
  const presentes: string[] = [];
  const andar = (d: string) => {
    for (const n of readdirSync(d)) {
      const c = join(d, n);
      if (lstatSync(c).isDirectory()) andar(c);
      else presentes.push(relative(pasta, c).split(sep).join("/"));
    }
  };
  andar(pasta);
  for (const p of presentes) if (p !== "MANIFESTO.sha256" && !listados.has(p)) problemas.push(`fora do manifesto: ${p}`);
  return { ok: problemas.length === 0, problemas };
}
