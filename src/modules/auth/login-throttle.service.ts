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

  verificar(chave: string): void {
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

  private dentroDaJanela(registro: RegistroTentativas): boolean {
    return Date.now() - registro.primeiraFalhaEm < LOGIN_THROTTLE_JANELA_MS;
  }
}
