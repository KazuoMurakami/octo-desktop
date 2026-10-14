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
- App desktop para Windows, macOS e Linux, com API local protegida por token.
