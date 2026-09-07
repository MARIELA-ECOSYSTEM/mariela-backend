import { Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";

export interface StatusBancoDados {
  status: "up" | "down";
  readyState: number;
}

export interface StatusSaude {
  status: "ok" | "degradado";
  timestamp: string;
  uptime: number;
  database: StatusBancoDados;
}

@Injectable()
export class SaudeService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  verificar(): StatusSaude {
    const readyState = this.connection.readyState;
    // readyState 1 = connected (ver mongoose.ConnectionStates).
    const bancoDeDadosOk = readyState === 1;

    return {
      status: bancoDeDadosOk ? "ok" : "degradado",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: { status: bancoDeDadosOk ? "up" : "down", readyState },
    };
  }
}
