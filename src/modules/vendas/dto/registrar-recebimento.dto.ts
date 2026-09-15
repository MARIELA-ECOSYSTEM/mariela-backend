import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min } from "class-validator";
import { MODALIDADES_PAGAMENTO, type ModalidadePagamento } from "../vendas.constants.js";

/**
 * Contrato de `POST /vendas/:id/recebimentos` (Etapa 10.8) — um RECEBIMENTO
 * POSTERIOR contra o saldo pendente de uma venda EM_PAGAMENTO. Espelha
 * `PagamentoVendaPdvDto` (`modules/pdv-vendas/dto`) campo a campo — mesma
 * forma livre para `forma` (nenhum enum de forma de pagamento existe em
 * nenhuma parte do código-base), mesma validação de FORMATO para modalidade/
 * adquirenteId (as regras que dependem do banco — adquirente existe/ativa,
 * tarifa configurada — são responsabilidade exclusiva de
 * `VendasService.validarPagamentoEstruturado`, nunca deste DTO). Não estende
 * `PagamentoVendaPdvDto` diretamente para não criar uma dependência do módulo
 * `vendas` sobre `pdv-vendas` (sentido contrário ao já estabelecido).
 *
 * `idempotencyKey` — Etapa 10.22: OBRIGATÓRIA (era opcional/administrativa,
 * diferente do PDV, até esta etapa). O Backoffice já sempre envia esta chave
 * desde a Etapa 18.30 (`gerarIdempotencyKey()`, `vendas.$id.tsx`), então esta
 * mudança não quebra o contrato real com o frontend — só fecha a lacuna de
 * quem chamasse a API diretamente sem ela (um duplo-clique/retry de rede sem
 * chave nunca tinha proteção nenhuma contra duplo lançamento financeiro).
 */
export class RegistrarRecebimentoDto {
  @ApiProperty({ example: "Dinheiro", maxLength: 60 })
  @IsString()
  @IsNotEmpty({ message: "Forma de pagamento é obrigatória." })
  @MaxLength(60, { message: "Máximo de 60 caracteres." })
  forma!: string;

  @ApiProperty({ example: 100 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "Informe um valor com até 2 casas decimais." })
  @IsPositive({ message: "Valor do recebimento deve ser maior que zero." })
  valor!: number;

  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  parcelas?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  observacao?: string;

  @ApiPropertyOptional({ enum: MODALIDADES_PAGAMENTO, example: "credito" })
  @IsOptional()
  @IsIn(MODALIDADES_PAGAMENTO, { message: 'Modalidade deve ser "dinheiro", "pix", "debito" ou "credito".' })
  modalidade?: ModalidadePagamento;

  @ApiPropertyOptional({ description: "Obrigatório quando modalidade é débito ou crédito." })
  @IsOptional()
  @IsString()
  adquirenteId?: string;

  /** Tipo TS permanece opcional de propósito (`?:`) — `VendasService.receberPagamento` também é chamado internamente (testes) fora do `ValidationPipe`. */
  @ApiProperty({ description: "Protege contra retry duplicado — obrigatória desde a Etapa 10.22." })
  @IsString()
  @IsNotEmpty({ message: "idempotencyKey é obrigatória." })
  @MaxLength(200)
  idempotencyKey?: string;
}
