/**
 * Fase 60.4.3.4.1 — limites da validação estrutural das mídias da galeria (decisões aprovadas na fase; ver
 * `auditorias/Fase-60.4.3.4-Auditoria-Validacao-Estrutural.md`). Os limites de TAMANHO continuam sendo os de
 * `TAMANHO_MAXIMO_BYTES` (5 MiB imagem, 15 MiB vídeo) e não são repetidos aqui.
 */
export const LIMITES_VALIDACAO_MIDIA = {
  /** Largura × altura máxima de imagem (e de vídeo), conferida no CABEÇALHO, antes de alocar qualquer pixel. */
  maxPixels: 25_000_000,
  /** Maior lado aceito: o máximo representável em JPEG/WebP (0x3FFF), o mesmo padrão do `Bun.Image`/Sharp. */
  maxLado: 16_383,
  /** GIF animado: quantidade máxima de quadros. */
  maxQuadrosGif: 100,
  /** Duração máxima de vídeo, em segundos. */
  maxDuracaoVideoSegundos: 30,
  /** JPEG progressivo: quantidade máxima de scans (o típico é ~10) — defesa contra scans patológicos. */
  maxScansJpeg: 64,
  /** JPEG com imagens anexas reconhecidas (MPF/Ultra HDR) depois do EOI: quantidade máxima de imagens extras. */
  maxImagensAnexasJpeg: 4,
  /** PNG: quantidade máxima de chunks. */
  maxChunksPng: 10_000,
  /** MP4: quantidade máxima de caixas percorridas e de amostras somadas em todas as trilhas. */
  maxCaixasMp4: 10_000,
  maxAmostrasMp4: 200_000,
} as const;

/** Prazo TOTAL de uma validação (espera na fila + subprocesso). Esgotado: o subprocesso é encerrado e a resposta é 503. */
export const PRAZO_VALIDACAO_MIDIA_MS = 10_000;

/**
 * Validações simultâneas por instância da API (as demais esperam na fila, dentro do prazo total).
 * Fase 60.4.3.4.3 — reduzido de 2 para 1: a instância do Render tem 512 MiB e duas validações pesadas (25 MP)
 * mediram ~490–510 MiB no total (Windows, Fase 60.4.3.4.2). Com 1, o pior caso medido fica em ~380 MiB.
 */
export const CONCORRENCIA_VALIDACAO_MIDIA = 1;

/** Teto de bytes aceitos pelo subprocesso na entrada (o maior limite de tamanho, 15 MiB). */
export const BYTES_MAXIMOS_VALIDACAO = 15 * 1024 * 1024;

/** Codecs permitidos (Fase 60.4.3.4.1): vídeo H.264 (`avc1`/`avc3`); áudio AAC (`mp4a` com objectTypeIndication AAC). */
export const CODECS_VIDEO_PERMITIDOS: readonly string[] = ["avc1", "avc3"];
export const CODECS_AUDIO_PERMITIDOS: readonly string[] = ["mp4a"];
/** `objectTypeIndication` do `esds` que são AAC: MPEG-4 Audio (0x40) e MPEG-2 AAC Main/LC/SSR (0x66–0x68). */
export const OTI_AAC: readonly number[] = [0x40, 0x66, 0x67, 0x68];
