import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import type { Configuration } from "../../../config/configuration.js";
import { ESPERA_ENTRE_TENTATIVAS_R2_MS, TRANSPORTE_R2_PADRAO } from "../media.constants.js";
import type { AssinarUploadParams, InspecaoObjeto, MediaStorage } from "../media.types.js";

/**
 * Storage do Cloudflare R2 (API S3). A assinatura é calculada localmente; `HeadObject`, `GetObject` (Range) e
 * `DeleteObject` (Fase 60.1) falam com o R2. As credenciais vêm exclusivamente de `storage.r2` (variáveis de
 * ambiente) e nunca são logadas nem devolvidas. Qualquer falha do provedor vira `STORAGE_UNAVAILABLE`; objeto
 * ausente (404) é um resultado normal, nunca erro.
 *
 * Fase 60.4.1 — toda chamada de rede passa por `enviar`: prazo por tentativa (conexão + resposta) aplicado com
 * `AbortSignal` e novas tentativas SÓ para falhas transitórias (ver `ehFalhaTransitoria`), até `maxTentativas`.
 */
@Injectable()
export class R2PresignerProvider implements MediaStorage {
  private readonly logger = new Logger(R2PresignerProvider.name);
  private cliente: S3Client | null = null;

  constructor(private readonly configService: ConfigService<Configuration>) {}

  async assinarUpload({ key, contentType, contentLength, expiresInSeconds, cacheControl }: AssinarUploadParams): Promise<string> {
    const comando = new PutObjectCommand({
      Bucket: this.bucket(),
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
      ...(cacheControl ? { CacheControl: cacheControl } : {}),
    });
    try {
      return await getSignedUrl(this.obterCliente(), comando, {
        expiresIn: expiresInSeconds,
        // Por padrão o presigner assina só `host` e `content-length`. `content-type` PRECISA entrar na assinatura: sem
        // isso o cliente poderia enviar outro tipo (ex.: text/html) para uma URL assinada como imagem. Fase 60.1: o
        // `cache-control` dos uploads da galeria também é assinado, então o objeto nasce com o cache aprovado.
        signableHeaders: new Set(["content-type", "content-length", ...(cacheControl ? ["cache-control"] : [])]),
      });
    } catch (erro) {
      throw this.indisponivel("assinar upload", erro);
    }
  }

  async inspecionarObjeto(key: string): Promise<InspecaoObjeto> {
    try {
      const resposta = await this.enviar((abortSignal) => this.obterCliente().send(new HeadObjectCommand({ Bucket: this.bucket(), Key: key }), { abortSignal }));
      return { existe: true, tamanho: resposta.ContentLength ?? null, contentType: resposta.ContentType ?? null };
    } catch (erro) {
      if (statusHttp(erro) === 404) return { existe: false };
      throw this.indisponivel("inspecionar objeto", erro);
    }
  }

  async lerPrimeirosBytes(key: string, quantidade: number): Promise<Uint8Array | null> {
    try {
      return await this.enviar(async (abortSignal) => {
        const resposta = await this.obterCliente().send(new GetObjectCommand({ Bucket: this.bucket(), Key: key, Range: `bytes=0-${quantidade - 1}` }), { abortSignal });
        // O corpo é lido DENTRO da tentativa: o mesmo prazo vale para ele.
        return resposta.Body ? await resposta.Body.transformToByteArray() : new Uint8Array(0);
      });
    } catch (erro) {
      const status = statusHttp(erro);
      if (status === 404) return null;
      // 416: objeto vazio (nenhum byte no intervalo pedido) — a conferência de assinatura recusa.
      if (status === 416) return new Uint8Array(0);
      throw this.indisponivel("ler bytes do objeto", erro);
    }
  }

