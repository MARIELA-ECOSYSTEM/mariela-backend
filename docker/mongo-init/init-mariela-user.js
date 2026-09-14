// Etapa 28 — cria o usuário de APLICAÇÃO do MongoDB, escopado só ao banco
// `mariela`, com o papel mínimo necessário (`readWrite`) — nunca o usuário
// root/administrativo (criado separadamente pela própria imagem oficial via
// MONGO_INITDB_ROOT_USERNAME/PASSWORD, ver docker-compose.yml).
//
// Executado UMA ÚNICA VEZ pela imagem oficial `mongo:7`, automaticamente, na
// primeira inicialização com o data directory vazio (todo script em
// /docker-entrypoint-initdb.d/*.js roda nesse momento, já autenticado como o
// usuário root recém-criado — ver documentação da imagem oficial). Nunca
// roda de novo em reinicializações subsequentes com dados já existentes —
// não é um script de migração, é só o bootstrap do primeiro boot.
//
// Credenciais vêm exclusivamente de variáveis de ambiente do próprio
// container (repassadas pelo docker-compose.yml a partir do .env real do
// servidor) — este arquivo nunca contém nem deve conter um valor real.
const nomeUsuarioApp = process.env.MARIELA_APP_MONGO_USER;
const senhaApp = process.env.MARIELA_APP_MONGO_PASSWORD;

if (!nomeUsuarioApp || !senhaApp) {
  throw new Error(
    "Etapa 28 — MARIELA_APP_MONGO_USER/MARIELA_APP_MONGO_PASSWORD ausentes: defina-os no .env antes de subir o MongoDB pela primeira vez (init roda só uma vez, com o volume vazio).",
  );
}

const bancoMariela = db.getSiblingDB("mariela");
bancoMariela.createUser({
  user: nomeUsuarioApp,
  pwd: senhaApp,
  roles: [{ role: "readWrite", db: "mariela" }],
});
