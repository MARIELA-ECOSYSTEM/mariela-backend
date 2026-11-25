import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import type { ApiMeta } from "../../../common/types/api-response.interface.js";
import { ClientesRepository } from "../../clientes/clientes.repository.js";
import { BloqueiosWhatsappService } from "../bloqueios/bloqueios-whatsapp.service.js";
import { ehChaveDuplicada } from "../bloqueios/bloqueios-whatsapp.repository.js";
import type {
  EnviarTemplateWhatsappDto,
  EnviarTextoWhatsappDto,
  LiberarReenvioWhatsappDto,
  ListarMensagensWhatsappQueryDto,
} from "../dto/envios-whatsapp.dto.js";
import { avaliarJanela, type SituacaoJanela } from "../janela/janela-atendimento.js";
import { JanelasWhatsappRepository } from "../janela/janelas-whatsapp.repository.js";
import { CONFIG_WEBHOOK_WHATSAPP, type ConfiguracaoWebhookMeta } from "../webhook/configuracao-webhook-meta.js";
import {
  PROVEDOR_ENVIO_WHATSAPP,
  type ProvedorEnvioWhatsapp,
  type ResultadoEnvioProvedorWhatsapp,
} from "../providers/provedor-envio-whatsapp.interface.js";
import type { MensagemWhatsappDocument } from "../schemas/mensagem-whatsapp.schema.js";
import { obterTemplateDoCatalogo, renderizarPrevia, resolverParametros } from "../templates/catalogo-templates-whatsapp.js";
import { TemplatesWhatsappService, type TemplateWhatsappPublico } from "../templates/templates-whatsapp.service.js";
import { anoCivilDoEnvio, chaveDeduplicacaoCampanha } from "../utils/ano-campanha.util.js";
import { mascararTelefone } from "../utils/mascarar-telefone.util.js";
import { normalizarTelefoneParaWhatsapp } from "../utils/normalizar-telefone-whatsapp.util.js";
import {
  LIMITE_TEXTO_LIVRE_WHATSAPP,
  PRAZO_MINIMO_LIBERAR_INDETERMINADA_MS,
  type CodigoErroEnvioWhatsapp,
  type EstadoMensagemWhatsapp,
  type MotivoTextoLivreIndisponivel,
  type OrigemMensagemWhatsapp,
  type TipoCampanhaWhatsapp,
  type TipoMensagemWhatsapp,
} from "./envios-whatsapp.constants.js";
import { podeLiberarReenvio } from "./maquina-estados-whatsapp.js";
import { MensagensWhatsappRepository } from "./mensagens-whatsapp.repository.js";

/**
 * Resposta pública de uma mensagem — telefone sempre mascarado; nunca valores de parâmetros de template. `texto` só
 * existe em `TEXTO` (o texto livre que o operador pediu); `template` só em `TEMPLATE`.
 */
export interface MensagemWhatsappDto {
  id: string;
  idempotencyKey: string;
  tipo: TipoMensagemWhatsapp;
  destinatario: { tipo: "CLIENTE"; id: string; telefoneMascarado: string };
  template: { chave: string; categoria: string } | null;
  texto: string | null;
  estado: EstadoMensagemWhatsapp;
  erro: { codigo: CodigoErroEnvioWhatsapp; mensagem: string } | null;
  origem: OrigemMensagemWhatsapp;
  campanha: { tipo: TipoCampanhaWhatsapp; ano: number } | null;
  liberacao: { em: string; motivo: string | null } | null;
  criadoEm: string;
  atualizadoEm: string;
  aceitaEm: string | null;
  entregueEm: string | null;
  lidaEm: string | null;
  falhaEm: string | null;
}

