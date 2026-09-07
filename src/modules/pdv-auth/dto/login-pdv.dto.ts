import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

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
  codigo!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: "Senha é obrigatória." })
  senha!: string;
}
