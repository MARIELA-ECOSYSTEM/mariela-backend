/**
 * Fase 60.4.3.4.21.2.11 (N3) — PROTEÇÃO e RECUPERAÇÃO da identidade da instância (PURA).
 *
 * A identidade é o documento `mariela_isolada_meta.identidade {_id:"instancia", instanciaId}` + a cópia local
 * `<raiz>/seguranca/instancia.json`. Antes, a coleção não tinha proteção: o `mariela_restore` podia inserir nela
 * (insert em qualquer banco) e o `mariela_guardiao` podia removê-la (dropCollection em qualquer banco).
 *
 * Agora:
 *   - `configurar-autenticacao` (bootstrap/root) CONGELA a coleção com o mesmo trio de validação do destino
 *     (validator {$expr:{$eq:[1,0]}}, strict, error): o restore não insere nem altera (sem bypassDocumentValidation),
 *     e nenhum papel operacional tem update/remove nela;
 *   - toda operação exige EXATAMENTE um documento, com a forma esperada, igual à cópia local E a coleção congelada.
 *
 * Limites (documentados): o guardião ainda tem `collMod` e `dropCollection` em qualquer banco — pode DESCONGELAR ou
 * REMOVER a coleção. Ambos são DETECTADOS (coleção não congelada / documento ausente ⇒ toda operação recusada, falha
 * fechada), não impedidos. Forjar uma identidade exigiria os DOIS papéis (o restore insere, o guardião congela).
 * Não há privilégio adicional concedido a nenhum papel.
 */

export interface FatosIdentidade {
  /** Documentos na coleção de identidade (null = coleção ausente). */
  documentos: { _id?: unknown; instanciaId?: unknown }[] | null;
  /** A coleção está congelada (trio completo)? */
  congelada: boolean;
  /** instanciaId da cópia local (null = ausente). Conteúdo ilegível deve ser tratado pelo chamador como erro. */
  local: string | null;
}

export type AcaoIdentidade =
  | { acao: "OK"; instanciaId: string }
  | { acao: "PROTEGER"; instanciaId: string; detalhe: string }
  | { acao: "CRIAR" }
  | { acao: "CRIAR_COPIA_LOCAL"; instanciaId: string; detalhe: string }
  | { acao: "RESTAURAR_DA_COPIA_LOCAL"; instanciaId: string; detalhe: string }
  | { acao: "RECUSAR"; detalhe: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Diagnóstico comum: o documento da instância (se houver exatamente um e bem formado). */
function documentoUnico(f: FatosIdentidade): { ok: true; instanciaId: string | null } | { ok: false; detalhe: string } {
  const docs = f.documentos ?? [];
  if (docs.length === 0) return { ok: true, instanciaId: null };
  if (docs.length > 1) return { ok: false, detalhe: `coleção de identidade com ${docs.length} documentos (esperado 1)` };
  const d = docs[0]!;
  if (d._id !== "instancia" || typeof d.instanciaId !== "string" || !UUID.test(d.instanciaId)) return { ok: false, detalhe: "documento de identidade com forma inesperada" };
  return { ok: true, instanciaId: d.instanciaId };
}

/**
 * Uso NORMAL (toda operação de restore/gestão/recuperação): só "OK" passa. Qualquer outra situação é recusada com o
 * motivo — a correção é `mongod-isolado.ps1 -Acao ConfigurarAutenticacao` (com a trava).
 */
export function conferirIdentidade(f: FatosIdentidade): { ok: true; instanciaId: string } | { ok: false; detalhe: string } {
  const d = documentoUnico(f);
  if (!d.ok) return d;
  if (!d.instanciaId) return { ok: false, detalhe: `identidade AUSENTE na instância${f.local ? " (cópia local presente)" : ""}` };
  if (!f.local) return { ok: false, detalhe: "cópia local da identidade AUSENTE" };
  if (f.local !== d.instanciaId) return { ok: false, detalhe: "identidade da instância DIFERENTE da cópia local" };
  if (!f.congelada) return { ok: false, detalhe: "coleção de identidade SEM proteção (não congelada) — possível adulteração" };
  return { ok: true, instanciaId: d.instanciaId };
}

/**
 * Plano do `configurar-autenticacao` (bootstrap). Nunca troca uma identidade existente; nunca recria a da instância a
 * partir da cópia local sem pedido EXPLÍCITO (`restaurarDaCopiaLocal`), porque isso vincularia a cópia a esta instância.
 */
export function planoIdentidade(f: FatosIdentidade, opcoes: { restaurarDaCopiaLocal?: boolean } = {}): AcaoIdentidade {
  const d = documentoUnico(f);
  if (!d.ok) return { acao: "RECUSAR", detalhe: `${d.detalhe} — nada alterado (intervenção manual)` };
  if (f.local !== null && !UUID.test(f.local)) return { acao: "RECUSAR", detalhe: "cópia local da identidade com forma inesperada — nada alterado" };
  if (d.instanciaId) {
    if (f.local && f.local !== d.instanciaId) return { acao: "RECUSAR", detalhe: "identidade local DIFERENTE da gravada na instância — nada alterado (intervenção manual)" };
    if (!f.local) return { acao: "CRIAR_COPIA_LOCAL", instanciaId: d.instanciaId, detalhe: "cópia local ausente: recriada a partir da instância" + (f.congelada ? "" : "; coleção será congelada") };
    if (!f.congelada) return { acao: "PROTEGER", instanciaId: d.instanciaId, detalhe: "identidade íntegra sem proteção: a coleção será congelada" };
    return { acao: "OK", instanciaId: d.instanciaId };
  }
  if (f.local) {
    if (!opcoes.restaurarDaCopiaLocal) return { acao: "RECUSAR", detalhe: "identidade local existe mas a instância não tem a sua (removida ou outra instância?) — nada alterado; para reinserir a partir da cópia local use -RestaurarIdentidadeLocal (decisão do operador)" };
    return { acao: "RESTAURAR_DA_COPIA_LOCAL", instanciaId: f.local, detalhe: "identidade reinserida a partir da cópia local por pedido explícito do operador; coleção congelada" };
  }
  return { acao: "CRIAR" };
}
