import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { IsDateString, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Espelha `ClientePayload` do Backoffice (`src/types/cliente.ts`): o código e
 * os agregados de compras NUNCA fazem parte do payload — são gerados/mantidos
 * pelo backend. O formato do telefone (com máscara) é preservado tal como
 * enviado pelo formulário; a validação de dígitos (10 ou 11) e a checagem de
 * duplicidade acontecem no service, não aqui (são regras que dependem de
 * normalização, não de formato bruto do campo).
 */
export class CriarClienteDto {
  @ApiProperty({ example: "Maria Souza", maxLength: 120 })
  @IsString()
  @IsNotEmpty({ message: "Nome é obrigatório." })
  @MaxLength(120, { message: "Máximo de 120 caracteres." })
  nome!: string;

  @ApiPropertyOptional({ example: "https://…", nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(400, { message: "Máximo de 400 caracteres." })
  foto?: string | null;

  @ApiProperty({ example: "(83) 99999-9999", maxLength: 20 })
  @IsString()
  @IsNotEmpty({ message: "Telefone é obrigatório." })
  @MaxLength(20, { message: "Máximo de 20 caracteres." })
  telefone!: string;

  @ApiPropertyOptional({ example: "1998-05-20", nullable: true, description: "Data em ISO (YYYY-MM-DD)." })
  @IsOptional()
  @IsDateString({}, { message: "Data de nascimento inválida." })
  dataNascimento?: string | null;

  @ApiPropertyOptional({ example: "Prefere entrega à tarde." })
  @IsOptional()
  @IsString()
  @MaxLength(400, { message: "Máximo de 400 caracteres." })
  observacao?: string;
}