const MENSAGEM_ERRO: Record<CodigoErroEnvioWhatsapp, string> = {
  NAO_ENVIADA: "A mensagem não chegou a ser enviada.",
  PROVEDOR_INDISPONIVEL: "O serviço de WhatsApp estava indisponível; a mensagem não foi enviada.",
  SEM_WHATSAPP: "O número não pode receber mensagens pelo WhatsApp (sem WhatsApp ou indisponível).",
  OPT_OUT_MARKETING: "O cliente optou por não receber mensagens de marketing.",
  LIMITE_MARKETING_DESTINATARIO: "O WhatsApp limitou as mensagens de marketing para este cliente. Tente outro dia.",
  TEMPLATE_INVALIDO: "O modelo de mensagem foi recusado pelo WhatsApp.",
  LIMITE_TAXA: "Limite de envio atingido; a mensagem não foi enviada.",
  CREDENCIAL_INVALIDA: "A integração de WhatsApp está com a credencial inválida.",
  RECUSADA: "O WhatsApp recusou a mensagem.",
  JANELA_FECHADA: "O WhatsApp recusou o texto livre: a janela de 24 horas desde a última mensagem do cliente estava fechada.",
  INDETERMINADO: "Não foi possível confirmar se a mensagem foi enviada. Ela não será reenviada automaticamente.",
};

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function paraMensagemDto(m: MensagemWhatsappDocument): MensagemWhatsappDto {
  return {
    id: String(m._id),
    idempotencyKey: m.idempotencyKey,
    tipo: m.tipo ?? "TEMPLATE",
    destinatario: { tipo: m.destinatarioTipo, id: String(m.destinatarioId), telefoneMascarado: mascararTelefone(m.telefoneE164) },
    template: m.templateChave !== null && m.templateCategoria !== null ? { chave: m.templateChave, categoria: m.templateCategoria } : null,
    texto: m.tipo === "TEXTO" ? m.texto : null,
    estado: m.estado,
    erro: m.erroCodigo ? { codigo: m.erroCodigo, mensagem: MENSAGEM_ERRO[m.erroCodigo] } : null,
    origem: m.origem,
    campanha: m.campanhaTipo && m.campanhaAno !== null ? { tipo: m.campanhaTipo, ano: m.campanhaAno } : null,
    liberacao: m.liberadaEm ? { em: m.liberadaEm.toISOString(), motivo: m.motivoLiberacao } : null,
    criadoEm: m.criadoEm.toISOString(),
    atualizadoEm: m.atualizadoEm.toISOString(),
    aceitaEm: iso(m.aceitaEm),
    entregueEm: iso(m.entregueEm),
    lidaEm: iso(m.lidaEm),
    falhaEm: iso(m.falhaEm),
  };
}

/** Hash do conteúdo pedido — a mesma chave de idempotência só vale para o MESMO pedido. */
export function hashConteudoEnvio(dto: EnviarTemplateWhatsappDto): string {
  const canonico = JSON.stringify({
    destinatarioTipo: dto.destinatario.tipo,
    destinatarioId: dto.destinatario.id,
    template: dto.template,
    campanha: dto.campanha?.tipo ?? null,
  });
  return createHash("sha256").update(canonico).digest("hex");
}

/**
 * Fase 22.8.9.10.7.4 — hash do pedido de TEXTO livre (destinatário + texto já aparado). Forma diferente da do template
 * (campo `tipo`): a mesma chave nunca serve para um template e um texto.
 */
export function hashConteudoTexto(destinatarioId: string, texto: string): string {
  return createHash("sha256").update(JSON.stringify({ tipo: "TEXTO", destinatarioTipo: "CLIENTE", destinatarioId, texto })).digest("hex");
}

/** Caracteres de controle (exceto tabulação e quebras de linha) e surrogates isolados: nunca são texto legítimo. */
const CONTROLE_PROIBIDO = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const SURROGATE_ISOLADO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Fase 22.8.9.10.7.4 — valida e apara o texto livre (o DTO já exige string de 1 a 4096 caracteres). O texto aparado é o
 * que é gravado, conferido pela idempotência e enviado. Lança `VALIDATION_ERROR` (nada é gravado nem enviado).
 */
export function validarTextoLivre(bruto: string): string {
  const texto = bruto.trim();
  const erro = (message: string) => ApiException.validation("Texto inválido.", [{ field: "texto", message }]);
  if (texto === "") throw erro("Escreva a mensagem.");
  if (texto.length > LIMITE_TEXTO_LIVRE_WHATSAPP) throw erro(`A mensagem pode ter no máximo ${LIMITE_TEXTO_LIVRE_WHATSAPP} caracteres.`);
  if (CONTROLE_PROIBIDO.test(texto) || SURROGATE_ISOLADO.test(texto)) throw erro("A mensagem contém caracteres inválidos.");
  return texto;
}

