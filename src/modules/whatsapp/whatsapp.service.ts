import { Inject, Injectable, Logger } from "@nestjs/common";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { ClientesRepository } from "../clientes/clientes.repository.js";
import { FornecedoresRepository } from "../fornecedores/fornecedores.repository.js";
import { VendedoresRepository } from "../vendedores/vendedores.repository.js";
import { templatePadraoCliente } from "./templates/cliente.templates.js";
import { templatePadraoFornecedor } from "./templates/fornecedor.templates.js";
import { templatePadraoVendedor } from "./templates/vendedor.templates.js";
import { normalizarTelefoneParaWhatsapp } from "./utils/normalizar-telefone-whatsapp.util.js";
import { WHATSAPP_PROVIDER } from "./whatsapp.constants.js";
import type { EnviarMensagemWhatsappDto } from "./dto/enviar-mensagem-whatsapp.dto.js";
import type { WhatsappProvider } from "./providers/whatsapp-provider.interface.js";
import type { ResultadoEnvioWhatsapp, StatusWhatsapp, TipoDestinatarioWhatsapp } from "./whatsapp.types.js";

interface DestinatarioResolvido {
  nome: string;
  telefone: string;
}

/**
 * Camada de domínio do WhatsApp — conhece Clientes/Fornecedores/Vendedores e
 * as regras de resolução de destinatário, mas NUNCA os detalhes de HTTP/URL
 * de um provider externo (isso é responsabilidade exclusiva de
 * `WhatsappProvider`/`EvolutionApiProvider`, Etapa Pré-22, §3).
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsappProvider,
    private readonly clientesRepository: ClientesRepository,
    private readonly fornecedoresRepository: FornecedoresRepository,
    private readonly vendedoresRepository: VendedoresRepository,
  ) {}

  async obterStatus(): Promise<StatusWhatsapp> {
    return this.provider.obterStatus();
  }

  async conectar(): Promise<StatusWhatsapp> {
    return this.provider.conectar();
  }

  async desconectar(): Promise<StatusWhatsapp> {
    return this.provider.desconectar();
  }

  /**
   * `id`/`tipo` são a única autoridade sobre o destinatário — o telefone
   * SEMPRE vem do cadastro (nunca do payload da requisição), conforme regra
   * explícita desta etapa (§6/§16-18): impede que o frontend (ou um cliente
   * de API malicioso) escolha um número arbitrário para receber a mensagem.
   */
  async enviarMensagem(dto: EnviarMensagemWhatsappDto, usuarioId: string | null): Promise<ResultadoEnvioWhatsapp> {
    const destinatario = await this.resolverDestinatario(dto.tipo, dto.id);
    const telefoneE164 = normalizarTelefoneParaWhatsapp(destinatario.telefone);
    const mensagem = dto.mensagem?.trim() || this.templatePadrao(dto.tipo, destinatario.nome);

    const resultado = await this.provider.enviarTexto({ telefone: telefoneE164, mensagem });

    this.logger.log(
      JSON.stringify({
        evento: "whatsapp.mensagem.enviada",
        tipo: dto.tipo,
        entidadeId: dto.id,
        usuarioId,
        idExterno: resultado.idExterno,
      }),
    );

    return {
      id: resultado.idExterno ?? `wam_${Date.now()}`,
      status: "enviada",
      tipo: dto.tipo,
      destinatario: telefoneE164,
    };
  }

  private async resolverDestinatario(tipo: TipoDestinatarioWhatsapp, id: string): Promise<DestinatarioResolvido> {
    switch (tipo) {
      case "CLIENTE": {
        const cliente = await this.clientesRepository.encontrarPorIdOuFalhar(id);
        return { nome: cliente.nome, telefone: cliente.telefone };
      }
      case "FORNECEDOR": {
        const fornecedor = await this.fornecedoresRepository.encontrarPorIdOuFalhar(id);
        return { nome: fornecedor.nome, telefone: fornecedor.telefone };
      }
      case "VENDEDOR": {
        const vendedor = await this.vendedoresRepository.encontrarPorIdOuFalhar(id);
        return { nome: vendedor.nome, telefone: vendedor.telefone };
      }
      default: {
        // Inatingível: `dto.tipo` já é validado por `@IsIn` no DTO.
        throw ApiException.validation("Tipo de destinatário inválido.");
      }
    }
  }

  private templatePadrao(tipo: TipoDestinatarioWhatsapp, nome: string): string {
    switch (tipo) {
      case "CLIENTE":
        return templatePadraoCliente(nome);
      case "FORNECEDOR":
        return templatePadraoFornecedor(nome);
      case "VENDEDOR":
        return templatePadraoVendedor(nome);
    }
  }
}
