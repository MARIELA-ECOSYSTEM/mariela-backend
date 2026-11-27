import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength, MinLength } from "class-validator";
import { SENHA_TAMANHO_MAXIMO, SENHA_TAMANHO_MINIMO } from "../vendedores.constants.js";

export class RedefinirSenhaVendedorDto {
  @ApiProperty({ minLength: SENHA_TAMANHO_MINIMO, maxLength: SENHA_TAMANHO_MAXIMO })
  @IsString()
  @IsNotEmpty({ message: "Senha é obrigatória." })
  @MinLength(SENHA_TAMANHO_MINIMO, { message: `A senha deve ter ao menos ${SENHA_TAMANHO_MINIMO} caracteres.` })
  @MaxLength(SENHA_TAMANHO_MAXIMO, { message: `A senha deve ter no máximo ${SENHA_TAMANHO_MAXIMO} caracteres.` })
  senha!: string;
}
