import { CriarFornecedorDto } from "./criar-fornecedor.dto.js";

/**
 * O Backoffice sempre envia o payload completo em `PUT /fornecedores/:id`
 * (não é uma atualização parcial) — mesmo formato de `CriarFornecedorDto`, e
 * não um `PartialType`. O código do fornecedor continua imutável.
 */
export class AtualizarFornecedorDto extends CriarFornecedorDto {}
