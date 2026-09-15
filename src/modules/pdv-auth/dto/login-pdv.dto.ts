import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

/**
 * Sem `@Matches` no formato do código de propósito: rejeitar antecipadamente
 * algo "que não parece um código de vendedor" revelaria mais informação do
 * que a mensagem genérica de login (ver `ApiException.invalidCredentials`) —
 * o valor é normalizado e comparado contra `vendedores.codigo`, e se não
 * bater, o erro é sempre o mesmo (mesma decisão de `LoginDto` do ADMIN).
 */
export class LoginPdvDto {
  @ApiProperty({ example: "VEN-0001", description: "Código do vendedor cadastrado no Backoffice." })
  @IsString()
  @IsNotEmpty({ message: "Código é obrigatório." })
  @MaxLength(50, { message: "Código excede o tamanho máximo permitido." })
  codigo!: string;

  // Etapa 10.23 — mesmo raciocínio defensivo do `LoginDto` do ADMIN: rejeita
  // um payload absurdamente grande antes do custo de hashing do bcrypt.
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: "Senha é obrigatória." })
  @MaxLength(200, { message: "Senha excede o tamanho máximo permitido." })
  senha!: string;
}
