# Segurança

O Octo executa o Claude Code na sua máquina, então levamos segurança a sério.

## Como reportar uma vulnerabilidade

**Não abra uma issue pública.** Use o reporte privado do GitHub: aba **Security** → **Report a vulnerability** neste repositório ([link direto](https://github.com/KazuoMurakami/octo-desktop/security/advisories/new)). Descreva o problema, como reproduzir e o impacto. Você recebe uma resposta em até 7 dias.

## Versões com suporte

Apenas a versão mais recente publicada em [Releases](https://github.com/KazuoMurakami/octo-desktop/releases/latest) recebe correções de segurança.

## Modelo de segurança

**Servidor local**

- O servidor interno escuta só em `127.0.0.1` e exige um token guardado em `~/.octo/token`. Requisições com `Host` ou `Origin` de outros sites são recusadas.
- No macOS e no Linux, a pasta `~/.octo` só é legível pelo seu usuário. No Windows, ela fica na pasta do usuário, que o sistema já protege.
- A interface é servida com uma Content-Security-Policy que só aceita scripts, estilos e conexões do próprio Octo.

**Janela do app**

- A página roda isolada (`contextIsolation`, `sandbox`, sem acesso ao Node) e só navega dentro da própria interface. Links externos abrem no navegador.
- Pedidos de permissão da página (câmera, microfone, localização, tela cheia e outros) são negados. Ficam liberadas só as notificações e a cópia para a área de transferência, e apenas para a interface do Octo.
- As ferramentas de desenvolvedor não aparecem no app instalado. Para investigar um problema, abra o Octo com a variável `OCTO_DEVTOOLS=1`.

**Executável (fuses do Electron)**

Os fuses são chaves gravadas no executável, que nenhuma variável de ambiente muda. O workflow de release confere cada um com `scripts/check-fuses.mjs`.

| Fuse | Estado | Por quê |
| --- | --- | --- |
| `onlyLoadAppFromAsar` e `enableEmbeddedAsarIntegrityValidation` | ligados | O app só carrega o código do `app.asar`, e no macOS e no Windows o conteúdo é conferido contra o hash gravado no executável. |
| `enableNodeCliInspectArguments` | desligado | `--inspect` e o sinal `SIGUSR1` não abrem um depurador no app. |
| `grantFileProtocolExtraPrivileges` | desligado | A interface vem de `http://127.0.0.1`; páginas `file://` não precisam de privilégios extras. |
| `runAsNode` | ligado | O terminal do Octo roda o launcher (`server/launcher.mjs`) com o próprio executável como Node (`ELECTRON_RUN_AS_NODE`), e no macOS e no Linux o app lê o ambiente do seu shell do mesmo jeito. Desligar exige trocar esse launcher por um script do sistema antes. |
| `enableNodeOptionsEnvironmentVariable` | ligado | Desligado, o Electron apaga o `NODE_EXTRA_CA_CERTS` do ambiente, e o Claude Code das sessões deixa de confiar no certificado do proxy da empresa. No app empacotado, o processo principal ignora o `NODE_OPTIONS` (fora `--max-http-header-size` e `--http-parser`), e o Octo o esvazia quando roda o próprio executável como Node. |

Limitação conhecida: com `runAsNode` ligado, outro programa do seu usuário consegue rodar código usando o executável do Octo. No macOS, esse código herda as permissões que você deu ao Octo (acesso a pastas, Automação do iTerm2). Para fechar isso, o launcher do terminal precisa deixar de depender do `runAsNode`; depois disso o fuse será desligado.

**Credenciais e configuração do Claude Code**

- O Octo não lê o login do Claude Code (o arquivo `.credentials.json` ou o Keychain do macOS). Login e chamadas à Anthropic ficam com o próprio Claude Code.
- Ele lê e edita o `settings.json` de cada conta quando você usa a tela **Configuração do Claude** e guarda a versão anterior em `~/.octo/backups` (as 20 mais recentes por conta). Se você guarda chaves no `settings.json` (no bloco `env`, como `ANTHROPIC_API_KEY`, ou num `apiKeyHelper`), elas aparecem nessa tela e ficam nesses backups.
- Ao criar uma conta com **Copiar minhas preferências da conta principal** marcado, o `settings.json` vai sem as credenciais conhecidas: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` e `AWS_BEARER_TOKEN_BEDROCK` no bloco `env`, e `apiKeyHelper`, `awsAuthRefresh` e `awsCredentialExport`. As outras variáveis do `env` são copiadas como estão, inclusive uma chave com outro nome (como o token de um gateway). Com a opção desmarcada, nada da conta principal é copiado. Detalhes em [Dados e privacidade](docs/dados-e-privacidade.md).

**Rede**

- O Octo não envia seus dados a lugar nenhum: não há telemetria, analytics ou servidor remoto. A única conexão que ele faz por conta própria é consultar as releases deste repositório no GitHub para avisar de versões novas (pode ser desligada em Preferências).

**Instaladores**

- São gerados pelo GitHub Actions a partir do código deste repositório, com checksums SHA-256 e atestação de proveniência. Veja como verificar no [README](README.md#verificando-o-download).
- O app do macOS tem assinatura ad-hoc (sem Developer ID nem notarização da Apple), e o instalador do Windows não tem assinatura de código. Por isso o sistema avisa na primeira abertura.

## Escopo

Estão no escopo: a API local, a abertura de terminais e editores, a edição de configuração do Claude Code, o processo do Electron e o pipeline de release.

Ficam fora: o comportamento do próprio Claude Code e o que o agente faz quando você escolhe o modo "Sem restrições" (`bypassPermissions`), em que ele pode rodar qualquer comando.

---

**English:** please report vulnerabilities privately via **Security → Report a vulnerability** ([direct link](https://github.com/KazuoMurakami/octo-desktop/security/advisories/new)). Do not open public issues. Only the latest release receives security fixes.
