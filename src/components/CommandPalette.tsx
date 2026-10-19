import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot, Code2, FileDiff, FileText, FolderGit2, FolderPlus, Inbox, Keyboard, KeyRound, Plus, RefreshCw, Settings2, SlidersHorizontal, SquareTerminal,
} from 'lucide-react';
import { rescan } from '../actions.ts';
import { openClaudeIn } from '../integrations.ts';
import { useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { isMac, modKey, repoGroups } from '../util.ts';
import { StatusIcon } from './icons.tsx';
import { openInEditor } from './OpenMenu.tsx';
import { Kbd, Modal, trapTab, useDialog, useEscapeLayer } from './ui.tsx';

interface Command {
  id: string;
  label: string;
  section: string;
  icon: ReactNode;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  return open ? <Palette /> : null;
}

/** A paleta aberta (Ctrl/⌘ K): busca e executa ações, com o foco sempre na caixa de busca. */
function Palette() {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const issues = useStore((s) => s.issues);
  const workspaces = useStore((s) => s.workspaces);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const close = () => useStore.getState().set({ paletteOpen: false });
  useEscapeLayer(true, close, 'palette');
  useDialog(boxRef);

  const commands = useMemo<Command[]>(() => {
    const { set, selectWorkspace } = useStore.getState();
    const go = (partial: Parameters<typeof set>[0]) => () => set({ ...partial, paletteOpen: false });
    const terminal = (dir?: string) => () => {
      set({ paletteOpen: false });
      if (workspace) void openClaudeIn(workspace.id, dir);
    };
    const list: Command[] = [
      { id: 'new', section: 'Ações', label: 'Nova issue', icon: <Plus size={14} />, hint: 'C', run: go({ modal: { kind: 'new-issue' } }) },
      { id: 'root', section: 'Ações', label: 'Abrir Claude na raiz do workspace', icon: <SquareTerminal size={14} />, run: terminal() },
      { id: 'ctx', section: 'Ações', label: 'Gerar CLAUDE.md da raiz', icon: <FileText size={14} />, run: go({ modal: { kind: 'context' } }) },
      {
        id: 'scan', section: 'Ações', label: 'Reescanear repositórios', icon: <RefreshCw size={14} />,
        run: () => {
          set({ paletteOpen: false });
          if (workspace) void rescan(workspace).catch(() => undefined);
        },
      },
      { id: 'connect', section: 'Ações', label: 'Conectar outra pasta', icon: <FolderPlus size={14} />, run: go({ modal: { kind: 'workspace' } }) },
      { id: 'prefs', section: 'Ações', label: 'Preferências: terminal e editor', icon: <Settings2 size={14} />, run: go({ modal: { kind: 'preferences' } }) },
      { id: 'shortcuts', section: 'Ações', label: 'Atalhos de teclado', icon: <Keyboard size={14} />, hint: '?', run: go({ shortcutsOpen: true }) },
      { id: 'v-issues', section: 'Ir para', label: 'Issues', icon: <Inbox size={14} />, run: go({ view: 'issues' }) },
      { id: 'v-sessions', section: 'Ir para', label: 'Sessões do agente', icon: <Bot size={14} />, run: go({ view: 'sessions' }) },
      { id: 'v-repos', section: 'Ir para', label: 'Repositórios', icon: <FolderGit2 size={14} />, run: go({ view: 'repos' }) },
      { id: 'v-accounts', section: 'Ir para', label: 'Contas Claude', icon: <KeyRound size={14} />, run: go({ view: 'accounts' }) },
      { id: 'v-claude', section: 'Ir para', label: 'Configuração do Claude (modelo, effort, skills, MCP, plugins)', icon: <SlidersHorizontal size={14} />, run: go({ view: 'claude' }) },
    ];
    if (workspace) {
      const ws = workspace;
      list.splice(5, 0,
        { id: 'editor', section: 'Ações', label: 'Abrir o workspace no editor', icon: <Code2 size={14} />, run: () => { set({ paletteOpen: false }); void openInEditor({ kind: 'folder', workspaceId: ws.id }); } },
        { id: 'changes', section: 'Ações', label: 'Ver mudanças em todos os repositórios', icon: <FileDiff size={14} />, run: go({ modal: { kind: 'changes', dir: ws.rootPath, title: ws.name } }) },
      );
      for (const group of repoGroups(workspace, repos).filter((g) => g.repos.length > 1)) {
        list.push({ id: `g-${group.rel}`, section: 'Abrir Claude em', label: `${group.rel}/`, hint: `${group.repos.length} repos`, icon: <SquareTerminal size={14} />, run: terminal(group.dir) });
      }
      for (const repo of repos) {
        list.push({ id: `r-${repo.id}`, section: 'Abrir Claude em', label: repo.name, icon: <SquareTerminal size={14} />, run: terminal(repo.absPath) });
      }
    }
    for (const w of workspaces) {
      if (w.id !== workspace?.id) {
        list.push({ id: `w-${w.id}`, section: 'Workspaces', label: `Trocar para ${w.name}`, icon: <FolderGit2 size={14} />, run: () => { selectWorkspace(w.id); set({ paletteOpen: false }); } });
      }
    }
    for (const issue of issues.filter((i) => i.workspaceId === workspace?.id)) {
      list.push({ id: `i-${issue.id}`, section: 'Issues', label: `${issue.identifier} ${issue.title}`, icon: <StatusIcon status={issue.status} />, run: go({ openIssueId: issue.id }) });
    }
    return list;
  }, [workspace, repos, issues, workspaces]);

  const q = query.trim().toLowerCase();
  // Sem busca, mostra ações e pastas de grupo; issues e repos individuais aparecem ao digitar.
  const visible = (
    q
      ? commands.filter((c) => c.label.toLowerCase().includes(q))
      : commands.filter((c) => (c.section !== 'Issues' && c.section !== 'Abrir Claude em') || c.id.startsWith('g-'))
  ).slice(0, 60);
  const current = Math.min(active, visible.length - 1);

  // O item destacado sempre fica à vista ao navegar com as setas.
  useEffect(() => {
    if (current >= 0) itemRefs.current[current]?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  // A lista já vem agrupada: cada seção é um trecho contínuo.
  const sections: { name: string; start: number; commands: Command[] }[] = [];
  visible.forEach((command, index) => {
    const last = sections.at(-1);
    if (last?.name === command.section) last.commands.push(command);
    else sections.push({ name: command.section, start: index, commands: [command] });
  });

  return createPortal(
    <div className="modal-backdrop is-top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={boxRef} className="palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos" tabIndex={-1} onKeyDown={trapTab}>
        <input
          autoFocus
          className="palette-input"
          placeholder="Buscar issues, repositórios ou ações…"
          role="combobox"
          aria-label="Buscar issues, repositórios ou ações"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-activedescendant={visible[current] ? `${id}-${current}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive(Math.min(Math.max(current + (e.key === 'ArrowDown' ? 1 : -1), 0), visible.length - 1));
            } else if (e.key === 'Enter' && visible[current]) {
              e.preventDefault();
              visible[current].run();
            }
          }}
        />
        <div className="palette-list" id={`${id}-list`} role="listbox" aria-label="Resultados">
          {sections.map((section) => (
            <div key={`${section.name}-${section.start}`} role="group" aria-labelledby={`${id}-section-${section.start}`}>
              <div className="palette-section" id={`${id}-section-${section.start}`} aria-hidden>{section.name}</div>
              {section.commands.map((command, offset) => {
                const index = section.start + offset;
                return (
                  <button
                    key={command.id}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    id={`${id}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === current}
                    tabIndex={-1}
                    className={`palette-item${index === current ? ' is-active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()} // o foco fica na busca
                    onMouseMove={() => index !== current && setActive(index)}
                    onClick={command.run}
                  >
                    {command.icon}
                    <span>{command.label}</span>
                    {command.hint && <span className="dim">{command.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {!visible.length && <div className="menu-empty">Nada encontrado</div>}
        </div>
        <div className="palette-foot" aria-hidden>
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navegar</span>
          <span><Kbd>Enter</Kbd> executar</span>
          <span><Kbd>Esc</Kbd> fechar</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- atalhos de teclado

function shortcutGroups(mod: string): { title: string; keys: [string, string][] }[] {
  // O Chromium não abre o menu do botão direito pelo Shift+F10 no macOS (lá vale o Ctrl+clique).
  const contextMenu: [string, string][] = isMac() ? [] : [['Shift F10', 'Abre as ações do item focado, como o botão direito (a tecla Menu também)']];
  return [
    {
      title: 'Em qualquer tela',
      keys: [
        [`${mod} K`, 'Buscar issues, repositórios e ações'],
        ['C', 'Nova issue'],
        ['?', 'Mostrar estes atalhos'],
        ['Esc', 'Fecha a paleta, o menu, o modal ou o painel aberto, um de cada vez'],
        ...contextMenu,
      ],
    },
    {
      title: 'Escrevendo',
      keys: [
        ['Esc', 'Num campo com texto, o primeiro Esc só sai do campo'],
        [`${mod} Enter`, 'Envia a resposta ao agente ou cria a issue'],
        ['/', 'No começo da resposta ao agente: lista as skills e os comandos da conta'],
        [`${mod} V`, 'Na resposta ao agente (e ao delegar): anexa a imagem copiada, como um print'],
        [`${isMac() ? '⌥' : 'Alt'} V`, 'Anexa a imagem copiada mesmo quando há texto copiado junto'],
        [`${mod} S`, 'Salva skills, agentes, comandos e o settings.json'],
      ],
    },
    {
      title: 'Em menus e na paleta',
      keys: [
        ['↑ ↓', 'Move o destaque'],
        ['Enter', 'Escolhe o item destacado'],
        ['→ ←', 'Abre e fecha um submenu, como Status ▸'],
        ['Tab', 'Sai do menu'],
      ],
    },
  ];
}

/** Lista de atalhos (tecla ? ou "Atalhos de teclado" na paleta). */
export function ShortcutsHelp() {
  const open = useStore((s) => s.shortcutsOpen);
  if (!open) return null;
  const close = () => useStore.getState().set({ shortcutsOpen: false });
  return (
    <Modal title={<><Keyboard size={15} /> Atalhos de teclado</>} onClose={close} width={560}>
      <div className="shortcuts">
        {shortcutGroups(modKey()).map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.keys.map(([keys, what]) => (
                <div key={`${keys}:${what}`} className="shortcut">
                  <dt><Kbd>{keys}</Kbd></dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
