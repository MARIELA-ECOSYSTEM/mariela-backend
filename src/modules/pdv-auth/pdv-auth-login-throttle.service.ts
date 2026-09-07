import { Injectable } from "@nestjs/common";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { PDV_LOGIN_THROTTLE_JANELA_MS, PDV_LOGIN_THROTTLE_MAX_TENTATIVAS } from "./pdv-auth.constants.js";

interface RegistroTentativas {
  falhas: number;
  primeiraFalhaEm: number;
}

/**
 * Freio de força bruta do login do MARIELA PDV — mesma técnica e mesmas
 * limitações de `modules/auth/login-throttle.service.ts` (ADMIN), duplicada
 * aqui de propósito (ver `pdv-auth.constants.ts`): em memória, por processo,
 * não distribuída entre múltiplas instâncias — aceitável para o estágio atual
 * (instância única), mesma decisão já tomada para o login administrativo.
 *
 * Chave = IP + código de vendedor normalizado: limita tentativas contra UM
 * vendedor a partir de UMA origem.
 */
@Injectable()
export class PdvAuthLoginThrottleService {
  private readonly tentativas = new Map<string, RegistroTentativas>();

  verificar(chave: string): void {
    const registro = this.tentativas.get(chave);
    if (!registro) return;

    if (this.dentroDaJanela(registro) && registro.falhas >= PDV_LOGIN_THROTTLE_MAX_TENTATIVAS) {
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
    return Date.now() - registro.primeiraFalhaEm < PDV_LOGIN_THROTTLE_JANELA_MS;
  }
}
