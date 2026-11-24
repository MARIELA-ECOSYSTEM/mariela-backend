import { Logger } from "@nestjs/common";
import type { WhatsappConfig } from "../../../config/configuration.js";
import { normalizarTelefoneParaWhatsapp } from "../utils/normalizar-telefone-whatsapp.util.js";
import { ClienteHttpMetaWhatsapp, type FetchMeta } from "./meta/cliente-http-meta.js";
import { lerConfiguracaoMeta } from "./meta/configuracao-meta.js";
import { ProvedorEnvioMetaCloudApi } from "./meta/provedor-envio-meta-cloud-api.js";
import { ProvedorEnvioDesativado } from "./provedor-envio-desativado.js";
import type { ProvedorEnvioWhatsapp } from "./provedor-envio-whatsapp.interface.js";

const logger = new Logger("ProvedorEnvioWhatsapp");

function numeroDaLoja(ownerPhone: string | undefined): string | null {
  if (!ownerPhone?.trim()) return null;
  try {
    return normalizarTelefoneParaWhatsapp(ownerPhone);
  } catch {
    return null;
  }
}

/**
 * Fase 22.8.9.10.4 — ÚNICO ponto que escolhe o provedor do envio por template (fábrica do `PROVEDOR_ENVIO_WHATSAPP`).
 * - padrão (ausente/vazio/`desativado`): `ProvedorEnvioDesativado` — nenhuma chamada de rede;
 * - `meta-cloud-api` com configuração completa e válida: `ProvedorEnvioMetaCloudApi`;
 * - `meta-cloud-api` com configuração incompleta/inválida: DESATIVADO, com aviso que lista só os NOMES dos campos.
 * O Backoffice não escolhe provedor nem fornece credencial: tudo vem da configuração do backend.
 * `fetchImpl` existe só para os testes.
 */
export function criarProvedorEnvioWhatsapp(whatsapp: WhatsappConfig | undefined, fetchImpl?: FetchMeta): ProvedorEnvioWhatsapp {
  if (whatsapp?.provedorEnvio !== "meta-cloud-api") return new ProvedorEnvioDesativado();

  const leitura = lerConfiguracaoMeta(whatsapp.meta);
  if (!leitura.valida) {
    logger.warn(
      JSON.stringify({ evento: "whatsapp.provedor.meta_configuracao_invalida", camposInvalidos: leitura.camposInvalidos, provedorEfetivo: "desativado" }),
    );
    return new ProvedorEnvioDesativado();
  }
  logger.log(JSON.stringify({ evento: "whatsapp.provedor.selecionado", provedor: "meta-cloud-api", graphApiVersion: leitura.config.graphApiVersion }));
  return new ProvedorEnvioMetaCloudApi(leitura.config, new ClienteHttpMetaWhatsapp(fetchImpl), numeroDaLoja(whatsapp.ownerPhone));
}
