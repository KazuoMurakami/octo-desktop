# Changelog

## 0.1.1

- Corrige a seção Agente cortada no painel da issue quando a descrição é longa.

## 0.1.0 — primeira versão pública

- Workspaces: conecte uma pasta e o Octo encontra os repositórios git dentro dela, inclusive em pastas de grupo.
- Issues no estilo Linear (quadro e lista, status, prioridade, repositórios) delegáveis a uma conta do Claude.
- O agente roda na menor pasta que contém os repositórios da issue, com o mapa de todos eles no contexto.
- Duas formas de trabalhar: em segundo plano (feed ao vivo na issue) ou no seu terminal (PowerShell, Prompt de Comando, Terminal do macOS, iTerm2 ou o emulador do Linux).
- Aba **Mudanças**: o diff de cada repositório tocado pelo agente, direto no app.
- **Abrir em…** VS Code, Cursor, Windsurf ou Zed; com vários repositórios, abre um workspace com todos eles.
- Várias contas do Claude Code (cada uma com seu `CLAUDE_CONFIG_DIR`).
- Configuração do Claude Code por conta: modelo, effort, skills, agentes, comandos, MCP, plugins e `settings.json`.
- Opções do CLI por sessão: modelo, effort, permissões, agente, modelo reserva, pastas extras e orçamento.
- Avisos quando uma sessão em segundo plano termina ou precisa de você (o **Ver** abre a sessão), com notificação do sistema se você permitir; o título da janela mostra quantas sessões aguardam você.
- Permissões negadas ao fim de uma sessão em segundo plano: **Permitir e continuar** ou **Concluir assim mesmo**.
- Imagens na conversa: cole um print (Ctrl/⌘ V, ou Alt/⌥ V com texto copiado junto), arraste ou anexe imagens na resposta ao agente e ao delegar em segundo plano. Elas vão para o Claude com a mensagem e aparecem como miniaturas no feed.
- Worktrees por issue, com nomes curtos: **Trabalhar num worktree** (ao delegar, ou ligado por padrão no workspace) cria uma pasta em `~/.octo/worktrees` com cada repositório da issue numa branch como `prj-12-checkout-pix`, a partir da branch padrão atualizada ou da branch atual. O `.worktreeinclude` leva o `.env` e afins, as sessões seguintes da issue continuam ali, e remover o worktree mantém as branches.
- Sessões no terminal: **Sincronizar** traz o andamento para o Octo e **Marcar como concluída** fecha a sessão. Na aba Mudanças, o que já estava alterado antes da sessão começar aparece separado.
- Teclado: paleta de comandos (Ctrl/⌘ K), lista de atalhos (`?`) e Esc que fecha uma camada de cada vez. Menus, diálogos e o quadro funcionam com teclado e leitor de tela.
- Menus do botão direito (também pelo Shift+F10 e pela tecla Menu) em pastas, repositórios, pastas de grupo, cards e linhas de issue e sessões, com submenus de status e prioridade. Campos de texto e texto selecionado ganham Recortar, Copiar, Colar e Selecionar tudo no app desktop.
- **Desconectar esta pasta…** no seletor de pastas (e no botão direito de cada uma): a pasta sai do Octo com as issues e as sessões dela, sem apagar nada do disco.
- Nada se perde: título e descrição da issue são salvos enquanto você digita, e fechar um formulário com texto pede confirmação.
- Contas novas herdam suas preferências do Claude Code (`settings.json` sem chaves de API, `CLAUDE.md`, skills, agentes e comandos), mas não o login.
- Se o Claude Code sumir, ou se uma atualização automática deixar o executável quebrado, o Octo explica o que houve e como resolver.
- Os dados do Octo têm cópia de segurança, em duas gerações: se o `db.json` aparecer danificado ou num formato inesperado, o Octo recupera a última versão boa e avisa. Campos com tipo errado (de uma edição à mão, por exemplo) são corrigidos ao abrir, sem derrubar a interface.
- Aviso de nova versão dentro do app (dá para desligar nas Preferências). Em janelas estreitas, a navegação vira uma gaveta.
- App desktop para Windows (testado), macOS e Linux (beta), com API local protegida por token.
- A janela abre na hora, com uma tela de carregamento enquanto o servidor sobe, e tem menu em português; **Ajuda → Reportar um problema…** abre a issue com a versão e o sistema preenchidos.
- No macOS e no Linux, o app lê o ambiente do seu shell de login (PATH, variáveis do Claude Code, proxy, AWS), e as sessões em segundo plano rodam como no seu terminal.
- Na primeira abertura, a pasta sugerida é uma pasta comum de projetos que exista; sem nenhuma, o campo fica vazio, sem varrer a pasta pessoal inteira.
- Segurança do app: a janela nega pedidos de câmera, microfone, localização e afins; o executável sai com os fuses do Electron conferidos (sem `--inspect`, código só do `app.asar`, com verificação de integridade no macOS e no Windows).
- Repositórios que chegam de fora (num zip, numa pasta copiada) não rodam programas da própria configuração do git quando o Octo os lê: ao escanear a pasta, na aba Mudanças e no início e no fim das sessões, filtros, `core.fsmonitor`, `textconv` e hooks do repositório ficam desligados. Os filtros do seu `.gitconfig`, como o git-lfs, continuam valendo. Requer git 2.31 ou mais novo para isso; com um git antigo, o Octo avisa em vez de ler.
- **Permitir e continuar** libera exatamente o que o painel mostra: cada regra vai inteira ao Claude Code, um comando encadeado vira uma regra por parte (como o Claude Code confere), o `WebFetch` libera só o domínio bloqueado e o `Monitor` só o comando dele. Regras mais amplas que o bloqueio (com `*`, ou a ferramenta inteira) vêm desmarcadas e com aviso; as que valeriam para qualquer comando ou site, e os comandos com `$(…)`, laços ou here-docs, não podem ser liberados por ali (o painel explica como seguir). Embaixo de cada ação aparece o que foi bloqueado.
- As respostas ao agente e a sessão retomada no terminal também levam o contexto do workspace (as regras do Octo, as do worktree e as suas diretrizes), e as regras do Octo vêm primeiro: se as diretrizes forem longas demais, só o fim delas é cortado, com aviso.
- Aba Mudanças: um arquivo grande não esconde mais o diff dos seguintes, arquivos novos mostram o número de linhas, e o que muda dentro de submódulos aparece.
- O `.worktreeinclude` copia até 2.000 arquivos ou 50 MB sem travar o app; links que apontam para fora do repositório ficam de fora, e um arquivo grande demais não impede os seguintes.
- `CLAUDE.md` gerado: o nome, a branch e a descrição de cada repositório entram numa linha só. Marcadores citados no seu texto ou em blocos de código não contam, e um arquivo com marcadores repetidos (de uma versão anterior) ou fora de UTF-8 não é alterado: a janela mostra as linhas para você corrigir.
- Animações mais leves: o destaque das issues em andamento e o ícone de agente trabalhando rodam na GPU. Com muitas issues no quadro, o uso de CPU caiu de quase um núcleo inteiro para menos de 1%. Ações de execuções interrompidas param de piscar.
- Electron 44.8.0, com as correções de segurança mais recentes do Chromium. O CI roda no Windows, no macOS e no Linux, no Node 22.18 e no atual, e o app empacotado é testado a cada mudança no Electron.
- Instaladores gerados e testados pelo GitHub Actions em cada sistema, com `SHA256SUMS.txt` e atestação de proveniência anexada (`gh attestation verify`). O app do macOS tem assinatura ad-hoc, e os avisos de licença das bibliotecas vão junto com o instalador.
