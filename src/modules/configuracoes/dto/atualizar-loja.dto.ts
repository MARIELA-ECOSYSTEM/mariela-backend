import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDefined, IsString, Matches, MaxLength, ValidateIf, ValidateNested } from "class-validator";
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

  @ApiProperty({ maxLength: 160, description: "Pode ser vazio; quando preenchido, precisa ser um e-mail válido." })
  @IsString()
  @MaxLength(160)
  // Mesmo formato de `criar-fornecedor.dto.ts`. Diferente dele, `email` aqui é obrigatório (string, mas pode ser vazia):
  // por isso a validação de formato só é dispensada para string vazia/em branco — `undefined`/tipo errado continuam
  // sendo validados (o `ValidateIf` desliga TODOS os validadores da propriedade quando retorna false).
  @ValidateIf((dto: AtualizarLojaDto) => typeof dto.email !== "string" || dto.email.trim() !== "")
  @Matches(/.+@.+\..+/, { message: "E-mail inválido." })
  email!: string;

  @ApiProperty({ type: EnderecoLojaDto })
  @IsDefined({ message: "O endereço é obrigatório." })
  @ValidateNested()
  @Type(() => EnderecoLojaDto)
  endereco!: EnderecoLojaDto;
}
