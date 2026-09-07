import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MinLength } from "class-validator";
import { SENHA_TAMANHO_MINIMO } from "../vendedores.constants.js";

export class RedefinirSenhaVendedorDto {
  @ApiProperty({ minLength: SENHA_TAMANHO_MINIMO })
  @IsString()
  @IsNotEmpty({ message: "Senha é obrigatória." })
  @MinLength(SENHA_TAMANHO_MINIMO, { message: `A senha deve ter ao menos ${SENHA_TAMANHO_MINIMO} caracteres.` })
  senha!: string;
}
