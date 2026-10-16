# Dados e privacidade

O Octo roda inteiro na sua máquina. Não há conta no Octo, telemetria, analytics nem servidor remoto.

## O que fica onde

**`~/.octo`** (no Windows, `C:\Users\<você>\.octo`; muda com a variável `OCTO_DATA_DIR`). No macOS e no Linux, só o seu usuário consegue ler esta pasta.

| Caminho | O que é |
| --- | --- |
| `db.json` (e a cópia `db.json.bak`) | Workspaces, repositórios, issues, contas, sessões e preferências |
| `sessions/` | O registro de cada sessão do agente (atividade e respostas) e o estado do git quando ela começou |
| `images/` | As imagens que você colou, arrastou ou anexou nas conversas, numa pasta por sessão. Elas também vão, dentro da mensagem, para o Claude Code, que as envia à Anthropic como qualquer mensagem |
| `worktrees/` | Os worktrees das issues: uma pasta por issue, com uma cópia de trabalho de cada repositório numa branch só dela. A pasta sai quando você remove o worktree no painel da issue; as branches continuam nos repositórios |
| `token` | O segredo que a interface usa para falar com o servidor local |
| `server.json` | Qual processo do Octo está usando esta pasta agora (porta e pid) |
| `runtime/` | Arquivos temporários para abrir o Claude no terminal (o pedido de cada janela é apagado assim que ela abre) |
| `editor/` | Os arquivos `.code-workspace` gerados ao abrir vários repositórios no editor |
| `backups/` | As versões anteriores do `settings.json` de cada conta (as 20 mais recentes) |
| `trash/` | Skills, agentes e comandos excluídos pela tela de configuração |

**Pasta do app desktop** (cache e cookie da janela): `%APPDATA%\Octo` no Windows, `~/Library/Application Support/Octo` no macOS, `~/.config/Octo` no Linux.

**Contas do Claude Code.** A conta Principal usa o seu `~/.claude`. As contas extras ficam, por padrão, em `~/.claude-<nome>`, com login, histórico e configuração próprios: é o Claude Code quem grava nelas.

## O que o Octo lê e grava

- **Seus repositórios:** o Octo só lê (lista os repositórios e roda `git status` e `git diff` para a aba Mudanças). Quem altera arquivos é o Claude, dentro das permissões que você escolher. A exceção são os worktrees: ao delegar uma issue num worktree, o Octo roda `git fetch` (para partir da versão mais recente da branch padrão) e `git worktree` nos repositórios dela, o que cria uma branch para a issue. Ele nunca faz push, e remover o worktree mantém a branch.
- **`CLAUDE.md` de contexto:** só é gravado quando você pede, num bloco entre `<!-- octo:workspace:start -->` e `<!-- octo:workspace:end -->`. O resto do arquivo não é tocado.
- **Login do Claude Code:** o Octo não lê o `.credentials.json` nem o Keychain do macOS. Quem fala com a Anthropic é o próprio Claude Code.
- **`settings.json` de cada conta:** lido e editado pela tela **Configuração do Claude**, com a versão anterior guardada em `~/.octo/backups`. Se você guarda chaves nele (no bloco `env`, como `ANTHROPIC_API_KEY` ou um token de gateway, ou num `apiKeyHelper`), elas aparecem nessa tela e ficam nesses backups. Ao criar uma conta com **Copiar minhas preferências da conta principal** marcado, o `settings.json` vai sem as chaves conhecidas (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, as credenciais da AWS, `apiKeyHelper`, `awsAuthRefresh` e `awsCredentialExport`). As outras variáveis do bloco `env` vão junto; para não copiar nada, desmarque essa opção.
- **Skills, agentes, comandos, MCP e plugins:** lidos e editados nas pastas da conta (`~/.claude` ou `~/.claude-<nome>`), pelos arquivos ou pelos comandos `claude mcp` e `claude plugin`.
- **Ambiente do shell (macOS e Linux):** o app desktop lê o ambiente de um shell de login ao abrir e repassa essas variáveis ao Claude Code e aos terminais que abre, como o seu terminal faria. Nada disso é gravado em disco, a não ser o `NODE_OPTIONS`, que vai no pedido de cada janela de terminal (em `runtime/`, apagado assim que ela abre).

## Conexões de rede

- **O Octo:** consulta `api.github.com` para saber se há versão nova, no máximo a cada 6 horas. Dá para desligar em **Preferências**.
- **O git, nos worktrees:** ao criar um worktree a partir da branch padrão, o `git ls-remote` e o `git fetch` conectam ao remoto `origin` do repositório com as credenciais que o seu git já usa, sem abrir pedido de senha.
- **O Claude Code:** conecta à Anthropic (ou ao provedor que você configurou) como sempre faz. O Octo não intercepta nem registra esse tráfego; ele lê a saída do `claude` para mostrar o feed na issue.
- **O servidor interno do Octo:** escuta só em `127.0.0.1`, exige o token e recusa requisições de outros sites.

## Apagar tudo

1. Desinstale o app pelo sistema (veja [Instalação](instalacao.md#desinstalar)).
2. Apague `~/.octo` e a pasta do app desktop (lista acima). Se você usou worktrees, o git ainda lembra desses worktrees: em cada repositório, `git worktree list` mostra os que ficaram, e `git worktree remove --force <caminho>` faz o git esquecer cada um (as branches das issues continuam). Evite o `git worktree prune` sem antes conferir com `git worktree prune --dry-run -v`: ele também esquece worktrees seus que estejam, por exemplo, num disco desconectado.
3. Se não quiser mais as contas extras, apague as pastas `~/.claude-<nome>` delas. O Octo não as apaga nem quando você remove a conta no app, para não levar junto um login ou histórico que você ainda use.
4. Se você gerou `CLAUDE.md` pelo Octo, remova o bloco entre os marcadores `octo:workspace` nesses arquivos.

O `~/.claude` da conta Principal é do Claude Code e continua como estava.
