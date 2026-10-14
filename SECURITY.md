# Segurança

O Octo executa o Claude Code na sua máquina, então levamos segurança a sério.

## Como reportar uma vulnerabilidade

**Não abra uma issue pública.** Use o reporte privado do GitHub: aba **Security** → **Report a vulnerability** neste repositório. Descreva o problema, como reproduzir e o impacto. Você recebe uma resposta em até 7 dias.

## Versões com suporte

Apenas a versão mais recente publicada em [Releases](../../releases/latest) recebe correções de segurança.

## Modelo de segurança

- O servidor interno escuta só em `127.0.0.1` e exige um token guardado em `~/.octo/token` (legível só pelo seu usuário). Requisições com `Host` ou `Origin` de outros sites são recusadas.
- O Octo não lê nem guarda credenciais do Claude. Login e chamadas à Anthropic ficam com o próprio Claude Code.
- O Octo não envia seus dados a lugar nenhum: não há telemetria, analytics ou servidor remoto. A única conexão que ele faz por conta própria é consultar as releases deste repositório no GitHub para avisar de versões novas (pode ser desligada em Preferências).
- Os instaladores são gerados pelo GitHub Actions a partir do código deste repositório, com checksums SHA-256 e atestação de proveniência. Veja como verificar no [README](README.md#verificando-o-download).

Estão no escopo: a API local, a abertura de terminais e editores, a edição de configuração do Claude Code, o processo do Electron e o pipeline de release. O comportamento do próprio Claude Code e o que o agente faz quando você escolhe o modo "Sem restrições" estão fora do escopo.

---

**English:** please report vulnerabilities privately via **Security → Report a vulnerability**. Do not open public issues.
