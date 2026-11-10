/**
 * Fase 60.4.3.4.21.2 — POLÍTICA de backup aprovada na Fase 60.4.3.4.21.1 (fonte de verdade única para os scripts
 * `ops/backup/*.ps1` e para a biblioteca `ops/backup/lib`). Mudar qualquer valor aqui é mudar a política: exige nova
 * aprovação do operador.
 */

/** Único banco de origem permitido. Qualquer outro (inclusive `test`) aborta o backup antes do dump. */
export const BANCO_ORIGEM = "marielaDB";

/**
 * LISTA POSITIVA das 27 coleções que entram no backup (fonte de verdade). O `mongodump` 100.17.0 não tem
 * `--nsInclude`; por isso o backup (1) recusa a origem se ela tiver coleção fora de `COLECOES_BACKUP ∪
 * COLECOES_EXCLUIDAS` ou se faltar alguma de `COLECOES_BACKUP`, (2) passa `--excludeCollection` só para as excluídas e
 * (3) confere no archive gerado que os namespaces são EXATAMENTE estes 27.
 */
export const COLECOES_BACKUP = [
  "adquirentes",
  "caixas",
  "campanhas",
  "clientes",
  "colecoes",
  "configuracoes",
  "eventos_adquirente",
  "eventos_auth",
  "eventos_caixa",
  "eventos_campanha",
  "eventos_cliente",
  "eventos_colecao",
  "eventos_configuracao",
  "eventos_fornecedor",
  "eventos_pdv_auth",
  "eventos_produto",
  "eventos_venda",
  "eventos_vendedor",
  "fornecedores",
  "movimentacoes_estoque",
  "movimentos_caixa",
  "produtos",
  "sequencias",
  "uploads_midia",
  "usuarios",
  "vendas",
  "vendedores",
] as const;

export type ColecaoBackup = (typeof COLECOES_BACKUP)[number];

/**
 * Fase 60.4.3.4.21.2.2 (R21-2.1-01) — COMO a assinatura detecta escrita em cada coleção (decidido pelo schema e pelos
 * escritores reais do código, nunca deduzido só pela presença de um timestamp):
 *   - `timestamp`: schema com `timestamps.updatedAt = "atualizadoEm"` — toda inserção/atualização pelo Mongoose mexe em
 *     `atualizadoEm`; assinatura = contagem + maior `atualizadoEm`/`criadoEm`;
 *   - `insercao`: só `criadoEm` (`updatedAt: false`) e NENHUMA atualização no código (append-only: trilhas `eventos_*`,
 *     ledger, movimentos de caixa) — assinatura = contagem + maior `criadoEm`;
 *   - `conteudo`: há atualização que NÃO mexe em timestamp (ex.: `uploads_midia` — reservar/descartar/limpar mudam
 *     `estado`/`tokenReserva` sem tocar `criadoEm`) ou não há timestamp (`sequencias`) — assinatura = contagem + SHA-256
 *     do conteúdo inteiro (determinístico, por `_id`), com limite de documentos (acima dele: falha fechada).
 * `camposData` alimentam a janela de 15 min (quando uma escrita aconteceu); atualizações sem data só são detectadas pela
 * comparação antes/depois do dump.
 */
export const ASSINATURA_POR_COLECAO: Record<ColecaoBackup, { estrategia: "timestamp" | "insercao" | "conteudo"; camposData: string[] }> = {
  adquirentes: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  caixas: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  campanhas: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  clientes: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  colecoes: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  configuracoes: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  fornecedores: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  produtos: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  usuarios: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  vendas: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  vendedores: { estrategia: "timestamp", camposData: ["atualizadoEm", "criadoEm"] },
  eventos_adquirente: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_auth: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_caixa: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_campanha: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_cliente: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_colecao: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_configuracao: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_fornecedor: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_pdv_auth: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_produto: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_venda: { estrategia: "insercao", camposData: ["criadoEm"] },
  eventos_vendedor: { estrategia: "insercao", camposData: ["criadoEm"] },
  movimentacoes_estoque: { estrategia: "insercao", camposData: ["criadoEm"] },
  movimentos_caixa: { estrategia: "insercao", camposData: ["criadoEm"] },
  // Datas que EXISTEM em uploads_midia (melhoram a janela), mas reservar/descartar/limpar não as atualizam — por isso hash.
  uploads_midia: { estrategia: "conteudo", camposData: ["criadoEm", "reservadoEm", "confirmadoEm", "removidoEm", "limpezaIniciadaEm"] },
  sequencias: { estrategia: "conteudo", camposData: [] },
};

/** Sessões: nunca entram no backup. O backend recria as coleções e os índices (inclusive TTL) no boot; todos fazem login de novo. */
export const COLECOES_EXCLUIDAS = ["refresh_tokens", "vendedor_refresh_tokens"] as const;

