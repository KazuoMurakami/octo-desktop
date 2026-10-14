# Changelog

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
- Sessões no terminal: **Sincronizar** traz o andamento para o Octo e **Marcar como concluída** fecha a sessão. Na aba Mudanças, o que já estava alterado antes da sessão começar aparece separado.
- Teclado: paleta de comandos (Ctrl/⌘ K), lista de atalhos (`?`) e Esc que fecha uma camada de cada vez. Menus, diálogos e o quadro funcionam com teclado e leitor de tela.
- Nada se perde: título e descrição da issue são salvos enquanto você digita, e fechar um formulário com texto pede confirmação.
- Contas novas herdam suas preferências do Claude Code (`settings.json` sem chaves de API, `CLAUDE.md`, skills, agentes e comandos), mas não o login.
- Se o Claude Code sumir, ou se uma atualização automática deixar o executável quebrado, o Octo explica o que houve e como resolver.
- Os dados do Octo têm cópia de segurança: se o `db.json` aparecer danificado, o Octo recupera a última versão boa e avisa.
- Aviso de nova versão dentro do app (dá para desligar nas Preferências). Em janelas estreitas, a navegação vira uma gaveta.
- App desktop para Windows (testado), macOS e Linux (beta), com API local protegida por token.
- A janela abre na hora, com uma tela de carregamento enquanto o servidor sobe, e tem menu em português; **Ajuda → Reportar um problema…** abre a issue com a versão e o sistema preenchidos.
- No macOS e no Linux, o app lê o ambiente do seu shell de login (PATH, variáveis do Claude Code, proxy, AWS), e as sessões em segundo plano rodam como no seu terminal.
- Na primeira abertura, a pasta sugerida é uma pasta comum de projetos que exista; sem nenhuma, o campo fica vazio, sem varrer a pasta pessoal inteira.
- Segurança do app: a janela nega pedidos de câmera, microfone, localização e afins; o executável sai com os fuses do Electron conferidos (sem `--inspect`, código só do `app.asar`, com verificação de integridade no macOS e no Windows).
- Instaladores gerados e testados pelo GitHub Actions em cada sistema, com `SHA256SUMS.txt` e atestação de proveniência anexada (`gh attestation verify`). O app do macOS tem assinatura ad-hoc, e os avisos de licença das bibliotecas vão junto com o instalador.