  async excluirObjeto(key: string): Promise<void> {
    try {
      await this.enviar((abortSignal) => this.obterCliente().send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: key }), { abortSignal }));
    } catch (erro) {
      throw this.indisponivel("excluir objeto", erro);
    }
  }

  /** Fase 60.4.1 — timeouts e tentativas efetivos (configurados ou os padrões do projeto). */
  transporte(): { timeoutConexaoMs: number; timeoutRequisicaoMs: number; maxTentativas: number } {
    return this.configService.get("storage", { infer: true })?.transporte ?? TRANSPORTE_R2_PADRAO;
  }

  /** Prazo de UMA tentativa: conexão + resposta. */
  prazoPorTentativaMs(): number {
    const { timeoutConexaoMs, timeoutRequisicaoMs } = this.transporte();
    return timeoutConexaoMs + timeoutRequisicaoMs;
  }

  /** Pior caso de uma operação: todas as tentativas no prazo máximo + as esperas entre elas. */
  prazoTotalMs(): number {
    const { maxTentativas } = this.transporte();
    let esperas = 0;
    for (let novaTentativa = 1; novaTentativa < maxTentativas; novaTentativa += 1) esperas += novaTentativa * ESPERA_ENTRE_TENTATIVAS_R2_MS;
    return maxTentativas * this.prazoPorTentativaMs() + esperas;
  }

  /**
   * Executa uma chamada ao R2 com prazo por tentativa (`AbortSignal.timeout`) e novas tentativas SÓ para falhas
   * transitórias. O prazo é aplicado aqui porque, medido nesta fase, no runtime Bun os timeouts do handler HTTP do
   * SDK não interrompem uma requisição sem resposta; e as novas tentativas do SDK ficam desligadas (`maxAttempts: 1`)
   * para nunca multiplicar tentativas em duas camadas.
   */
  private async enviar<T>(chamada: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
    const { maxTentativas } = this.transporte();
    for (let tentativa = 1; ; tentativa += 1) {
      try {
        return await chamada(AbortSignal.timeout(this.prazoPorTentativaMs()));
      } catch (erro) {
        if (tentativa >= maxTentativas || !ehFalhaTransitoria(erro)) throw erro;
        await new Promise<void>((retomar) => setTimeout(retomar, tentativa * ESPERA_ENTRE_TENTATIVAS_R2_MS));
      }
    }
  }

  /** Registra só a operação e o NOME do erro (nunca credenciais, URL assinada ou corpo da resposta). */
  private indisponivel(operacao: string, erro: unknown): ApiException {
    const nome = erro instanceof Error ? erro.name : typeof erro;
    this.logger.warn(`Falha no storage de mídia ao ${operacao} (${nome}${statusHttp(erro) ? `, HTTP ${statusHttp(erro)}` : ""}).`);
    return ApiException.storageUnavailable();
  }

  private bucket(): string {
    return this.configService.get("storage", { infer: true })!.r2.bucketName;
  }

  /** Endpoint S3 do R2 da conta. `protected` só para os testes apontarem para um servidor HTTP local. */
  protected endpoint(accountId: string): string {
    return `https://${accountId}.r2.cloudflarestorage.com`;
  }

  /** Endereçamento por caminho (`/bucket/chave`) — desligado para o R2; usado só pelo servidor local dos testes. */
  protected enderecamentoPorCaminho(): boolean {
    return false;
  }

  private obterCliente(): S3Client {
    if (!this.cliente) {
      const { accountId, accessKeyId, secretAccessKey } = this.configService.get("storage", { infer: true })!.r2;
      const { timeoutConexaoMs, timeoutRequisicaoMs } = this.transporte();
      this.cliente = new S3Client({
        region: "auto",
        endpoint: this.endpoint(accountId),
        forcePathStyle: this.enderecamentoPorCaminho(),
        credentials: { accessKeyId, secretAccessKey },
        // O R2 não aceita os checksums adicionais que versões recentes do SDK incluem por padrão na URL assinada.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        // Fase 60.4.1 — as novas tentativas são feitas por `enviar` (prazo por tentativa efetivo); o SDK tenta uma vez.
        maxAttempts: 1,
        // Mantidos como reforço (efetivos em Node); no Bun quem garante o prazo é o `AbortSignal` de `enviar`.
        requestHandler: { connectionTimeout: timeoutConexaoMs, requestTimeout: timeoutRequisicaoMs },
      });
    }
    return this.cliente;
  }
}

/** Status HTTP de um erro do SDK (`$metadata.httpStatusCode`), quando houver. */
function statusHttp(erro: unknown): number | undefined {
  if (typeof erro !== "object" || erro === null || !("$metadata" in erro)) return undefined;
  const metadata = (erro as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}

/** Erros SEM resposta HTTP que indicam falha passageira de rede ou prazo da tentativa esgotado. */
const FALHAS_DE_REDE_TRANSITORIAS = new Set([
  "AbortError",
  "TimeoutError",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ConnectionRefused",
  "ConnectionClosed",
  "NetworkingError",
]);

/**
 * Transitória = vale tentar de novo: resposta 5xx ou 429 (limitação), ou falha de rede/prazo sem resposta HTTP.
 * Permanente = falha na hora: qualquer outra resposta 4xx (403 credencial/permissão, 404, 400, 416...) e erros sem
 * resposta que não sejam de rede (configuração, credencial ausente, serialização).
 */
export function ehFalhaTransitoria(erro: unknown): boolean {
  const status = statusHttp(erro);
  if (status !== undefined) return status >= 500 || status === 429;
  if (typeof erro !== "object" || erro === null) return false;
  const nome = "name" in erro && typeof erro.name === "string" ? erro.name : "";
  const codigo = "code" in erro && typeof erro.code === "string" ? erro.code : "";
  return FALHAS_DE_REDE_TRANSITORIAS.has(nome) || FALHAS_DE_REDE_TRANSITORIAS.has(codigo);
}
