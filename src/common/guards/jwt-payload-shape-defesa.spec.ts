import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PdvJwtAuthGuard } from "../../modules/pdv-auth/guards/pdv-jwt-auth.guard.js";
import type { VendedoresRepository } from "../../modules/vendedores/vendedores.repository.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";

/**
 * Etapa 10.23 — correção 6.11.4: a auditoria funcional apontou a AUSÊNCIA de
 * um teste que force secrets ADMIN/PDV IDÊNTICOS para comprovar que a defesa
 * por payload-shape (`JwtAuthGuard.payloadValido`/`PdvJwtAuthGuard.payloadValido`)
 * sozinha — sem depender de secrets diferentes — já impede um token de um
 * domínio ser aceito no guard do outro.
 *
 * Deliberadamente NÃO altera nenhum mecanismo de autenticação: usa os dois
 * guards e os dois `JwtService` exatamente como já existem, só configurados
 * aqui com o MESMO segredo (cenário hipotético de configuração incorreta em
 * produção) para isolar o que, especificamente, continua protegendo o
 * isolamento ADMIN×PDV nesse cenário degradado — resposta: o formato do
 * payload, não o segredo.
 */
const SEGREDO_COMPARTILHADO_PARA_TESTE = "segredo-hipotetico-compartilhado-apenas-para-este-teste";

function contextoHttpFake(authorizationHeader: string | undefined): ExecutionContext {
  const request = { headers: { authorization: authorizationHeader } };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe("Etapa 10.23 — defesa por payload-shape sob secrets ADMIN/PDV idênticos", () => {
  it("JwtAuthGuard (ADMIN) rejeita um token PDV-shaped mesmo assinado com o MESMO segredo", async () => {
    const jwtService = new JwtService({ secret: SEGREDO_COMPARTILHADO_PARA_TESTE });
    const guard = new JwtAuthGuard(jwtService);

    // Payload PDV real (`PdvJwtPayload`): tem `tipo`/`vendedorId`, nunca `role`.
    const tokenPdv = await jwtService.signAsync({ sub: "vendedor-id", vendedorId: "vendedor-id", codigo: "VEN-0001", tipo: "PDV" });

    // A assinatura bate (mesmo segredo) — se o isolamento dependesse só do
    // segredo, isto passaria. `payloadValido` (sem `role` num ROLE válido) é
    // quem de fato rejeita.
    await expect(guard.canActivate(contextoHttpFake(`Bearer ${tokenPdv}`))).rejects.toThrow();
  });

  it("PdvJwtAuthGuard (PDV) rejeita um token ADMIN-shaped mesmo assinado com o MESMO segredo", async () => {
    const jwtService = new JwtService({ secret: SEGREDO_COMPARTILHADO_PARA_TESTE });
    // `vendedoresRepository` nunca é alcançado: `payloadValido` rejeita antes
    // de qualquer consulta ao banco (é exatamente isso que este teste prova).
    const guard = new PdvJwtAuthGuard(jwtService, undefined as unknown as VendedoresRepository);

    // Payload ADMIN real (`JwtPayload`): tem `role`, nunca `tipo`/`vendedorId`.
    const tokenAdmin = await jwtService.signAsync({ sub: "usuario-id", codigo: "USR-0001", role: "ADMIN" });

    await expect(guard.canActivate(contextoHttpFake(`Bearer ${tokenAdmin}`))).rejects.toThrow();
  });

  it("controle: com secrets DIFERENTES (configuração real), a rejeição já acontecia na verificação de assinatura — não é regressão do isolamento existente", async () => {
    const jwtServiceAdmin = new JwtService({ secret: "segredo-admin-controle" });
    const jwtServicePdv = new JwtService({ secret: "segredo-pdv-controle" });
    const guardAdmin = new JwtAuthGuard(jwtServiceAdmin);

    const tokenPdv = await jwtServicePdv.signAsync({ sub: "vendedor-id", vendedorId: "vendedor-id", codigo: "VEN-0001", tipo: "PDV" });

    await expect(guardAdmin.canActivate(contextoHttpFake(`Bearer ${tokenPdv}`))).rejects.toThrow();
  });
});
