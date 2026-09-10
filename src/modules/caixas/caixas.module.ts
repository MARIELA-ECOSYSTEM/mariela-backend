import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { Venda, VendaSchema } from "../vendas/schemas/venda.schema.js";
import { VendasRepository } from "../vendas/vendas.repository.js";
import { CaixasController } from "./caixas.controller.js";
import { CaixasRepository } from "./caixas.repository.js";
import { CaixasService } from "./caixas.service.js";
import { MovimentosCaixaRepository } from "./movimentos-caixa.repository.js";
import { Caixa, CaixaSchema } from "./schemas/caixa.schema.js";
import { EventoCaixa, EventoCaixaSchema } from "./schemas/evento-caixa.schema.js";
import { MovimentoCaixa, MovimentoCaixaSchema } from "./schemas/movimento-caixa.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Caixa.name, schema: CaixaSchema },
      { name: MovimentoCaixa.name, schema: MovimentoCaixaSchema },
      { name: EventoCaixa.name, schema: EventoCaixaSchema },
      // `Venda` é registrada aqui (não via `VendasModule`) de propósito: `VendasModule`
      // já importa `CaixasModule` para resolver `CaixasService` — importar `VendasModule`
      // de volta aqui criaria uma dependência circular entre módulos. `VendasRepository`
      // só depende do model `Venda` (nenhuma outra dependência), então registrá-lo como
      // provider aqui, com seu próprio model registrado nesta mesma injeção, reusa a
      // MESMA classe/lógica de consulta (nunca uma segunda implementação) sem inverter a
      // direção de dependência já estabelecida (Vendas depende de Caixas, nunca o
      // contrário) — mesmo padrão já usado em `ClientesModule`/`VendedoresModule`.
      // Etapa 18.2 — usado só para CONSULTA (`CaixasService.buscarVendasDoCaixa`), nunca
      // para escrever: o Caixa não é autoridade sobre Vendas.
      { name: Venda.name, schema: VendaSchema },
    ]),
    SequenciasModule,
  ],
  controllers: [CaixasController],
  providers: [CaixasService, CaixasRepository, MovimentosCaixaRepository, VendasRepository],
  exports: [CaixasService, CaixasRepository, MovimentosCaixaRepository],
})
export class CaixasModule {}