/**
 * Referência INFORMATIVA (estado lido em 09/11/2026): 103 índices nas 27 coleções. A validação usa os índices
 * REAIS lidos da origem no momento do backup; divergência desta referência só gera aviso no manifesto.
 */
export const INDICES_REFERENCIA = 103;

/** Janela operacional (Fase 21.2): horário-alvo e período mínimo sem escrita antes da coleta. */
export const JANELA = { horaAlvo: 23, minutoAlvo: 45, quietMinutos: 15 } as const;

/** Margem para considerar uma linha de reconciliação "próxima do retry" (o worker poderia escrever durante o dump). */
export const MARGEM_RECONCILIACAO_MINUTOS = 60;

/** Retenção aprovada (cópias LOCAIS). */
export const RETENCAO = {
  diarios: 14,
  semanais: 8,
  mensais: 12,
  extraordinarios: 5,
  invalidosDias: 7,
  minimoValidos: 2,
} as const;

/** Prefixos de arquivo — a classe de um backup também é visível no nome, para nunca confundir um inválido com um válido. */
export const PREFIXOS = { diario: "mariela_prod_", extraordinario: "mariela_extra_", invalido: "mariela_invalido_" } as const;

/**
 * Instância ISOLADA de restore: só esta porta, só loopback. Fase 60.4.3.4.21.2.2 (R21-2.1-11) — a IDENTIDADE da
 * instância (não só a porta) é exigida antes de qualquer operação: `dbPath` = `<raiz>\data-27118` com o marcador,
 * bind só `127.0.0.1`, replica set `rs-restore`, processo = o `mongod.exe` instalado em `<raiz>`.
 */
export const RESTORE = {
  host: "127.0.0.1",
  porta: 27118,
  padraoBanco: /^mariela_restore_\d{8}_\d{6}$/,
  replicaSet: "rs-restore",
  subdiretorioDados: "data-27118",
  marcador: ".mariela-restore-isolado",
  /**
   * Fase 60.4.3.4.21.2.4 (R21-2.3-01) — POSSE do destino: documento `_id: "posse"` (único) na coleção de controle,
   * inserido ANTES do mongorestore, com o `execucaoId` da execução dona. Fase 21.2.6: a posse é PERSISTENTE (máquina de
   * estados em `ESTADOS_DESTINO`) e só sai com a limpeza comprovada.
   */
  colecaoPosse: "_mariela_restore_posse",
  /** Trava de exclusão mútua LOCAL (arquivo aberto com FileShare.Read durante TODA a execução), relativa à raiz. */
  arquivoTrava: "locks/restore.lock",
  /**
   * Fase 60.4.3.4.21.2.6 (A-03) — AUTENTICAÇÃO da instância isolada (`--auth --keyFile`). Credenciais SINTÉTICAS geradas
   * localmente, guardadas com DPAPI (só a conta Windows que as criou as decifra), relativas à raiz. Nunca em argumento.
   */
  autenticacao: {
    authSource: "admin",
    /** Bootstrap: `root`, usado SÓ para configurar usuários e desligar a instância. Nunca pelo fluxo de restore. */
    usuarioAdmin: "mariela_bootstrap",
    /** Usuário do fluxo de restore: papel `marielaRestore` (mínimo; sem bypass, sem update/remove de dados, sem dropDatabase). */
    usuarioRestore: "mariela_restore",
    papelRestore: "marielaRestore",
    /** Usuário só-leitura (inspeção e testes de recusa). */
    usuarioLeitor: "mariela_leitor",
    arquivoChave: "seguranca/mongod.key",
    credenciais: { admin: "seguranca/admin.cred", restore: "seguranca/restore.cred", leitor: "seguranca/leitor.cred" },
  },
} as const;

/**
 * Fase 60.4.3.4.21.2.6 (A-03) — privilégios do papel `marielaRestore`, o MÍNIMO para o fluxo:
 *   - mongorestore: insert, createCollection, createIndex, listCollections/listIndexes;
 *   - validação/integridade: find, listCollections, listIndexes, collStats, dbStats; identidade: getCmdLineOpts, listDatabases;
 *   - congelamento: collMod; limpeza comprovada: dropCollection (com `collectionUUID`);
 *   - posse: update/remove SÓ na coleção de controle.
 * NÃO tem: bypassDocumentValidation, update/remove em coleções de dados, dropDatabase, renameCollectionSameDB, shutdown,
 * nem gestão de usuários. (Observação comprovada: find+insert+createIndex+dropCollection permitem `renameCollection` no
 * mesmo banco; por isso toda remoção exige o `collectionUUID` verificado.)
 */
export const PRIVILEGIOS_RESTORE = [
  { resource: { cluster: true }, actions: ["listDatabases", "getCmdLineOpts"] },
  { resource: { db: "", collection: "" }, actions: ["find", "insert", "createCollection", "createIndex", "dropCollection", "collMod", "listCollections", "listIndexes", "collStats", "dbStats"] },
  { resource: { db: "", collection: "_mariela_restore_posse" }, actions: ["update", "remove"] },
] as const;

