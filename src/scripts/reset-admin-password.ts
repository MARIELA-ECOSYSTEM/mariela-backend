import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { AuthService } from "../modules/auth/auth.service.js";

/**
 * Redefine a senha de um ADMIN existente. NÃO existe rota HTTP pública para
 * isto de propósito (mesmo racional de `seed-admin.ts`, §19) — só este
 * script, executado localmente por quem já tem acesso ao servidor/ambiente.
 *
 *   ADMIN_EMAIL=admin@mariela.com ADMIN_PASSWORD="..." bun run admin:reset-password
 *
 * Nunca cria usuário, nunca apaga, nunca altera qualquer campo além de
 * `senhaHash`. Nunca imprime senha, hash ou token.
 */
async function bootstrap(): Promise<void> {
  const email = process.env["ADMIN_EMAIL"]?.trim();
  const senha = process.env["ADMIN_PASSWORD"];

  if (!email || !senha) {
    console.error("Defina ADMIN_EMAIL e ADMIN_PASSWORD antes de rodar este script.");
    process.exitCode = 1;
    return;
  }
  if (senha.length < 8) {
    console.error("ADMIN_PASSWORD deve ter pelo menos 8 caracteres.");
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const authService = app.get(AuthService);
    const resultado = await authService.redefinirSenhaAdmin({ email, senha });

    if (resultado.status === "nao_encontrado") {
      console.error("Nenhum usuário encontrado com este e-mail — nada foi feito.");
      process.exitCode = 1;
      return;
    }
    if (resultado.status === "nao_admin") {
      console.error("Usuário encontrado, mas não é ADMIN — nada foi feito.");
      process.exitCode = 1;
      return;
    }
    console.log("Senha do administrador atualizada com sucesso.");
  } finally {
    await app.close();
  }
}

void bootstrap();
