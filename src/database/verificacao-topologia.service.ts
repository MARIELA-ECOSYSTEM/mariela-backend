import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";

/**
 * Fase 60.4.3.4.15 (F04) — a criação de venda e a restauração de estoque do cancelamento usam TRANSAÇÕES, que só
 * existem em replica set (ou atrás de um mongos). O Atlas é sempre replica set; o CI usa um replica set de 1 nó.
 * Um MongoDB standalone (ex.: instalação local padrão, `docker-compose.yml` atual) aceita a conexão, mas recusa a
 * transação na primeira venda.
 *
 * Esta verificação roda uma vez no boot e só REGISTRA (nunca derruba a API): um erro bem visível no log quando a
 * topologia não suporta transações, para o problema aparecer na subida e não na primeira venda. O comando `hello` não
 * exige privilégio além da conexão.
 */
@Injectable()
export class VerificacaoTopologiaMongo implements OnApplicationBootstrap {
  private readonly logger = new Logger("TopologiaMongoDB");

  constructor(@InjectConnection() private readonly conexao: Connection) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const db = this.conexao.db;
      if (db === undefined) return;
      const hello = await db.admin().command({ hello: 1 });
      if (typeof hello["setName"] === "string" || hello["msg"] === "isdbgrid") {
        this.logger.log("MongoDB com suporte a transações (replica set ou mongos).");
        return;
      }
      this.logger.error(
        "MongoDB SEM replica set: transações indisponíveis — a criação de vendas e a restauração de estoque dos cancelamentos vão falhar. Use um replica set (o Atlas já é; localmente, um replica set de 1 nó).",
      );
    } catch (erro) {
      this.logger.warn(`Não foi possível verificar a topologia do MongoDB (${erro instanceof Error ? erro.name : "erro desconhecido"}).`);
    }
  }
}
