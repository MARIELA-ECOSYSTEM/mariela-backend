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

  /** Usado só pela recuperação administrativa de senha (`bun run admin:reset-password`) — nunca toca em outro campo. */
  async atualizarSenhaHash(id: string, senhaHash: string): Promise<void> {
    await this.usuarioModel.updateOne({ _id: id }, { $set: { senhaHash } }).exec();
  }

  /**
   * Fase 60.4.3.1.5 — transição ATÔMICA de ativo para inativo, só de um ADMIN. Devolve o documento já inativo se
   * ESTA chamada fez a transição, ou `null` se ele já estava inativo (ou deixou de existir/ser ADMIN). `$ne: false`
   * (e não `true`) porque um documento sem o campo `ativo` vale como ativo no login (default do schema).
   */
  async desativarSeAtivo(id: string, agora: Date): Promise<UsuarioDocument | null> {
    return this.usuarioModel
      .findOneAndUpdate({ _id: id, role: "ADMIN", ativo: { $ne: false } }, { $set: { ativo: false, desativadoEm: agora } }, { returnDocument: "after" })
      .exec();
  }

  /**
   * Fase 60.4.3.1.5 — reivindica, por escrita condicional, o direito de gravar o evento `ADMIN_DEACTIVATED` de um
   * usuário inativo. Só uma execução recebe o documento; as demais recebem `null` (o evento já existe ou está sendo
   * gravado por outra).
   */
  async reivindicarAuditoriaDesativacao(id: string, marca: Date): Promise<UsuarioDocument | null> {
    return this.usuarioModel
      .findOneAndUpdate({ _id: id, ativo: false, desativacaoAuditadaEm: null }, { $set: { desativacaoAuditadaEm: marca } }, { returnDocument: "after" })
      .exec();
  }

  /** Desfaz a reivindicação (só a desta execução, pela `marca`) quando o evento não pôde ser gravado — permite nova tentativa. */
  async liberarAuditoriaDesativacao(id: string, marca: Date): Promise<boolean> {
    const resultado = await this.usuarioModel.updateOne({ _id: id, desativacaoAuditadaEm: marca }, { $set: { desativacaoAuditadaEm: null } }).exec();
    return resultado.modifiedCount === 1;
  }

  private ehErroDeChaveDuplicada(erro: unknown): boolean {
    return typeof erro === "object" && erro !== null && "code" in erro && (erro as { code: unknown }).code === 11000;
  }
}
