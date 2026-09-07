import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { Usuario, type UsuarioDocument } from "./schemas/usuario.schema.js";

interface DadosCriarUsuario {
  codigo: string;
  nome: string;
  email: string;
  senhaHash: string;
  role: "ADMIN";
  ativo: true;
  ultimoLoginEm: null;
}

@Injectable()
export class UsuariosRepository {
  constructor(@InjectModel(Usuario.name) private readonly usuarioModel: Model<UsuarioDocument>) {}

  async criar(dados: DadosCriarUsuario): Promise<UsuarioDocument> {
    try {
      return await this.usuarioModel.create(dados);
    } catch (erro) {
      // Índice único de `email`/`codigo` é a proteção real contra corrida —
      // a checagem de duplicidade no service é só para dar uma mensagem
      // amigável no caminho feliz; isto aqui cobre o caso de duas
      // requisições simultâneas passarem pela checagem ao mesmo tempo.
      if (this.ehErroDeChaveDuplicada(erro)) {
        throw ApiException.conflict("Este e-mail já está cadastrado.");
      }
      throw erro;
    }
  }

  async encontrarPorEmail(emailNormalizado: string): Promise<UsuarioDocument | null> {
    return this.usuarioModel.findOne({ email: emailNormalizado }).exec();
  }

  async encontrarPorId(id: string): Promise<UsuarioDocument | null> {
    return this.usuarioModel.findById(id).exec();
  }

  async registrarLogin(id: string): Promise<void> {
    await this.usuarioModel.updateOne({ _id: id }, { $set: { ultimoLoginEm: new Date() } }).exec();
  }

  private ehErroDeChaveDuplicada(erro: unknown): boolean {
    return typeof erro === "object" && erro !== null && "code" in erro && (erro as { code: unknown }).code === 11000;
  }
}