/** Elegibilidade do texto livre para um cliente — calculada SÓ pelo backend; o Backoffice apenas exibe. */
export interface ElegibilidadeTextoWhatsappDto {
  permitido: boolean;
  motivo: MotivoTextoLivreIndisponivel | null;
  mensagem: string;
  telefoneMascarado: string | null;
  ultimaMensagemRecebidaEm: string | null;
  /** Até quando o texto livre pode ser enviado (já com a margem de segurança). */
  janelaExpiraEm: string | null;
  limiteCaracteres: number;
  verificadoEm: string;
}

const MENSAGEM_ELEGIBILIDADE: Record<MotivoTextoLivreIndisponivel | "PERMITIDO", string> = {
  PERMITIDO: "O cliente escreveu nas últimas 24 horas: o texto livre pode ser enviado.",
  PROVEDOR_NAO_CONFIGURADO: "O WhatsApp oficial não está configurado neste servidor.",
  WEBHOOK_NAO_CONFIGURADO:
    "O recebimento de mensagens do WhatsApp (webhook) não está configurado neste servidor. Sem ele não há como confirmar a janela de 24 horas.",
  TELEFONE_INVALIDO: "O telefone cadastrado não é válido para envio de WhatsApp.",
  CONTATO_BLOQUEADO: "Este contato pediu para não receber mensagens de WhatsApp.",
  SEM_MENSAGEM_RECEBIDA:
    "Não há mensagem recebida deste cliente nas últimas 24 horas. Pelas regras do WhatsApp, texto livre só pode ser enviado depois que o cliente escreve; use um modelo aprovado.",
  JANELA_EXPIRADA:
    "Já passaram 24 horas desde a última mensagem do cliente. Pelas regras do WhatsApp, texto livre não pode ser enviado agora; use um modelo aprovado.",
};

interface VerificacaoTextoLivre {
  motivo: MotivoTextoLivreIndisponivel | null;
  telefoneE164: string | null;
  janela: SituacaoJanela | null;
}

/**
 * Fase 22.8.9.10.3 — envio de WhatsApp por TEMPLATE (spec 22.8.9.10.2 consolidada). O backend valida, resolve o
 * destinatário pelo cadastro, normaliza o número, aplica bloqueio, idempotência e deduplicação de campanha, persiste
 * ANTES de chamar o provedor e classifica o resultado. Nesta fase o provedor real não existe: o padrão é o provedor
 * desativado (as rotas respondem `WHATSAPP_NOT_CONFIGURED`) e os testes usam um dublê.
 *
 * Garantias:
 * - uma chave de idempotência = no máximo UMA chamada ao provedor, inclusive sob requisições simultâneas;
 * - repetição (mesma chave + mesmo conteúdo) só LÊ o registro — nunca chama o provedor;
 * - timeout/erro inesperado na chamada → `indeterminada`, nunca reenvio automático;
 * - logs só com ids/estados/códigos (nunca telefone, nome ou texto).
 */
@Injectable()
export class EnviosWhatsappService {
  private readonly logger = new Logger(EnviosWhatsappService.name);
  /** Relógio substituível nos testes. */
  relogio: () => Date = () => new Date();

  constructor(
    @Inject(PROVEDOR_ENVIO_WHATSAPP) private readonly provedor: ProvedorEnvioWhatsapp,
    private readonly repository: MensagensWhatsappRepository,
    private readonly clientesRepository: ClientesRepository,
    private readonly bloqueiosService: BloqueiosWhatsappService,
    private readonly templatesService: TemplatesWhatsappService,
    private readonly janelasRepository: JanelasWhatsappRepository,
    /** Fase 22.8.9.10.7.4 — `null` = webhook desativado: sem evidência de janela, o texto livre nunca é permitido. */
    @Inject(CONFIG_WEBHOOK_WHATSAPP) private readonly configWebhook: ConfiguracaoWebhookMeta | null,
  ) {}

