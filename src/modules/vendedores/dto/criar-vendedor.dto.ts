import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsDateString, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { SENHA_TAMANHO_MINIMO } from "../vendedores.constants.js";

/**
 * Espelha `VendedorPayload` do Backoffice (`src/types/vendedor.ts`): código e
 * agregados de vendas NUNCA fazem parte do payload. `senha` é opcional NESTE
 * DTO (reaproveitado por criação e atualização) — o service exige presença na
 * criação e trata ausência na atualização como "não alterar senha", exatamente
 * como o mock atual já faz. Formato do telefone (com máscara) é preservado tal
 * como enviado; validação de dígitos e duplicidade acontecem no service.
 */
export class CriarVendedorDto {
  @ApiProperty({ example: "Mariana Alves", maxLength: 120 })
  @IsString()
  @IsNotEmpty({ message: "Nome é obrigatório." })
  @MaxLength(120, { message: "Máximo de 120 caracteres." })
  nome!: string;

  @ApiPropertyOptional({ example: "https://…", nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(400, { message: "Máximo de 400 caracteres." })
  foto?: string | null;

  @ApiProperty({ example: "(11) 99999-9999", maxLength: 20 })
  @IsString()
  @IsNotEmpty({ message: "Telefone é obrigatório." })
  @MaxLength(20, { message: "Máximo de 20 caracteres." })
  telefone!: string;

  @ApiPropertyOptional({ example: "1994-03-12", nullable: true, description: "Data em ISO (YYYY-MM-DD)." })
  @IsOptional()
  @IsDateString({}, { message: "Data de nascimento inválida." })
  dataNascimento?: string | null;

  @ApiPropertyOptional({ example: "Responsável pelo turno da manhã." })
  @IsOptional()
  @IsString()
  @MaxLength(400, { message: "Máximo de 400 caracteres." })
  observacao?: string;

  @ApiProperty({ example: true })
  @Type(() => Boolean)
  @IsBoolean()
  ativo!: boolean;

  @ApiPropertyOptional({
    description: "Obrigatória na criação; omitida na atualização = mantém a senha atual.",
    minLength: SENHA_TAMANHO_MINIMO,
  })
  @IsOptional()
  @IsString()
  @MinLength(SENHA_TAMANHO_MINIMO, { message: `A senha deve ter ao menos ${SENHA_TAMANHO_MINIMO} caracteres.` })
  senha?: string;
}
