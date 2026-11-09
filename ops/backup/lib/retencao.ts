import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PREFIXOS, RETENCAO } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2 — retenção LOCAL (aprovada na 21.1/21.2): 14 diárias, 8 semanais, 12 mensais, 5 extraordinárias,
 * inválidos por 7 dias, nunca menos de 2 válidas, nunca a válida mais nova.
 *
 * Sem dupla contagem: as políticas diária/semanal/mensal são VAGAS POR PERÍODO, não marcas no arquivo. Cada conjunto
 * escolhe a cópia válida mais recente de cada período (dia, semana ISO, mês civil) entre os períodos mais recentes que
 * TÊM cópia; uma mesma cópia pode ocupar a vaga do seu dia, da sua semana e do seu mês ao mesmo tempo, mas existe uma
 * vez só. Só é removido o que não está em NENHUM conjunto. Conflito ou dúvida → preservar.
 */

export type ClasseBackup = "diario" | "extraordinario" | "invalido" | "legado" | "conflito";

export interface EntradaBackup {
  base: string;
  classe: ClasseBackup;
  /** Data LOCAL da execução (`yyyy-MM-dd`) — define dia/semana/mês. */
  dataLocal: string;
  /** Instante da execução (ISO com fuso) — ordenação. */
  instante: string;
}

export interface DecisaoRetencao {
  executada: boolean;
  manter: { base: string; motivos: string[] }[];
  remover: { base: string; motivo: string }[];
  observacoes: string[];
}

const RE_NOVO = new RegExp(`^(${PREFIXOS.diario}|${PREFIXOS.extraordinario}|${PREFIXOS.invalido})(\\d{8}_\\d{6})$`);
const RE_LEGADO = /^mariela_prod_\d{8}_\d{4}$/;
/** Todos os artefatos de um backup — a retenção nunca toca outro arquivo. */
export const SUFIXOS_DO_BACKUP = [".archive.gz", ".archive.gz.sha256", ".manifest.json", ".7z", ".7z.sha256", ".segunda-copia.json"] as const;

