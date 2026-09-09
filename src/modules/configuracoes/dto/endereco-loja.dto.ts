import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength } from "class-validator";

/**
 * Espelha `EnderecoLoja` do Backoffice EXATAMENTE — todos os campos são
 * `string` obrigatória no payload (o contrato não os declara opcionais), mas
 * podem ser ENVIADOS vazios (loja sem complemento, por exemplo): nenhum
 * `@IsNotEmpty()` aqui, só formato.
 */
export class EnderecoLojaDto {
  @ApiProperty({ example: "01310-100", maxLength: 12 })
  @IsString()
  @MaxLength(12)
  cep!: string;

  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MaxLength(160)
  logradouro!: string;

  @ApiProperty({ maxLength: 20 })
  @IsString()
  @MaxLength(20)
  numero!: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MaxLength(80)
  complemento!: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MaxLength(80)
  bairro!: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MaxLength(80)
  cidade!: string;

  @ApiProperty({ example: "SP", maxLength: 2 })
  @IsString()
  @MaxLength(2)
  estado!: string;
}
