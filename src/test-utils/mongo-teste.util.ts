import { MongooseModule } from "@nestjs/mongoose";
import type { DynamicModule } from "@nestjs/common";

/**
 * Base de dados MongoDB REAL e local, dedicada a testes — nunca a mesma usada
 * em desenvolvimento (`mariela_dev`). O objetivo destes testes é validar
 * comportamento genuíno do MongoDB (concorrência, índices, agregação), não
 * substituí-lo por um dublê em memória.
 */
export const MONGODB_URI_TESTE = process.env["MONGODB_URI_TESTE"] ?? "mongodb://127.0.0.1:27017/mariela_test";

export function mongooseModuloDeTeste(): DynamicModule {
  return MongooseModule.forRoot(MONGODB_URI_TESTE);
}
