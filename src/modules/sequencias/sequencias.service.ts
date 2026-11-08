import { Injectable } from "@nestjs/common";
import type { ClientSession } from "mongoose";
import { SequenciasRepository } from "./sequencias.repository.js";

@Injectable()
export class SequenciasService {
  constructor(private readonly sequenciasRepository: SequenciasRepository) {}

  /**
   * Próximo código de uma entidade (`PROD-0001`, `CLI-0001`…). `chave`
   * identifica o contador (uma entidade = um contador, independente de quantos
   * registros existam ou tenham sido excluídos) e `prefixo` é o texto exibido.
   * Reutilizável por qualquer módulo futuro que precise de código sequencial.
   */
  async proximoCodigo(chave: string, prefixo: string, digitos = 4): Promise<string> {
    const valor = await this.sequenciasRepository.proximoValor(chave);
    return `${prefixo}-${String(valor).padStart(digitos, "0")}`;
  }

  /**
   * Valor numérico bruto da sequência, sem formatação — usado quando o
   * chamador precisa montar o código em um formato não-padrão (ex.: Vendas,
   * que insere a data entre o prefixo e o sufixo: `VENDA-2026-08-23-0001`) ou
   * precisa do mesmo número em mais de uma representação (`numero` de 6
   * dígitos exibido ao operador do PDV + sufixo de 4 dígitos do `codigo`).
   */
  /** Fase 60.4.3.4.15 (F04) — `sessao` opcional: incremento dentro da transação de quem chama. */
  async proximoValor(chave: string, sessao?: ClientSession): Promise<number> {
    return this.sequenciasRepository.proximoValor(chave, sessao);
  }

  /**
   * Fase 60.4.3.2.1 — PREVISÃO do próximo código, sem reservá-lo (somente leitura; usada por dry-runs). Outra
   * operação pode consumir o número antes; o código real só é definido por `proximoCodigo`.
   */
  async previsaoDoProximoCodigo(chave: string, prefixo: string, digitos = 4): Promise<string> {
    const atual = await this.sequenciasRepository.valorAtual(chave);
    return `${prefixo}-${String(atual + 1).padStart(digitos, "0")}`;
  }
}
