import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { AuthService } from "../modules/auth/auth.service.js";

/**
 * Cria o primeiro administrador do Backoffice. NÃO existe rota HTTP pública
 * para isto de propósito (§19) — só este script, executado localmente por
 * quem já tem acesso ao servidor/ambiente.
 *
 *   ADMIN_EMAIL=admin@mariela.com ADMIN_NAME="Administradora" ADMIN_PASSWORD="..." bun run seed:admin
 *
 * Idempotente: rodar de novo com o mesmo e-mail não duplica nem falha, só
 * avisa que o usuário já existe. Nunca imprime a senha.
 */
async function bootstrap(): Promise<void> {
  const email = process.env["ADMIN_EMAIL"]?.trim();
  const nome = process.env["ADMIN_NAME"]?.trim();
  const senha = process.env["ADMIN_PASSWORD"];

  if (!email || !nome || !senha) {
    console.error("Defina ADMIN_EMAIL, ADMIN_NAME e ADMIN_PASSWORD antes de rodar este script.");
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
    const resultado = await authService.criarAdminSeed({ nome, email, senha });

    if (resultado.criado) {
      console.log(`Administrador criado: ${resultado.usuario.codigo} <${resultado.usuario.email}>`);
    } else {
      console.log(`Já existe um usuário com este e-mail (${resultado.usuario.codigo}) — nada foi feito.`);
    }
  } finally {
    await app.close();
  }
}

void bootstrap();
