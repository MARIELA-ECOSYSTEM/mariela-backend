import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf, ValidateNested, Matches } from "class-validator";
import { EnderecoFornecedorDto } from "./endereco-fornecedor.dto.js";

/**
 * Espelha `FornecedorPayload` do Backoffice (`src/types/fornecedor.ts`): o
 * código e os agregados comerciais (`produtosVinculados`/`valorEmCusto`/
 * `ultimaEntrada`) NUNCA fazem parte do payload — são gerados/calculados pelo
 * backend. Ao contrário de Clientes, `contato`/`telefone`/`email`/`cnpj`/
 * `instagram` são todos OPCIONAIS aqui (contrato real do formulário de
 * Fornecedores — `fornecedor-dialog.tsx` não exige nenhum deles).
 */
export class CriarFornecedorDto {
  @ApiProperty({ example: "Confecções Ipê Ltda", maxLength: 120 })
  @IsString()
  @IsNotEmpty({ message: "Nome é obrigatório." })
  @MaxLength(120, { message: "Máximo de 120 caracteres." })
  nome!: string;

  @ApiPropertyOptional({ example: "https://…", nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(400, { message: "Máximo de 400 caracteres." })
  foto?: string | null;

  @ApiPropertyOptional({ example: "Ana Ferreira", maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120, { message: "Máximo de 120 caracteres." })
  contato?: string;

  @ApiPropertyOptional({ example: "(11) 98888-7777", maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: "Máximo de 20 caracteres." })
  telefone?: string;

  @ApiPropertyOptional({ example: "contato@fornecedor.com", maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160, { message: "Máximo de 160 caracteres." })
  @ValidateIf((dto: CriarFornecedorDto) => Boolean(dto.email))
  @Matches(/.+@.+\..+/, { message: "E-mail inválido." })
  email?: string;

  @ApiPropertyOptional({ example: "00.000.000/0001-00", maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: "Máximo de 20 caracteres." })
  cnpj?: string;

  @ApiPropertyOptional({ example: "@fornecedor", maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60, { message: "Máximo de 60 caracteres." })
  instagram?: string;

  @ApiPropertyOptional({ example: "Entrega às terças." })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: "Máximo de 500 caracteres." })
  observacao?: string;

  @ApiPropertyOptional({ type: EnderecoFornecedorDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => EnderecoFornecedorDto)
  endereco?: EnderecoFornecedorDto | null;
}