  /** `nova: false` = repetição da mesma chave (HTTP 200); `true` = mensagem criada por esta requisição (HTTP 201). */
  async enviar(dto: EnviarTemplateWhatsappDto, usuarioId: string | null): Promise<{ mensagem: MensagemWhatsappDto; nova: boolean }> {
    if (!this.provedor.configurado()) throw ApiException.whatsappNotConfigured();

    const hash = hashConteudoEnvio(dto);

    // Repetição: decidida ANTES de qualquer outra validação (o registro existente vale mesmo que o cadastro tenha
    // mudado depois). Só lê — nunca chama o provedor.
    const repetida = await this.repetir(dto.idempotencyKey, hash);
    if (repetida) return { mensagem: repetida, nova: false };

    const def = obterTemplateDoCatalogo(dto.template);
    const origem: OrigemMensagemWhatsapp = dto.campanha ? "CAMPANHA_ANIVERSARIO" : "INDIVIDUAL";
    if (!def || !def.usoPermitido.includes(origem)) {
      throw ApiException.whatsappTemplateIndisponivel("Modelo de mensagem inexistente ou não permitido para este uso.");
    }

    const cliente = await this.clientesRepository.encontrarPorIdOuFalhar(dto.destinatario.id);
    const telefoneE164 = normalizarTelefoneParaWhatsapp(cliente.telefone);

    if (await this.bloqueiosService.bloqueioAtivo(telefoneE164)) throw ApiException.whatsappContatoBloqueado();

    await this.templatesService.exigirAprovado(def);

    const agora = this.relogio();
    const campanhaAno = dto.campanha ? anoCivilDoEnvio(agora) : null;

    let mensagem: MensagemWhatsappDocument;
    try {
      // Passo 1 — reserva (índices únicos: idempotência e campanha/cliente/ano).
      mensagem = await this.repository.reservar(
        {
          idempotencyKey: dto.idempotencyKey,
          hashConteudo: hash,
          destinatarioTipo: "CLIENTE",
          destinatarioId: cliente._id,
          telefoneE164,
          templateChave: def.chave,
          templateNomeMeta: def.nomeMeta,
          templateIdioma: def.idioma,
          templateCategoria: def.categoria,
          origem,
          campanhaTipo: dto.campanha?.tipo ?? null,
          campanhaAno,
          chaveDeduplicacao: dto.campanha && campanhaAno !== null ? chaveDeduplicacaoCampanha(dto.campanha.tipo, campanhaAno, String(cliente._id)) : null,
          usuarioId,
        },
        agora,
      );
    } catch (erro) {
      if (!ehChaveDuplicada(erro)) throw erro;
      // Requisição simultânea com a mesma chave venceu a reserva: devolve o registro dela (sem chamar o provedor).
      const repetidaNaCorrida = await this.repetir(dto.idempotencyKey, hash);
      if (repetidaNaCorrida) return { mensagem: repetidaNaCorrida, nova: false };
      // Não foi a chave de idempotência: só pode ser a reserva de campanha deste cliente no ano.
      throw ApiException.whatsappJaEnviadaCampanha();
    }

    return {
      mensagem: await this.concluirEnvio(mensagem, usuarioId, () =>
        this.provedor.enviarTemplate({
          telefoneE164,
          nomeMeta: def.nomeMeta,
          idioma: def.idioma,
          parametros: resolverParametros(def, cliente),
          referenciaInterna: String(mensagem._id),
        }),
      ),
      nova: true,
    };
  }

