import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { MongooseModuleOptions } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import type { Configuration } from "../config/configuration.js";

const logger = new Logger("MongooseModule");

/**
 * Fábrica de opções do Mongoose, consumida por `DatabaseModule` via
 * `MongooseModule.forRootAsync`. Centraliza aqui — e só aqui — a string de
 * conexão e o comportamento em caso de falha, para nenhum outro módulo
 * precisar conhecer detalhes de conexão com o MongoDB.
 */
export function mongooseConfigFactory(configService: ConfigService<Configuration>): MongooseModuleOptions {
  const uri = configService.get("database.uri", { infer: true });

  return {
    uri,
    // Falha rápido se o cluster estiver inacessível, em vez de travar o boot
    // da aplicação por tempo indefinido tentando localizar um servidor.
    serverSelectionTimeoutMS: 5_000,
    connectionFactory: (connection: Connection) => {
      connection.on("connected", () => logger.log("Conexão com o MongoDB estabelecida."));
      connection.on("error", (erro: Error) => logger.error(`Erro na conexão com o MongoDB: ${erro.message}`));
      connection.on("disconnected", () => logger.warn("Conexão com o MongoDB encerrada."));
      return connection;
    },
  };
}