/**
 * Fase 60.4.3.4.21.2.6 (A-01) — MÁQUINA DE ESTADOS do destino de restore (persistida no documento de posse).
 *   PREPARANDO → RESTAURANDO → VALIDANDO → VERIFICADO → LIBERACAO_AUTORIZADA (só por comando explícito do operador)
 *   PREPARANDO|RESTAURANDO|VALIDANDO → FALHOU_DESTINO_PARCIAL (falha depois de iniciar a escrita)
 *   FALHOU_DESTINO_PARCIAL|VERIFICADO|LIBERACAO_AUTORIZADA|INTERVENCAO_NECESSARIA|interrompidos → CANCELADO_COM_LIMPEZA_COMPROVADA
 *   qualquer estado não final → INTERVENCAO_NECESSARIA (a segurança de seguir ou remover não pôde ser provada)
 * CANCELADO_COM_LIMPEZA_COMPROVADA é final: o banco deixou de existir (registrado no relatório da operação).
 */
export const ESTADOS_DESTINO = [
  "PREPARANDO",
  "RESTAURANDO",
  "VALIDANDO",
  "FALHOU_DESTINO_PARCIAL",
  "VERIFICADO",
  "LIBERACAO_AUTORIZADA",
  "CANCELADO_COM_LIMPEZA_COMPROVADA",
  "INTERVENCAO_NECESSARIA",
] as const;
export type EstadoDestino = (typeof ESTADOS_DESTINO)[number];

export const TRANSICOES_DESTINO: Record<EstadoDestino, readonly EstadoDestino[]> = {
  PREPARANDO: ["RESTAURANDO", "FALHOU_DESTINO_PARCIAL", "INTERVENCAO_NECESSARIA", "CANCELADO_COM_LIMPEZA_COMPROVADA"],
  RESTAURANDO: ["VALIDANDO", "FALHOU_DESTINO_PARCIAL", "INTERVENCAO_NECESSARIA", "CANCELADO_COM_LIMPEZA_COMPROVADA"],
  VALIDANDO: ["VERIFICADO", "FALHOU_DESTINO_PARCIAL", "INTERVENCAO_NECESSARIA", "CANCELADO_COM_LIMPEZA_COMPROVADA"],
  FALHOU_DESTINO_PARCIAL: ["CANCELADO_COM_LIMPEZA_COMPROVADA", "INTERVENCAO_NECESSARIA"],
  VERIFICADO: ["LIBERACAO_AUTORIZADA", "CANCELADO_COM_LIMPEZA_COMPROVADA", "INTERVENCAO_NECESSARIA"],
  LIBERACAO_AUTORIZADA: ["CANCELADO_COM_LIMPEZA_COMPROVADA", "INTERVENCAO_NECESSARIA"],
  INTERVENCAO_NECESSARIA: ["CANCELADO_COM_LIMPEZA_COMPROVADA"],
  CANCELADO_COM_LIMPEZA_COMPROVADA: [],
};

export function transicaoPermitida(de: EstadoDestino, para: EstadoDestino): boolean {
  return TRANSICOES_DESTINO[de]?.includes(para) ?? false;
}

/** Estados de uma execução que NÃO terminou (só a recuperação manual, com o dono comprovadamente encerrado, age neles). */
export const ESTADOS_INTERROMPIVEIS: readonly EstadoDestino[] = ["PREPARANDO", "RESTAURANDO", "VALIDANDO", "FALHOU_DESTINO_PARCIAL", "INTERVENCAO_NECESSARIA"];

/**
 * Sequência → campo de código da entidade (para conferir que `sequencias.valor` ≥ maior código já emitido; senão a
 * próxima criação colide com um código existente). Extraído do código: `*_constants.ts` + `proximoCodigo`.
 */
export const SEQUENCIAS_E_CODIGOS: Record<string, { colecao: string; campo: string }> = {
  venda: { colecao: "vendas", campo: "numero" },
  produto: { colecao: "produtos", campo: "codProduto" },
  caixa: { colecao: "caixas", campo: "codigo" },
  usuario: { colecao: "usuarios", campo: "codigo" },
  cliente: { colecao: "clientes", campo: "codigo" },
  vendedor: { colecao: "vendedores", campo: "codigo" },
  fornecedor: { colecao: "fornecedores", campo: "codigo" },
  colecao: { colecao: "colecoes", campo: "codigo" },
  campanha: { colecao: "campanhas", campo: "codigo" },
};

/** Texto fixo do manifesto: o backup NÃO é um snapshot transacional. */
export const DECLARACAO_CONSISTENCIA =
  "Consistência OPERACIONAL: o mongodump de um banco lê uma coleção por vez (não é snapshot transacional). A coerência entre coleções depende da janela sem escrita e das verificações registradas neste manifesto (assinaturas antes/depois iguais). Não há prova matemática de ausência de escrita.";