  /**
   * Fase 22.8.9.10.7.4 — envio de TEXTO livre a UM cliente cadastrado, pelas mesmas garantias do template (reserva antes
   * do provedor, posse condicional, uma chamada por chave, `indeterminada` sem reenvio automático). O backend é a única
   * autoridade: destinatário pelo cadastro, bloqueio e janela de 24 h conferidos AQUI, a cada pedido.
   */
  async enviarTexto(dto: EnviarTextoWhatsappDto, usuarioId: string | null): Promise<{ mensagem: MensagemWhatsappDto; nova: boolean }> {
    if (!this.provedor.configurado()) throw ApiException.whatsappNotConfigured();

    const texto = validarTextoLivre(dto.texto);
    const hash = hashConteudoTexto(dto.destinatario.id, texto);

    // Repetição da mesma chave: só LÊ (mesmo que a janela tenha fechado depois) — nunca chama o provedor.
    const repetida = await this.repetir(dto.idempotencyKey, hash);
    if (repetida) return { mensagem: repetida, nova: false };

    const cliente = await this.clientesRepository.encontrarPorIdOuFalhar(dto.destinatario.id);
    const verificacao = await this.verificarTextoLivre(cliente.telefone);
    switch (verificacao.motivo) {
      case null:
        break;
      case "PROVEDOR_NAO_CONFIGURADO":
        throw ApiException.whatsappNotConfigured();
      case "TELEFONE_INVALIDO":
        normalizarTelefoneParaWhatsapp(cliente.telefone); // lança o erro padrão (WHATSAPP_INVALID_NUMBER)
        throw ApiException.whatsappInvalidNumber();
      case "CONTATO_BLOQUEADO":
        throw ApiException.whatsappContatoBloqueado();
      default:
        throw ApiException.whatsappJanelaFechada(MENSAGEM_ELEGIBILIDADE[verificacao.motivo]);
    }
    const telefoneE164 = verificacao.telefoneE164!;

    let mensagem: MensagemWhatsappDocument;
    try {
      mensagem = await this.repository.reservar(
        {
          idempotencyKey: dto.idempotencyKey,
          hashConteudo: hash,
          tipo: "TEXTO",
          texto,
          destinatarioTipo: "CLIENTE",
          destinatarioId: cliente._id,
          telefoneE164,
          templateChave: null,
          templateNomeMeta: null,
          templateIdioma: null,
          templateCategoria: null,
          origem: "INDIVIDUAL",
          campanhaTipo: null,
          campanhaAno: null,
          chaveDeduplicacao: null,
          usuarioId,
        },
        this.relogio(),
      );
    } catch (erro) {
      if (!ehChaveDuplicada(erro)) throw erro;
      // Requisição simultânea com a mesma chave venceu a reserva: devolve o registro dela (sem chamar o provedor).
      const repetidaNaCorrida = await this.repetir(dto.idempotencyKey, hash);
      if (repetidaNaCorrida) return { mensagem: repetidaNaCorrida, nova: false };
      throw erro;
    }

    return {
      mensagem: await this.concluirEnvio(mensagem, usuarioId, () =>
        this.provedor.enviarTexto({ telefoneE164, texto, referenciaInterna: String(mensagem._id) }),
      ),
      nova: true,
    };
  }

  /** Fase 22.8.9.10.7.4 — o texto livre pode ser enviado AGORA a este cliente? (consulta; o envio confere de novo). */
  async elegibilidadeTexto(clienteId: string): Promise<ElegibilidadeTextoWhatsappDto> {
    const cliente = await this.clientesRepository.encontrarPorIdOuFalhar(clienteId);
    const agora = this.relogio();
    const v = await this.verificarTextoLivre(cliente.telefone);
    const janela = v.janela && v.janela.tipo !== "sem_mensagem" ? v.janela : null;
    return {
      permitido: v.motivo === null,
      motivo: v.motivo,
      mensagem: MENSAGEM_ELEGIBILIDADE[v.motivo ?? "PERMITIDO"],
      telefoneMascarado: v.telefoneE164 ? mascararTelefone(v.telefoneE164) : null,
      ultimaMensagemRecebidaEm: janela ? janela.ultimaMensagemEm.toISOString() : null,
      janelaExpiraEm: janela ? janela.expiraEm.toISOString() : null,
      limiteCaracteres: LIMITE_TEXTO_LIVRE_WHATSAPP,
      verificadoEm: agora.toISOString(),
    };
  }

