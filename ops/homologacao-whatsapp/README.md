# Homologação local do WhatsApp oficial (Meta Cloud API)

Fase 22.8.9.10.7.7. Ambiente **isolado** para homologar a integração oficial com um **aplicativo da Meta separado** e
um **número de teste autorizado**, sem tocar em produção, Render, Atlas ou no app da Meta de produção.

Nada aqui envia mensagem sozinho: enquanto a configuração da Meta de homologação não estiver completa, o envio
responde `WHATSAPP_NOT_CONFIGURED` e o webhook responde 503.

## Arquitetura

```
 celular de teste ──WhatsApp──► Meta (APP DE HOMOLOGAÇÃO, número de teste)
                                   │ webhook HTTPS
                                   ▼
             túnel HTTPS (cloudflared, só enquanto testa)
                                   │
                                   ▼
             proxy-webhook.ts  127.0.0.1:3190   ← só /api/v1/integracoes/whatsapp/webhook (resto: 404)
                                   │
                                   ▼
  Backoffice local ──────────► backend local 127.0.0.1:3100  (bun --no-env-file, pasta SEM .env)
  http://localhost:5180               │
  (faixa "HOMOLOGAÇÃO")               ▼
                         MongoDB descartável 127.0.0.1:27217
                         banco mariela_homologacao_whatsapp
```

Pasta de trabalho, **fora de qualquer repositório**: `%LOCALAPPDATA%\MARIELA-HOMOLOGACAO`

