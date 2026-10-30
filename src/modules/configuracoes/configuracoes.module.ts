import { forwardRef, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { ConfiguracoesController } from "./configuracoes.controller.js";
import { ConfiguracoesRepository } from "./configuracoes.repository.js";
import { ConfiguracoesService } from "./configuracoes.service.js";
import { Configuracao, ConfiguracaoSchema } from "./schemas/configuracao.schema.js";
import { EventoConfiguracao, EventoConfiguracaoSchema } from "./schemas/evento-configuracao.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Configuracao.name, schema: ConfiguracaoSchema },
      { name: EventoConfiguracao.name, schema: EventoConfiguracaoSchema },
    ]),
    // Fase 54.0 — checagem de vínculo antes de excluir cores/tamanhos
    // reutiliza `ProdutosRepository.listarTodosAtivos`, mesmo padrão de
    // reuso cross-módulo já estabelecido (ex.: Fornecedores/Coleções/
    // Campanhas importam ProdutosModule pelo mesmo motivo). `forwardRef`
    // desde a Fase 54.2: `ProdutosModule` passou a importar
    // `ConfiguracoesModule` também (validação de cor/tamanho ao criar
    // variante) — dependência circular genuína nos dois sentidos agora.
    forwardRef(() => ProdutosModule),
  ],
  controllers: [ConfiguracoesController],
  providers: [ConfiguracoesService, ConfiguracoesRepository],
  exports: [ConfiguracoesService, ConfiguracoesRepository],
})
export class ConfiguracoesModule {}