  /**
   * Condições do texto livre, na ordem: provedor configurado → telefone do cadastro válido → sem bloqueio → webhook
   * configurado (única fonte de evidência da janela) → janela aberta. A janela é procurada pelos MESMOS identificadores
   * do bloqueio: os dígitos do E.164 e os `waId`s já devolvidos pela Meta para esse número (igualdade exata).
   */
  private async verificarTextoLivre(telefoneCadastro: string): Promise<VerificacaoTextoLivre> {
    if (!this.provedor.configurado()) return { motivo: "PROVEDOR_NAO_CONFIGURADO", telefoneE164: null, janela: null };
    let telefoneE164: string;
    try {
      telefoneE164 = normalizarTelefoneParaWhatsapp(telefoneCadastro);
    } catch {
      return { motivo: "TELEFONE_INVALIDO", telefoneE164: null, janela: null };
    }
    if (await this.bloqueiosService.bloqueioAtivo(telefoneE164)) return { motivo: "CONTATO_BLOQUEADO", telefoneE164, janela: null };
    if (!this.configWebhook) return { motivo: "WEBHOOK_NAO_CONFIGURADO", telefoneE164, janela: null };

    const identificadores = [...new Set([telefoneE164.replace(/^\+/, ""), ...(await this.repository.waIdsConhecidos(telefoneE164))])];
    const ultima = await this.janelasRepository.ultimaMensagemEm(this.configWebhook.phoneNumberId, identificadores);
    const janela = avaliarJanela(ultima, this.relogio());
    if (janela.tipo === "sem_mensagem") return { motivo: "SEM_MENSAGEM_RECEBIDA", telefoneE164, janela };
    if (janela.tipo === "expirada") return { motivo: "JANELA_EXPIRADA", telefoneE164, janela };
    return { motivo: null, telefoneE164, janela };
  }

  /**
   * Passos 2 e 3, comuns a template e texto: posse condicional (sem posse, ninguém chama o provedor), UMA chamada,
   * registro do resultado. Exceção inesperada do provedor = `indeterminada` (nunca reenviar automaticamente).
   */
  private async concluirEnvio(
    mensagem: MensagemWhatsappDocument,
    usuarioId: string | null,
    chamarProvedor: () => Promise<ResultadoEnvioProvedorWhatsapp>,
  ): Promise<MensagemWhatsappDto> {
    if (!(await this.repository.assumirEnvio(mensagem._id, this.relogio()))) {
      return paraMensagemDto(await this.recarregar(mensagem));
    }

    let resultado: ResultadoEnvioProvedorWhatsapp;
    try {
      resultado = await chamarProvedor();
    } catch {
      resultado = { resultado: "indeterminada", codigoProvedor: null };
    }
    await this.registrarResultado(mensagem, resultado);

    const final = await this.recarregar(mensagem);
    this.logger.log(
      JSON.stringify({
        evento: "whatsapp.envio.resultado",
        mensagemId: String(final._id),
        clienteId: String(final.destinatarioId),
        tipo: final.tipo ?? "TEMPLATE",
        template: final.templateChave,
        estado: final.estado,
        erro: final.erroCodigo,
        usuarioId,
      }),
    );
    return paraMensagemDto(final);
  }

  private async registrarResultado(mensagem: MensagemWhatsappDocument, resultado: ResultadoEnvioProvedorWhatsapp): Promise<void> {
    const agora = this.relogio();
    switch (resultado.resultado) {
      case "aceita":
        await this.repository.registrarAceita(mensagem._id, resultado.wamid, resultado.waId, agora);
        return;
      case "recusada":
        await this.repository.registrarRecusa(mensagem._id, resultado.codigo, resultado.codigoProvedor, agora);
        if (resultado.codigo === "TEMPLATE_INVALIDO" && mensagem.templateChave) this.templatesService.invalidar(mensagem.templateChave);
        if (resultado.codigo === "OPT_OUT_MARKETING") {
          // O próprio destinatário pediu para não receber marketing: entra na lista de bloqueio.
          await this.bloqueiosService.bloquearNumero(mensagem.telefoneE164, mensagem.destinatarioId, "META_OPT_OUT", null);
        }
        return;
      case "indeterminada":
        await this.repository.registrarIndeterminada(mensagem._id, resultado.codigoProvedor, agora);
        return;
    }
  }

