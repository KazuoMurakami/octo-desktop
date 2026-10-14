# Contribuindo com o Octo

Obrigado pelo interesse! Issues e pull requests são bem-vindos.

## Rodando localmente

Requer Node.js 22.18 ou mais novo (o servidor usa o suporte nativo a TypeScript do Node) e o [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) instalado.

```bash
npm install
npm run dev        # API em :4317 + interface com hot reload em http://localhost:5173 (use o link com token que aparece no terminal)
npm run desktop    # o app desktop (Electron); o menu Exibir tem as ferramentas de desenvolvedor
npm run dist       # gera o instalador do seu sistema em release/
```

Para não misturar com seus dados reais, rode com outra pasta: `OCTO_DATA_DIR=/tmp/octo-dev npm run dev`.

Para conferir o app empacotado sem usá-lo, rode o autoteste depois do `npm run dist`: ele sobe o servidor, confere a API, o executável e a interface numa janela oculta, e sai com código 0 ou 1.

```bash
OCTO_DATA_DIR=/tmp/octo-selftest release/win-unpacked/Octo.exe --self-test     # Windows (Git Bash)
OCTO_DATA_DIR=/tmp/octo-selftest release/mac-arm64/Octo.app/Contents/MacOS/Octo --self-test
OCTO_DATA_DIR=/tmp/octo-selftest-x64 arch -x86_64 release/mac/Octo.app/Contents/MacOS/Octo --self-test   # app Intel, no Rosetta
OCTO_DATA_DIR=/tmp/octo-selftest release/linux-unpacked/octo --self-test
node scripts/check-fuses.mjs release/win-unpacked/Octo.exe                       # confere os fuses do Electron
```

No app instalado, `OCTO_DEVTOOLS=1` mostra as ferramentas de desenvolvedor no menu Exibir.

## Antes de abrir um PR

- `npm run typecheck` e `npm run build:desktop` passam.
- A interface e as mensagens estão em português do Brasil, num tom direto.
- Mudanças em `server/terminal.ts`, `server/integrations.ts` ou no Electron foram testadas no sistema em que você roda (diga qual no PR).
- Nada de dependências novas sem necessidade; o app empacotado só leva o `express` em produção.
- Mudanças no `electron-builder.yml`, em `electron/` ou nos workflows: rode o workflow **Release** pelo botão *Run workflow* (no seu fork), que gera e testa os instaladores dos três sistemas sem publicar nada.
- Não desligue o fuse `runAsNode`: o terminal do Octo depende dele (veja o [SECURITY.md](SECURITY.md)).

## Estrutura

| Pasta | O que tem |
| --- | --- |
| `server/` | API Express 5, sessões do Claude, terminais, editores, git, configuração do Claude Code |
| `src/` | Interface React 19 + zustand |
| `electron/` | Processo principal do app desktop: janela, menu, permissões, ambiente do shell e autoteste |
| `shared/` | Tipos usados pelos dois lados |
| `scripts/` | Build do app desktop e conferência dos fuses |
| `build/` | Ícone e permissões (entitlements) do app no macOS |
| `docs/` | Documentação: instalação, dados e privacidade, como publicar uma versão |
| `.github/` | CI, release, Dependabot e modelos de issue |

## Reportando bugs

Use o modelo de bug ao abrir a issue (no app, **Ajuda → Reportar um problema…** já preenche a versão e o sistema) e informe a saída de `claude --version`. Para falhas de segurança, siga o [SECURITY.md](SECURITY.md).

## Publicando uma versão

Veja [docs/publicar-versao.md](docs/publicar-versao.md).
