import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { CAMPOS_LISTA, type CampoLista } from "./configuracoes.constants.js";
import { ConfiguracoesRepository } from "./configuracoes.repository.js";
import type { DadosLoja } from "./configuracoes.types.js";
import type { AtualizarLojaDto } from "./dto/atualizar-loja.dto.js";
import type { ConfiguracaoDocument } from "./schemas/configuracao.schema.js";
import { EventoConfiguracao, type EventoConfiguracaoDocument } from "./schemas/evento-configuracao.schema.js";

const NOMES_LISTA: Record<CampoLista, string> = {
  categorias: "categorias",
  tamanhos: "tamanhos",
  cores: "cores",
  formasPagamento: "formas de pagamento",
};

/** Nomes (nunca valores) dos campos de `DadosLoja` cujo conteúdo difere entre dois estados — endereço aninhado como `endereco.<campo>`. */
function camposLojaAlterados(anterior: DadosLoja, novo: DadosLoja): string[] {
  const alterados: string[] = [];
  for (const campo of ["nome", "logo", "telefone", "whatsapp", "email"] as const) {
    if (anterior[campo] !== novo[campo]) alterados.push(campo);
  }
  for (const campo of Object.keys(novo.endereco) as (keyof DadosLoja["endereco"])[]) {
    if (anterior.endereco[campo] !== novo.endereco[campo]) alterados.push(`endereco.${campo}`);
  }
  return alterados;
}

/**
 * Configuração administrativa global e única da loja (Etapa 11.2) — contrato
 * fechado, extraído do Backoffice já implementado. Autoridade das regras:
 * valida `:lista`, normaliza e valida `valor` (nunca confia no frontend,
 * mesmo que o DTO já rejeite o caso óbvio de string totalmente vazia — aqui
 * também trata espaços-em-branco como vazio) e traduz o resultado do
 * repository (que já garante atomicidade/duplicidade via MongoDB, nunca
 * lendo-modificando-salvando o array inteiro) nos erros de domínio
 * apropriados.
 */
@Injectable()
export class ConfiguracoesService {
  constructor(
    private readonly configuracoesRepository: ConfiguracoesRepository,
    @InjectModel(EventoConfiguracao.name) private readonly eventoModel: Model<EventoConfiguracaoDocument>,
  ) {}

  async obter(): Promise<ConfiguracaoDocument> {
    return this.configuracoesRepository.obter();
  }

  async atualizarLoja(dto: AtualizarLojaDto, usuarioId: string | null): Promise<ConfiguracaoDocument> {
    const novaLoja: DadosLoja = {
      nome: dto.nome.trim(),
      logo: dto.logo.trim(),
      telefone: dto.telefone.trim(),
      whatsapp: dto.whatsapp.trim(),
      email: dto.email.trim(),
      endereco: {
        cep: dto.endereco.cep.trim(),
        logradouro: dto.endereco.logradouro.trim(),
        numero: dto.endereco.numero.trim(),
        complemento: dto.endereco.complemento.trim(),
        bairro: dto.endereco.bairro.trim(),
        cidade: dto.endereco.cidade.trim(),
        estado: dto.endereco.estado.trim(),
      },
    };

    // Leitura só para a trilha de auditoria (quais campos mudaram) — a escrita continua sendo a mesma operação atômica de sempre.
    const anterior = await this.configuracoesRepository.obter();
    const resultado = await this.configuracoesRepository.atualizarLoja(novaLoja);

    const lojaAnterior = anterior.loja as unknown as DadosLoja;
    await this.registrarEvento("configuracao.loja_atualizada", usuarioId, {
      camposAlterados: camposLojaAlterados(lojaAnterior, novaLoja),
    });
    return resultado;
  }

  async adicionarItem(lista: string, valorBruto: string, usuarioId: string | null): Promise<ConfiguracaoDocument> {
    const campo = this.validarCampoLista(lista);
    const valor = valorBruto.trim();
    if (!valor) {
      throw ApiException.validation("Dados inválidos.", [{ field: "valor", message: "O valor não pode ser vazio." }]);
    }

    const resultado = await this.configuracoesRepository.adicionarItemLista(campo, valor);
    if (!resultado) {
      throw ApiException.conflict(`"${valor}" já existe na lista de ${NOMES_LISTA[campo]}.`);
    }
    await this.registrarEvento("configuracao.item_adicionado", usuarioId, { lista: campo, valor });
    return resultado;
  }

  async removerItem(lista: string, valorBruto: string, usuarioId: string | null): Promise<ConfiguracaoDocument> {
    const campo = this.validarCampoLista(lista);
    const valor = valorBruto.trim();

    const resultado = await this.configuracoesRepository.removerItemLista(campo, valor);
    if (!resultado) {
      throw ApiException.notFound(`"${valor}" não existe na lista de ${NOMES_LISTA[campo]}.`);
    }
    await this.registrarEvento("configuracao.item_removido", usuarioId, { lista: campo, valor });
    return resultado;
  }

  private async registrarEvento(tipo: string, usuarioId: string | null, detalhes: Record<string, unknown>): Promise<void> {
    await this.eventoModel.create({ tipo, usuarioId, detalhes });
  }

  private validarCampoLista(lista: string): CampoLista {
    if (!(CAMPOS_LISTA as readonly string[]).includes(lista)) {
      throw ApiException.validation("Dados inválidos.", [
        { field: "lista", message: `Lista inválida. Use uma de: ${CAMPOS_LISTA.join(", ")}.` },
      ]);
    }
    return lista as CampoLista;
  }
}
