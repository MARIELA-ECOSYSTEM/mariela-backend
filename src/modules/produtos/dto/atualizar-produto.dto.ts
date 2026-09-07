import { CriarProdutoDto } from "./criar-produto.dto.js";

/**
 * O Backoffice sempre envia o payload completo em `PUT /produtos/:id` (não é
 * uma atualização parcial) — por isso o mesmo formato de `CriarProdutoDto`,
 * e não um `PartialType`. O código do produto continua imutável (nem faz
 * parte deste DTO).
 */
export class AtualizarProdutoDto extends CriarProdutoDto {}
