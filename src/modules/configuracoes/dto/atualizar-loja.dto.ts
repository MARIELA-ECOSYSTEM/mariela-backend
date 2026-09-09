import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDefined, IsString, MaxLength, ValidateNested } from "class-validator";
import { EnderecoLojaDto } from "./endereco-loja.dto.js";

/**
 * Contrato de `PUT /configuracoes/loja` (Etapa 11.2) — espelha `DadosLoja` do
 * Backoffice EXATAMENTE: substituição integral, nunca um patch parcial.
 * `logo` é string livre (URL/texto) — o contrato não prevê upload.
 */
export class AtualizarLojaDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  nome!: string;

  @ApiProperty({ maxLength: 500, description: "URL ou texto — nunca upload." })
  @IsString()
  @MaxLength(500)
  logo!: string;

  @ApiProperty({ maxLength: 20 })
  @IsString()
  @MaxLength(20)
  telefone!: string;

  @ApiProperty({ maxLength: 20 })
  @IsString()
  @MaxLength(20)
  whatsapp!: string;

  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MaxLength(160)
  email!: string;

  @ApiProperty({ type: EnderecoLojaDto })
  @IsDefined({ message: "O endereço é obrigatório." })
  @ValidateNested()
  @Type(() => EnderecoLojaDto)
  endereco!: EnderecoLojaDto;
}
