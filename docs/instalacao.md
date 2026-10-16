# Instalação e solução de problemas

## Requisitos

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Sistema | Windows 10 ou 11, x64 | macOS 13 (Ventura) ou mais novo, Apple Silicon ou Intel | x64, distribuição atual (Ubuntu 22.04+, Debian 12+, Fedora, Arch…) |
| Situação | testado | beta | beta |
| Claude Code | Instalado no próprio Windows (o do WSL não é encontrado) | Instalado e no PATH do seu shell | Instalado e no PATH do seu shell |
| git (2.31 ou mais novo) | [Git for Windows](https://git-scm.com/download/win) | `xcode-select --install` ou Homebrew | Pelo gerenciador de pacotes |

Em todos os sistemas, o Claude Code precisa estar logado: rode `claude` uma vez no terminal. Cada sessão do Octo usa a cota da conta escolhida (plano Pro, Max, Team, Enterprise ou créditos de API), como o `claude` no seu terminal.

**Beta** quer dizer que o instalador passa pelo autoteste automático a cada versão, mas ainda não foi usado no dia a dia nesse sistema. Se algo não funcionar, [abra uma issue](https://github.com/KazuoMurakami/octo-desktop/issues/new?template=bug_report.yml) dizendo o sistema e a versão.

## Windows

1. Baixe o [`Octo-Setup.exe`](https://github.com/KazuoMurakami/octo-desktop/releases/latest/download/Octo-Setup.exe) e abra.
2. O SmartScreen mostra "O Windows protegeu o computador", porque o instalador não tem assinatura de código paga. Clique em **Mais informações → Executar assim mesmo**.
3. O Octo instala só para o seu usuário (sem pedir administrador) e abre.

**O Octo diz que não encontrou o Claude Code.** Instale o Claude Code no Windows ([instruções](https://docs.claude.com/en/docs/claude-code/setup)), rode `claude` uma vez no PowerShell e clique em **Verificar de novo**. Se ele estiver num lugar fora do comum, defina a variável de usuário `OCTO_CLAUDE_BIN` com o caminho do `claude.exe` e reabra o Octo.

## macOS

O app tem assinatura ad-hoc, mas não é notarizado pela Apple. Por isso o macOS bloqueia a primeira abertura; é esperado.

1. Abra o `.dmg` (`arm64` para Apple Silicon, `x64` para Intel) e **arraste o Octo para Aplicativos**. Não abra direto do `.dmg`: o macOS roda apps baixados a partir de um local temporário e somente leitura.
2. Abra o Octo. No aviso, clique em **Concluído** (não em "Mover para o Lixo").
3. Vá em **Ajustes do Sistema → Privacidade e Segurança**, role até **Segurança** e clique em **Abrir Mesmo Assim**. Confirme com sua senha. O botão aparece por cerca de uma hora depois da tentativa, e só é preciso fazer isso uma vez.

No macOS 14 ou anterior, também funciona clicar com o botão direito no Octo em Aplicativos e escolher **Abrir**.

**Plano B no Terminal**, depois de [conferir o download](#conferir-o-download):

```bash
xattr -dr com.apple.quarantine /Applications/Octo.app
```

**Permissões que o macOS pode pedir**

- **Automação**, ao abrir o Claude no iTerm2: o Octo controla o iTerm2 para abrir a janela na pasta certa. Se você negou sem querer, libere em **Ajustes do Sistema → Privacidade e Segurança → Automação → Octo**.
- **Pastas** (Documentos, Mesa, Transferências), se os seus projetos estiverem nelas: o macOS pergunta quando o Octo ou o Claude acessam essas pastas pela primeira vez.

Como o app não tem assinatura da Apple, o macOS pode pedir essas permissões de novo depois de uma atualização.

**Ambiente do shell.** Apps abertos pelo Finder não recebem o ambiente do seu shell. O Octo lê o ambiente de um shell de login (`$SHELL -i -l -c`) ao abrir, para que o `claude`, o `git`, o `node` e variáveis como `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `HTTPS_PROXY` e `NODE_EXTRA_CA_CERTS` estejam disponíveis como no seu terminal. Se o seu `~/.zshrc` demora mais de 10 segundos ou pede alguma coisa, essa leitura é abandonada e o Octo segue com o ambiente do sistema. Se faltar alguma variável nas sessões, saia do Octo (`⌘ Q`; fechar a janela não basta) e abra-o pelo Terminal (`/Applications/Octo.app/Contents/MacOS/Octo`): quando a leitura falha, o motivo aparece ali.

**git.** Sem as ferramentas de linha de comando da Apple, o `/usr/bin/git` só abre o aviso para instalá-las. Rode `xcode-select --install` (ou instale o git pelo Homebrew) antes de conectar a pasta.

## Linux

### .deb (Ubuntu, Debian e derivados), o recomendado

```bash
sudo apt install ./Octo-linux-x64.deb
```

O pacote instala o Octo no menu de aplicativos. No Ubuntu 24.04 ou mais novo, ele também instala um perfil do AppArmor que mantém o sandbox do Chromium funcionando.

### AppImage (outras distros)

```bash
chmod +x Octo-linux-x64.AppImage
./Octo-linux-x64.AppImage
```

- **"AppImages require FUSE to run"**: instale o FUSE 2. No Ubuntu 24.04 ou mais novo e no Debian 13: `sudo apt install libfuse2t64` (se o `apt` não achar o pacote no Ubuntu, habilite o repositório universe com `sudo add-apt-repository universe`). No Ubuntu 22.04: `sudo apt install libfuse2`. Em outras distros, o pacote costuma se chamar `fuse2` ou `fuse-libs`.
- **Não instale o pacote `fuse`** no Ubuntu 22.04 ou mais novo: ele pode quebrar o sistema.
- Sem FUSE, dá para rodar extraindo o app a cada abertura: `./Octo-linux-x64.AppImage --appimage-extract-and-run`.
- No Ubuntu 24.04 ou mais novo, o sistema restringe os recursos que o sandbox do Chromium usa, e o AppImage abre sem ele. Por isso, nessas versões, prefira o `.deb`.

**Terminais.** O Octo abre o Claude no emulador escolhido em Preferências: GNOME Terminal, Ptyxis, Console do GNOME, Konsole, Terminal do Xfce, Tilix, Terminator, Ghostty, kitty, Alacritty, WezTerm, foot ou XTerm, além do terminal padrão do sistema. Um terminal definido na variável `TERMINAL` aparece primeiro.

## Conferir o download

Cada release traz:

- `SHA256SUMS.txt`, com o hash SHA-256 de cada instalador;
- `Octo-vX.Y.Z.sigstore.json`, a atestação de proveniência assinada pelo GitHub (Sigstore), que prova que o arquivo saiu do workflow `release.yml` deste repositório.

```bash
# Linux
sha256sum --check --ignore-missing SHA256SUMS.txt

# macOS
shasum -a 256 --check --ignore-missing SHA256SUMS.txt
```

No Windows (PowerShell), compare a saída com a linha do arquivo em `SHA256SUMS.txt`:

```powershell
Get-FileHash .\Octo-Setup.exe
```

Para conferir a origem com o [GitHub CLI](https://cli.github.com/) (com o `.sigstore.json` da release não precisa de login; sem ele, rode `gh auth login` antes):

```bash
gh attestation verify Octo-Setup.exe \
  --repo KazuoMurakami/octo-desktop \
  --signer-workflow KazuoMurakami/octo-desktop/.github/workflows/release.yml \
  --bundle Octo-v0.1.0.sigstore.json
```

## Desinstalar

| Sistema | Como |
| --- | --- |
| Windows | **Configurações → Aplicativos → Aplicativos instalados → Octo → Desinstalar** |
| macOS | Arraste o Octo de Aplicativos para o Lixo |
| Linux (.deb) | `sudo apt remove octo` |
| Linux (AppImage) | Apague o arquivo |

Isso remove o programa e mantém seus dados. Para apagar tudo, veja [Dados e privacidade](dados-e-privacidade.md#apagar-tudo).
