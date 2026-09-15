import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min } from "class-validator";
import { MODALIDADES_PAGAMENTO, type ModalidadePagamento } from "../vendas.constants.js";

/**
 * Espelha `BaixaParcelaPayload` (`src/types/venda.ts`). `formaPagamento`
 * (campo legado) continua funcionando sozinho — payload
 * `{ formaPagamento, idempotencyKey }` segue aceito exatamente como antes
 * (Etapa 10.11 é ADITIVA); um `{}` totalmente vazio não é mais aceito a
 * partir da Etapa 10.22 (ver `idempotencyKey` abaixo — passou a ser
 * obrigatória).
 *
 * Campos novos (Etapa 10.11) — todos opcionais, mesma forma de
 * `PagamentoVendaPdvDto`/`RegistrarRecebimentoDto`: quando `modalidade` é
 * informada, `VendasService.baixarParcela` reaproveita
 * `validarPagamentoEstruturado` (mesma regra de dinheiro/PIX/débito/crédito
 * já usada por `criar()`/`receberPagamento()` — nenhuma duplicação). Sem
 * `modalidade`, o comportamento é o legado: `tarifaAplicada` fica `null`.
 *
 * `valor`, quando informado, é validado contra o valor da própria parcela
 * (uma parcela é quitada por inteiro ou não é quitada — ver relatório da
 * Etapa 10.11 sobre por que não existe baixa parcial de uma parcela).
 */
export class BaixarParcelaDto {
  @ApiPropertyOptional({ description: "Ausente = mantém a forma de pagamento já registrada na venda." })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  formaPagamento?: string;

  @ApiPropertyOptional({ description: "Deve corresponder exatamente ao valor da parcela quando informado." })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "Informe um valor com até 2 casas decimais." })
  @IsPositive({ message: "Valor deve ser maior que zero." })
  valor?: number;

  @ApiPropertyOptional({ enum: MODALIDADES_PAGAMENTO, example: "credito" })
  @IsOptional()
  @IsIn(MODALIDADES_PAGAMENTO, { message: 'Modalidade deve ser "dinheiro", "pix", "debito" ou "credito".' })
  modalidade?: ModalidadePagamento;

  @ApiPropertyOptional({ description: "Obrigatório quando modalidade é débito ou crédito." })
  @IsOptional()
  @IsString()
  adquirenteId?: string;

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

  /**
   * Etapa 10.22 — OBRIGATÓRIA (era opcional até esta etapa): operação
   * financeira administrativa, sem proteção nenhuma contra duplo-clique/retry
   * de rede sem uma chave. O Backoffice já sempre envia esta chave desde a
   * Etapa 18.30 (`gerarIdempotencyKey()`, `vendas.$id.tsx`) — esta mudança
   * não quebra o contrato real com o frontend, só fecha a lacuna de quem
   * chamasse a API diretamente sem ela. Tipo TS permanece opcional de
   * propósito (`?:`), não `!:` — `VendasService.baixarParcela` também é
   * chamado internamente (testes, reconciliação) fora do `ValidationPipe`.
   */
  @ApiProperty({ description: "Protege contra retry duplicado — obrigatória desde a Etapa 10.22." })
  @IsString()
  @IsNotEmpty({ message: "idempotencyKey é obrigatória." })
  @MaxLength(200)
  idempotencyKey?: string;
}