| Pasta | Conteúdo |
|---|---|
| `backend\`, `backoffice\` | clones próprios (nunca têm `.env`) |
| `mongodb\bin\mongod.exe` | MongoDB portátil (nada instalado no sistema) |
| `mongo\dados\` | banco de homologação (descartável) |
| `config\homologacao.env` | configuração e credenciais da homologação (acesso só do seu usuário) |
| `logs\`, `estado\` | logs e PIDs do ambiente em execução |

## Proteções de isolamento

O `iniciar.ps1` só sobe alguma coisa depois do **verificador de isolamento** (`verificar-isolamento.ts`). Qualquer
falha impede a inicialização, e a saída mostra só OK/FALHA, nunca valores.

| Regra | Garante |
|---|---|
| R01 | `MARIELA_AMBIENTE=homologacao-whatsapp` |
| R02 | `NODE_ENV=development` (nunca `production` nem `test`) |
| R03 | MongoDB só em `127.0.0.1`/`localhost`, porta 27217 (nunca Atlas, `mongodb+srv` ou a 27017 do desenvolvimento) |
| R04 | banco `mariela_homologacao*` (nunca `marielaDB`, `mariela`, `mariela_test`) |
| R05 | CORS só para origens locais |
| R06 | Evolution API desligada: nenhum outro provedor de envio |
| R07 | R2 (mídia) desligado |
| R08 | porta própria (não a 3000) |
| R09 | provedor só vazio, `desativado` ou `meta-cloud-api` |
| R10 | com a Meta ativa: confirmação explícita de que as credenciais são do app de homologação |
| R11 | com a Meta ativa: de 1 a 5 destinos autorizados (E.164) |
| R12 | com a Meta ativa: Phone Number ID da homologação **diferente** do de produção |
| R13 | WABA ID diferente do de produção (quando informado) |
| R14 | o número remetente não é um dos destinos |
| R15 | nenhum `.env` na pasta de onde o backend sobe |
| B01 | banco com no máximo 20 clientes (nunca uma cópia do cadastro real) |
| B02 | com a Meta ativa, todo cliente do banco tem telefone autorizado |

Outras proteções:
- **Variáveis limpas.** Antes de carregar a configuração, todas as variáveis que backend e Backoffice reconhecem são
  removidas do processo. Variável desconhecida no arquivo impede a inicialização.
- **Sem `.env`.** O backend roda com `bun --no-env-file` a partir de uma pasta sem `.env`. O `ConfigModule` do Nest lê
  o `.env` da pasta atual; rodar de dentro do repositório herdaria a configuração real.
- **Túnel restrito.** O túnel público aponta para o **proxy**, que só encaminha o webhook. Login, clientes e envios não
  ficam expostos.
- **Destinatários da Meta.** O número de teste da Meta só entrega a destinatários cadastrados e verificados no próprio
  app, no máximo 5.

## 1. Preparar (uma vez)

1. Tenha um `mongod.exe` portátil, versão 7.x. Pode ser o já baixado nas fases anteriores; nada é instalado no
   Windows.
2. No repositório do backend:
   ```powershell
   pwsh -NoProfile -File ops\homologacao-whatsapp\preparar.ps1 -MongodExe "C:\caminho\mongod.exe"
   ```
   O script clona backend e Backoffice (no commit atual, ou em `-RefBackend`/`-RefBackoffice`), instala as
   dependências, compila o backend e cria `config\homologacao.env` com segredos JWT locais aleatórios. Os segredos
   não são exibidos.
3. A faixa "HOMOLOGAÇÃO" no Backoffice exige o commit da Fase 22.8.9.10.7.7 no Backoffice.

## 2. Iniciar e encerrar

```powershell
pwsh -NoProfile -File ops\homologacao-whatsapp\iniciar.ps1        # MongoDB + backend + Backoffice
pwsh -NoProfile -File ops\homologacao-whatsapp\criar-admin.ps1    # só na primeira vez (pede e-mail, nome e senha)
pwsh -NoProfile -File ops\homologacao-whatsapp\encerrar.ps1       # encerra tudo e confere as portas
pwsh -NoProfile -File ops\homologacao-whatsapp\encerrar.ps1 -ApagarDados   # também descarta o banco (pede confirmação)
```

- **Backoffice:** http://localhost:5180, com a faixa amarela "HOMOLOGAÇÃO · WhatsApp oficial".
- **Backend:** http://127.0.0.1:3100/api/v1.
- **Logs:** `%LOCALAPPDATA%\MARIELA-HOMOLOGACAO\logs`.

Com a configuração padrão (provedor `desativado`), tudo funciona e nada é enviado. O dialog mostra "O WhatsApp
oficial não está configurado neste servidor".

## 3. Aplicativo da Meta de homologação (manual, na sua conta)

> Não use o app de produção. Não altere o webhook do app de produção. Um app da Meta tem **um** callback de webhook
> por produto; apontá-lo para cá desviaria os webhooks da produção.

Os nomes dos menus da Meta mudam com frequência; os passos abaixo descrevem o caminho, que pode estar com outro rótulo.

1. **Criar o app.** Em developers.facebook.com → *Meus apps* → *Criar app*, escolha o caso de uso de **WhatsApp**
   (conectar-se com clientes; tipo *Empresa*). Dê um nome inequívoco, por exemplo "MARIELA – HOMOLOGAÇÃO". Vincule a
   um portfólio empresarial; um portfólio de testes separado é o mais seguro.
2. **Produto WhatsApp.** Em *WhatsApp → Configuração da API* (*API Setup*), a Meta oferece um **número de teste** e
   uma **conta WhatsApp Business de teste**. Anote, **só no arquivo local**:
   - o *Phone Number ID* vai em `META_WHATSAPP_PHONE_NUMBER_ID`;
   - o *WhatsApp Business Account ID* vai em `META_WHATSAPP_BUSINESS_ACCOUNT_ID`;
   - o número de teste em E.164 vai em `WHATSAPP_OWNER_PHONE`.
3. **Destinatários autorizados.** No campo *Para* (*To*) da mesma página, adicione o número de teste autorizado e
   confirme com o código que chega no WhatsApp desse número (máximo de 5). Ponha os mesmos números em
   `HOMOLOGACAO_DESTINOS_PERMITIDOS`.
4. **Token.**
   - O *token de acesso temporário* da página de API Setup vale cerca de 24 h e basta para uma sessão de homologação.
     Cole-o em `META_WHATSAPP_ACCESS_TOKEN`.
   - Para sessões mais longas, crie um **usuário do sistema** no portfólio de testes, com as permissões
     `whatsapp_business_messaging` e `whatsapp_business_management`, atribuído a este app e à conta de teste. Gere o
     token dele.
5. **App Secret.** Em *Configurações do app → Básico → Chave secreta do app → Mostrar*. Cole em
   `META_WHATSAPP_APP_SECRET`.
6. **Verify token.** Invente um texto aleatório com pelo menos 16 caracteres, sem espaços. Por exemplo:
   ```powershell
   bun -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
   Ponha em `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
7. **Travas.** Preencha:
   - `HOMOLOGACAO_CONFIRMO_APP_DA_META_SEPARADO=sim`;
   - `HOMOLOGACAO_PHONE_NUMBER_ID_PRODUCAO`, com o Phone Number ID de **produção**. É um identificador, não um
     segredo; serve para o verificador recusar se o mesmo número for usado aqui;
   - opcionalmente, `HOMOLOGACAO_WABA_ID_PRODUCAO`.
8. **Ligar o envio.** Só então troque `WHATSAPP_PROVEDOR_ENVIO=desativado` por `meta-cloud-api`. Rode `encerrar.ps1`
   e depois `iniciar.ps1`. O diagnóstico deve mostrar `webhook: ATIVO`.
9. **Webhook.** Siga a seção 4 (túnel) e, no app de **homologação**, em *WhatsApp → Configuração → Webhook →
   Editar*:
   - **URL de callback:** `https://<endereço-do-túnel>/api/v1/integracoes/whatsapp/webhook`;
   - **Verificar token:** o mesmo `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`;
   - clique em *Verificar e salvar*. O ambiente, o proxy e o túnel precisam estar no ar;
   - em *Campos do webhook*, assine **`messages`** (e, se quiser, `user_preferences`).