  /** Registro existente para a chave (repetição), ou `null`. Conteúdo diferente com a mesma chave → 409. */
  private async repetir(idempotencyKey: string, hash: string): Promise<MensagemWhatsappDto | null> {
    const existente = await this.repository.encontrarPorIdempotencyKey(idempotencyKey);
    if (!existente) return null;
    if (existente.hashConteudo !== hash) throw ApiException.whatsappIdempotenciaConflito();
    await this.repository.converterAbandonadas(this.relogio());
    return paraMensagemDto(await this.recarregar(existente));
  }

  private async recarregar(m: MensagemWhatsappDocument): Promise<MensagemWhatsappDocument> {
    return (await this.repository.encontrarPorId(String(m._id))) ?? m;
  }

  async obter(id: string): Promise<MensagemWhatsappDto> {
    await this.repository.converterAbandonadas(this.relogio());
    const m = await this.repository.encontrarPorId(id);
    if (!m) throw ApiException.notFound("Mensagem não encontrada.");
    return paraMensagemDto(m);
  }

  async listar(query: ListarMensagensWhatsappQueryDto): Promise<{ data: MensagemWhatsappDto[]; meta: ApiMeta }> {
    await this.repository.converterAbandonadas(this.relogio());
    const { itens, total } = await this.repository.listar(
      { clienteId: query.clienteId, estado: query.estado, campanhaAno: query.campanhaAno },
      query.page,
      query.limit,
    );
    return { data: itens.map(paraMensagemDto), meta: { total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) } };
  }

  /**
   * Liberação MANUAL de reenvio (spec consolidada, item B). Não é reconciliação nem garantia contra duplicidade: para
   * `indeterminada`, exige a confirmação explícita do risco e o prazo mínimo (salvaguarda, não prova). O registro
   * original é preservado; o reenvio, se houver, é uma NOVA mensagem com NOVA chave.
   */
  async liberarReenvio(id: string, dto: LiberarReenvioWhatsappDto, usuarioId: string | null): Promise<MensagemWhatsappDto> {
    const agora = this.relogio();
    await this.repository.converterAbandonadas(agora);
    const m = await this.repository.encontrarPorId(id);
    if (!m) throw ApiException.notFound("Mensagem não encontrada.");
    if (m.liberadaEm) throw ApiException.whatsappLiberacaoNaoPermitida("Esta mensagem já foi liberada para reenvio.");
    if (!podeLiberarReenvio(m.estado)) {
      throw ApiException.whatsappLiberacaoNaoPermitida("Só mensagens com falha ou com resultado indeterminado podem ser liberadas.");
    }
    if (m.estado === "indeterminada") {
      if (dto.confirmoRiscoDeDuplicidade !== true) {
        throw ApiException.validation("Confirme que entende o risco de a cliente receber a mensagem duas vezes.", [
          { field: "confirmoRiscoDeDuplicidade", message: "Obrigatório (true) para mensagem com resultado indeterminado." },
        ]);
      }
      const desde = (m.enviandoEm ?? m.criadoEm).getTime();
      if (agora.getTime() - desde < PRAZO_MINIMO_LIBERAR_INDETERMINADA_MS) {
        throw ApiException.whatsappLiberacaoNaoPermitida("Aguarde pelo menos 24 horas antes de liberar uma mensagem com resultado indeterminado.");
      }
    }
    if (!(await this.repository.liberar(m, usuarioId, dto.motivo, agora))) {
      throw ApiException.whatsappLiberacaoNaoPermitida("A mensagem mudou de estado ou já foi liberada. Atualize e tente de novo.");
    }
    this.logger.log(JSON.stringify({ evento: "whatsapp.envio.liberado", mensagemId: id, estado: m.estado, usuarioId }));
    return this.obter(id);
  }

  async listarTemplates(): Promise<TemplateWhatsappPublico[]> {
    return this.templatesService.listar();
  }

  /** Prévia com dados reais do cadastro, pela MESMA regra de parâmetros do envio. */
  async previa(chave: string, clienteId: string): Promise<{ texto: string }> {
    const def = obterTemplateDoCatalogo(chave);
    if (!def) throw ApiException.whatsappTemplateIndisponivel("Modelo de mensagem inexistente.");
    const cliente = await this.clientesRepository.encontrarPorIdOuFalhar(clienteId);
    return { texto: renderizarPrevia(def, resolverParametros(def, cliente)) };
  }
}
