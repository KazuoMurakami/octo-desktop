# Contribuindo com o Octo

Obrigado pelo interesse! Issues e pull requests são bem-vindos.

## Rodando localmente

Requer Node.js 22.18 ou mais novo (o servidor usa o suporte nativo a TypeScript do Node) e o [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) instalado.

```bash
npm install
npm run dev        # API em :4317 + interface com hot reload em http://localhost:5173 (use o link com token que aparece no terminal)
npm run desktop    # o app desktop (Electron)
npm run dist       # gera o instalador do seu sistema em release/
```

Para não misturar com seus dados reais, rode com outra pasta: `OCTO_DATA_DIR=/tmp/octo-dev npm run dev`.

## Antes de abrir um PR

- `npm run typecheck` e `npm run build:desktop` passam.
- A interface e as mensagens estão em português do Brasil, num tom direto.
- Mudanças em `server/terminal.ts`, `server/integrations.ts` ou no Electron foram testadas no sistema em que você roda (diga qual no PR).
- Nada de dependências novas sem necessidade; o app empacotado só leva o `express` em produção.

## Estrutura

| Pasta | O que tem |
| --- | --- |
| `server/` | API Express 5, sessões do Claude, terminais, editores, git, configuração do Claude Code |
| `src/` | Interface React 19 + zustand |
| `electron/` | Processo principal do app desktop |
| `shared/` | Tipos usados pelos dois lados |
| `scripts/` | Build do app desktop |

## Reportando bugs

Use o modelo de bug ao abrir a issue e informe o sistema, a versão do Octo e a saída de `claude --version`. Para falhas de segurança, siga o [SECURITY.md](SECURITY.md).