/** Semana ISO-8601 (`2026-W45`) de uma data `yyyy-MM-dd`, independente de fuso. */
export function semanaIso(dataLocal: string): string {
  const [a, m, d] = dataLocal.split("-").map(Number);
  const data = new Date(Date.UTC(a!, m! - 1, d!));
  const diaSemana = data.getUTCDay() || 7;
  data.setUTCDate(data.getUTCDate() + 4 - diaSemana);
  const inicioAno = new Date(Date.UTC(data.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((data.getTime() - inicioAno.getTime()) / 86_400_000 + 1) / 7);
  return `${data.getUTCFullYear()}-W${String(semana).padStart(2, "0")}`;
}

function maisRecentePorPeriodo(validos: EntradaBackup[], chave: (e: EntradaBackup) => string, quantidade: number): EntradaBackup[] {
  const escolhidos: EntradaBackup[] = [];
  const vistos = new Set<string>();
  for (const e of validos) {
    if (escolhidos.length >= quantidade) break; // antes de inserir: cota 0 não escolhe nada
    const k = chave(e);
    if (vistos.has(k)) continue;
    vistos.add(k);
    escolhidos.push(e);
  }
  return escolhidos;
}

export function planejarRetencao(
  entradas: EntradaBackup[],
  opcoes: { agora: Date; novoValidoBase: string | null; politica?: typeof RETENCAO },
): DecisaoRetencao {
  const politica = opcoes.politica ?? RETENCAO;
  const manterMap = new Map<string, string[]>();
  const marcar = (base: string, motivo: string) => manterMap.set(base, [...(manterMap.get(base) ?? []), motivo]);

  const novo = opcoes.novoValidoBase ? entradas.find((e) => e.base === opcoes.novoValidoBase) : undefined;
  if (!novo || (novo.classe !== "diario" && novo.classe !== "extraordinario")) {
    return {
      executada: false,
      manter: entradas.map((e) => ({ base: e.base, motivos: ["retenção não executada: sem novo backup válido confirmado nesta execução"] })),
      remover: [],
      observacoes: ["retenção NÃO executada (falha fechada): nenhum backup novo válido"],
    };
  }

  const porRecencia = [...entradas].sort((a, b) => b.instante.localeCompare(a.instante));
  const diarios = porRecencia.filter((e) => e.classe === "diario");
  const extras = porRecencia.filter((e) => e.classe === "extraordinario");

  for (const e of porRecencia) {
    if (e.classe === "legado") marcar(e.base, "legado (formato anterior, fora da política) — nunca removido automaticamente");
    if (e.classe === "conflito") marcar(e.base, "conflito entre nome e manifesto — preservado para análise");
  }
  for (const e of maisRecentePorPeriodo(diarios, (x) => x.dataLocal, politica.diarios)) marcar(e.base, `diário (${e.dataLocal})`);
  for (const e of maisRecentePorPeriodo(diarios, (x) => semanaIso(x.dataLocal), politica.semanais)) marcar(e.base, `semanal (${semanaIso(e.dataLocal)})`);
  for (const e of maisRecentePorPeriodo(diarios, (x) => x.dataLocal.slice(0, 7), politica.mensais)) marcar(e.base, `mensal (${e.dataLocal.slice(0, 7)})`);
  for (const e of extras.slice(0, politica.extraordinarios)) marcar(e.base, "extraordinário entre os mais recentes");

  const validosPorRecencia = porRecencia.filter((e) => e.classe === "diario" || e.classe === "extraordinario");
  if (validosPorRecencia[0]) marcar(validosPorRecencia[0].base, "backup válido mais recente");

  const limiteInvalidos = opcoes.agora.getTime() - politica.invalidosDias * 86_400_000;
  for (const e of porRecencia.filter((x) => x.classe === "invalido")) {
    const t = Date.parse(e.instante);
    if (!Number.isFinite(t) || t >= limiteInvalidos) marcar(e.base, `inválido com menos de ${politica.invalidosDias} dias (evidência)`);
  }

  // Piso de cópias válidas: devolve as mais recentes até atingir o mínimo.
  const validosMantidos = () => validosPorRecencia.filter((e) => manterMap.has(e.base)).length;
  for (const e of validosPorRecencia) {
    if (validosMantidos() >= politica.minimoValidos) break;
    if (!manterMap.has(e.base)) marcar(e.base, `piso de ${politica.minimoValidos} cópias válidas`);
  }

  const remover = porRecencia
    .filter((e) => !manterMap.has(e.base))
    .map((e) => ({
      base: e.base,
      motivo: e.classe === "invalido" ? `inválido há mais de ${politica.invalidosDias} dias` : `${e.classe} fora das vagas de retenção`,
    }));
  return {
    executada: true,
    manter: porRecencia.filter((e) => manterMap.has(e.base)).map((e) => ({ base: e.base, motivos: manterMap.get(e.base)! })),
    remover,
    observacoes: [],
  };
}

/** Lê o diretório (sem recursão) e classifica cada backup pelo MANIFESTO; nome e manifesto divergentes → conflito. */
export function listarBackups(diretorio: string): EntradaBackup[] {
  const arquivos = readdirSync(diretorio, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  const bases = new Set<string>();
  for (const nome of arquivos) {
    for (const sufixo of SUFIXOS_DO_BACKUP) {
      if (nome.endsWith(sufixo)) bases.add(nome.slice(0, -sufixo.length));
    }
  }
  const entradas: EntradaBackup[] = [];
  for (const base of bases) {
    if (RE_LEGADO.test(base)) {
      const m = /_(\d{4})(\d{2})(\d{2})_/.exec(base)!;
      entradas.push({ base, classe: "legado", dataLocal: `${m[1]}-${m[2]}-${m[3]}`, instante: `${m[1]}-${m[2]}-${m[3]}T00:00:00` });
      continue;
    }
    const m = RE_NOVO.exec(base);
    if (!m) continue; // arquivo fora do padrão: nunca tocado
    const prefixo = m[1]!;
    const carimbo = m[2]!;
    const dataDoNome = `${carimbo.slice(0, 4)}-${carimbo.slice(4, 6)}-${carimbo.slice(6, 8)}`;
    const caminhoManifesto = join(diretorio, `${base}.manifest.json`);
    let manifesto: { estado?: string; tipo?: string; dataLocal?: string; iniciadoEm?: string } | null = null;
    try {
      manifesto = JSON.parse(readFileSync(caminhoManifesto, "utf8"));
    } catch {
      manifesto = null;
    }
    const instante = manifesto?.iniciadoEm ?? `${dataDoNome}T00:00:00`;
    const dataLocal = manifesto?.dataLocal ?? dataDoNome;
    let classe: ClasseBackup;
    if (!manifesto) {
      classe = prefixo === PREFIXOS.invalido ? "invalido" : "conflito";
    } else if (manifesto.estado !== "VALIDO_LOCAL") {
      classe = prefixo === PREFIXOS.invalido ? "invalido" : "conflito";
    } else if (prefixo === PREFIXOS.diario && manifesto.tipo === "diario" && existsSync(join(diretorio, `${base}.archive.gz`))) {
      classe = "diario";
    } else if (prefixo === PREFIXOS.extraordinario && manifesto.tipo === "extraordinario" && existsSync(join(diretorio, `${base}.archive.gz`))) {
      classe = "extraordinario";
    } else {
      classe = "conflito";
    }
    entradas.push({ base, classe, dataLocal, instante });
  }
  return entradas;
}

/** Remove SÓ os artefatos conhecidos de cada base marcada para remoção. Devolve os arquivos efetivamente apagados. */
export function aplicarRetencao(diretorio: string, decisao: DecisaoRetencao): string[] {
  if (!decisao.executada) return [];
  const apagados: string[] = [];
  for (const { base } of decisao.remover) {
    if (!RE_NOVO.test(base)) continue; // defesa: nunca apaga legado/fora do padrão
    for (const sufixo of SUFIXOS_DO_BACKUP) {
      const caminho = join(diretorio, `${base}${sufixo}`);
      if (existsSync(caminho)) {
        rmSync(caminho);
        apagados.push(`${base}${sufixo}`);
      }
    }
  }
  return apagados;
}
