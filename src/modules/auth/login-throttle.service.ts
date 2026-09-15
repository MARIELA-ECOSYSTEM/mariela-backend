import { Injectable } from "@nestjs/common";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { LOGIN_THROTTLE_JANELA_MS, LOGIN_THROTTLE_MAX_TENTATIVAS } from "./auth.constants.js";

interface RegistroTentativas {
  falhas: number;
  primeiraFalhaEm: number;
}

/**
 * Freio de força bruta LOCAL (em memória, por processo) — não é uma solução
 * distribuída. Numa implantação com múltiplas instâncias, cada processo tem
 * sua própria contagem, então o limite real vira `LOGIN_THROTTLE_MAX_TENTATIVAS
 * × número de instâncias`. Isso é aceitável para o estágio atual (instância
 * única); a versão distribuída (Redis, janela deslizante compartilhada) é
 * trabalho futuro explicitamente fora do escopo desta etapa.
 *
 * Chave = IP + e-mail normalizado: limita tentativas contra UMA conta a
 * partir de UMA origem, sem travar a administradora legítima só porque
 * alguém, de outro lugar, errou a senha da conta dela.
 */
@Injectable()
export class LoginThrottleService {
  private readonly tentativas = new Map<string, RegistroTentativas>();

  /**
   * Etapa 10.23 — CORREÇÃO: sem isto, `tentativas` só cresce (nunca uma
   * entrada é removida) — uma tentativa de login com uma chave nova (IP+
   * e-mail diferentes) sempre cria uma entrada, mesmo depois de expirada; num
   * processo de longa duração, isso é um vazamento de memória lento porém
   * indefinido. Varre e remove só entradas JÁ expiradas (`!dentroDaJanela`) —
   * o mesmo critério que `verificar()`/`registrarFalha()` já usam para tratar
   * uma entrada expirada como equivalente a "não existir"; remover uma
   * entrada expirada é por construção um NO-OP do ponto de vista de quem
   * chama (nenhuma entrada ATIVA é tocada). Chamada em TODA verificação
   * (sucesso ou falha, já que `verificar()` roda em toda tentativa de login,
   * mais frequente que `registrarFalha()`) — solução simples e determinística
   * (nenhum timer/`setInterval`, nenhuma dependência nova), custo O(n) sobre
   * um Map que, pela própria natureza do throttle, permanece pequeno.
   */
  private limparExpiradas(): void {
    for (const [chave, registro] of this.tentativas) {
      if (!this.dentroDaJanela(registro)) this.tentativas.delete(chave);
    }
  }

  verificar(chave: string): void {
    this.limparExpiradas();
    const registro = this.tentativas.get(chave);
    if (!registro) return;

    if (this.dentroDaJanela(registro) && registro.falhas >= LOGIN_THROTTLE_MAX_TENTATIVAS) {
      throw ApiException.tooManyRequests();
    }
  }

  registrarFalha(chave: string): void {
    const agora = Date.now();
    const registro = this.tentativas.get(chave);
    if (!registro || !this.dentroDaJanela(registro)) {
      this.tentativas.set(chave, { falhas: 1, primeiraFalhaEm: agora });
      return;
    }
    registro.falhas += 1;
  }

  registrarSucesso(chave: string): void {
    this.tentativas.delete(chave);
  }

  /** Exposto só para teste de regressão (Etapa 10.23) — nunca usado em produção. */
  tamanhoParaTeste(): number {
    return this.tentativas.size;
  }

  private dentroDaJanela(registro: RegistroTentativas): boolean {
    return Date.now() - registro.primeiraFalhaEm < LOGIN_THROTTLE_JANELA_MS;
  }
}
