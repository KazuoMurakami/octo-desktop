# Publicar uma versão

Para mantenedores. Uma versão sai de uma tag `vX.Y.Z` que bate com o `version` do `package.json`.

## Passo a passo

1. Na `main` atualizada e com o CI verde, escreva a seção da versão no [CHANGELOG.md](../CHANGELOG.md) (`## 0.2.0 — …`) e faça o commit.
2. Crie a versão. O `npm version` atualiza o `package.json` e o `package-lock.json`, faz o commit e cria a tag:

   ```bash
   npm version 0.2.0
   git push --follow-tags
   ```

3. O workflow [Release](../.github/workflows/release.yml) roda em Windows, macOS e Linux. Cada job:
   - confere se a tag bate com o `package.json` e o `package-lock.json` (e avisa se faltar a seção no CHANGELOG);
   - roda `npm ci` (sem baixar o Electron do npm) e o `npm run typecheck`;
   - gera os instaladores (`npm run dist`) e confere os fuses do Electron (`scripts/check-fuses.mjs`);
   - no macOS, confere a assinatura ad-hoc com `codesign --verify --deep --strict`, o identificador `io.github.kazuomurakami.octo`, a permissão de Apple Events e o `NSAppleEventsUsageDescription`;
   - roda o autoteste do app empacotado (`--self-test`): o servidor sobe, a API recusa acesso sem o token e aceita com ele, o executável roda como Node (o terminal depende disso) e a interface carrega numa janela oculta, com sandbox e sem violar a Content-Security-Policy. No macOS ele roda nos dois apps, o Intel no Rosetta (o runner é Apple Silicon e instala o Rosetta se faltar); no Linux, com o sandbox do Chromium ligado.
4. Se os três passarem, o último job gera o `SHA256SUMS.txt`, a atestação de proveniência (anexada como `Octo-vX.Y.Z.sigstore.json`) e um **rascunho** de release com tudo.
5. Abra o rascunho em Releases, revise as notas, baixe um instalador e confira com `gh attestation verify` (veja [Instalação](instalacao.md#conferir-o-download)). Então publique.

Os links `releases/latest/download/<arquivo>` do README passam a apontar para a versão nova assim que ela é publicada, porque os nomes dos instaladores não levam a versão.

Se um job falhar por instabilidade (download do Electron, por exemplo), use **Re-run failed jobs**. O workflow não usa cache dos downloads do Electron: uma tag só aproveitaria cache gravado pela `main`, e o electron-builder reaproveita a pasta já extraída sem conferir o conteúdo de novo, o que abriria uma porta para um build adulterado.

## Configurações do repositório (uma vez)

No GitHub, em **Settings**:

- **Advanced Security → Private vulnerability reporting: Enable.** Sem isso, o botão **Report a vulnerability** do [SECURITY.md](../SECURITY.md) e o link do modelo de issue dão 404 para quem não é mantenedor. Pela linha de comando: `gh api -X PUT repos/KazuoMurakami/octo-desktop/private-vulnerability-reporting`.
- **Advanced Security → Dependabot security updates: Enable.** As atualizações de versão já estão em [.github/dependabot.yml](../.github/dependabot.yml).
- **General → Releases → Enable release immutability**: uma release publicada não pode mais ter os arquivos trocados, e o GitHub gera uma atestação da release (`gh release verify`).
- **Branches → regra para `main`**: exigir o CI verde antes do merge.
- **General → Social preview**: uma imagem de 1280×640.

## Assinatura

- **macOS:** assinatura ad-hoc (`mac.identity: "-"` no `electron-builder.yml`), sem custo. O usuário libera o app uma vez em Ajustes do Sistema. Para tirar o aviso de vez, é preciso uma conta Apple Developer (US$ 99 por ano), assinatura com Developer ID e notarização: os segredos `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID` no workflow, e `mac.identity` removido.
- **Windows:** sem assinatura, o SmartScreen avisa até o instalador ganhar reputação. Alternativas: [SignPath Foundation](https://signpath.org/) (gratuito para projetos open source) ou o Artifact Signing da Microsoft.

## Mudanças que exigem cuidado

- **`appId` (`io.github.kazuomurakami.octo`):** não mude. O Windows deriva dele a entrada de desinstalação e o atalho, e o macOS guarda nele as permissões. Ele também aparece em `app.setAppUserModelId` (`electron/main.ts`).
- **Fuses (`electronFuses`):** `runAsNode` precisa continuar ligado enquanto o terminal usar o `server/launcher.mjs` e o app ler o ambiente do shell pelo próprio executável. O motivo de cada fuse está no [SECURITY.md](../SECURITY.md).
- **Atualizar o electron-builder para a 27:** os entitlements padrão do macOS e o runtime padrão do AppImage mudam. Revise `build/entitlements.mac.plist` e o comentário sobre `toolsets.appimage` no `electron-builder.yml`.