10. **Conferência de que nada é de produção.**
    - O App ID deste app é diferente do de produção.
    - No app de **produção**, só olhando, a URL de callback continua a de produção.
    - O verificador passou nas regras R10 a R14.

As credenciais ficam só em `config\homologacao.env`, no seu computador. Não as cole no chat, não as commite e não as
mande por mensagem. Para trocar o token temporário: encerrar, editar o arquivo, iniciar.

## 4. Webhook HTTPS (túnel)

**Recomendado: Cloudflare Quick Tunnel (`cloudflared`).** É gratuito, não precisa de conta, é um executável
**portátil** (nada é instalado) e dá HTTPS válido.

1. Baixe `cloudflared-windows-amd64.exe` da página **oficial** de releases (github.com/cloudflare/cloudflared/releases)
   e salve como `%LOCALAPPDATA%\MARIELA-HOMOLOGACAO\ferramentas\cloudflared.exe`.
2. Com o ambiente iniciado, em um terminal, suba o proxy só do webhook:
   ```powershell
   bun --no-env-file ops\homologacao-whatsapp\proxy-webhook.ts
   ```
3. Em outro terminal, abra o túnel **apontando para o proxy, nunca para a porta 3100**:
   ```powershell
   & "$env:LOCALAPPDATA\MARIELA-HOMOLOGACAO\ferramentas\cloudflared.exe" tunnel --no-autoupdate --url http://127.0.0.1:3190
   ```
   Ele mostra um endereço `https://<aleatório>.trycloudflare.com`. A URL de callback na Meta é esse endereço +
   `/api/v1/integracoes/whatsapp/webhook`.
4. Ao terminar, feche o túnel (Ctrl+C) e o proxy. Sem túnel, a Meta não alcança nada.

Limitações:
- O endereço **muda a cada execução**; é preciso atualizar o callback no app de homologação a cada sessão.
- Não há garantia de disponibilidade; é para testes.
- O TLS termina na Cloudflare, que vê o tráfego do webhook. Use só mensagens de teste.

Alternativas, que exigem conta: ngrok (token de autenticação) e encaminhamento de porta do VS Code (login no GitHub,
porta pública). Qualquer que seja a ferramenta, aponte sempre para o proxy (3190).

## 5. Roteiro da sessão (quando a homologação real for autorizada)

1. `iniciar.ps1`, depois o proxy, depois o túnel. Configure o callback no app de homologação (seção 3, passo 9).
2. No Backoffice de homologação, cadastre **um** cliente de teste com o número autorizado. O verificador recusa subir
   com cliente fora da lista.
3. Do celular autorizado, envie uma mensagem ao número de teste. A janela deve abrir, e o dialog do cliente mostra
   "pode ser enviado".
4. Envie **um** texto identificado como homologação, depois de testar o cancelamento. Acompanhe no Histórico os
   estados `aceita → entregue → lida`.
5. Encerre: túnel, proxy, `encerrar.ps1`.

## Pendências para a homologação real

- [ ] Criar o app da Meta de homologação e obter as credenciais (seção 3). Manual, pela conta Meta.
- [ ] Número de teste autorizado, cadastrado como destinatário no app de homologação.
- [ ] Baixar o `cloudflared` portátil (seção 4).
- [ ] Commitar esta fase: scripts no backend, faixa no Backoffice.
- [ ] Autorização explícita para a sessão de envio real.
- [ ] Templates: a conta de teste da Meta só tem os modelos dela. O `mariela_aniversario_v2` precisaria ser criado e
      aprovado nela para testar o envio por modelo. O texto livre não depende disso.
- [ ] Nono dígito: registrar o `wa_id` real que a Meta envia para o número de teste. Se vier sem o 9, a janela não é
      encontrada sem um envio anterior. Sem regra de aproximação nesta fase.
