import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

/**
 * O campo chama-se `usuario` (não `email`) de propósito: é exatamente o que
 * `LoginRequest` já envia hoje (`src/types/auth.ts` do Backoffice) — o valor
 * digitado É um e-mail na prática, mas o nome do campo na borda HTTP segue o
 * contrato existente para não exigir nenhuma mudança no frontend.
 *
 * Sem `@IsEmail()` de propósito: rejeitar antecipadamente algo "que não
 * parece e-mail" revelaria mais informação do que a mensagem genérica de
 * login (ver `ApiException.invalidCredentials`) — o valor é normalizado e
 * comparado contra `usuarios.email`, e se não bater, o erro é sempre o mesmo.
 */
export class LoginDto {
  @ApiProperty({ example: "admin@mariela.com", description: "E-mail cadastrado do usuário." })
  @IsString()
  @IsNotEmpty({ message: "Usuário é obrigatório." })
  usuario!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: "Senha é obrigatória." })
  senha!: string;
}
