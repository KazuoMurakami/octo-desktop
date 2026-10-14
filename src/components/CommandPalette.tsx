import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Code2, FileDiff, FileText, FolderGit2, FolderPlus, Inbox, KeyRound, Plus, RefreshCw, Settings2, SlidersHorizontal, SquareTerminal } from 'lucide-react';
import { api } from '../api.ts';
import { defaultAccountId, toast, useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { repoGroups } from '../util.ts';
import { StatusIcon } from './icons.tsx';
import { openInEditor } from './OpenMenu.tsx';

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
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const issues = useStore((s) => s.issues);
  const workspaces = useStore((s) => s.workspaces);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const { set, selectWorkspace } = useStore.getState();
    const go = (partial: Parameters<typeof set>[0]) => () => set({ ...partial, paletteOpen: false });
    const terminal = (dir?: string) => () => {
      if (!workspace) return;
      set({ paletteOpen: false });
      void api.openTerminal(workspace.id, { accountId: defaultAccountId(), dir }).then(() => toast('Terminal aberto com o Claude.', 'success'));
    };
    const list: Command[] = [
      { id: 'new', section: 'Ações', label: 'Nova issue', icon: <Plus size={14} />, hint: 'C', run: go({ modal: { kind: 'new-issue' } }) },
      { id: 'root', section: 'Ações', label: 'Abrir Claude na raiz do workspace', icon: <SquareTerminal size={14} />, run: terminal() },
      { id: 'ctx', section: 'Ações', label: 'Gerar CLAUDE.md da raiz', icon: <FileText size={14} />, run: go({ modal: { kind: 'context' } }) },
      {
        id: 'scan', section: 'Ações', label: 'Reescanear repositórios', icon: <RefreshCw size={14} />,
        run: () => {
          set({ paletteOpen: false });
          if (workspace) void api.scan(workspace.id).then((r) => toast(`${r.length} repositórios encontrados.`, 'success'));
        },
      },
      { id: 'connect', section: 'Ações', label: 'Conectar outra pasta', icon: <FolderPlus size={14} />, run: go({ modal: { kind: 'workspace' } }) },
      { id: 'prefs', section: 'Ações', label: 'Preferências: terminal e editor', icon: <Settings2 size={14} />, run: go({ modal: { kind: 'preferences' } }) },
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

  if (!open) return null;
  const close = () => useStore.getState().set({ paletteOpen: false });

  return createPortal(
    <div className="modal-backdrop is-top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette">
        <input
          autoFocus
          className="palette-input"
          placeholder="Buscar issues, repositórios ou ações…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, visible.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && visible[active]) visible[active].run();
          }}
        />
        <div className="palette-list">
          {visible.map((command, index) => (
            <div key={command.id}>
              {(index === 0 || visible[index - 1].section !== command.section) && <div className="palette-section">{command.section}</div>}
              <button className={`palette-item${index === active ? ' is-active' : ''}`} onMouseEnter={() => setActive(index)} onClick={command.run}>
                {command.icon}
                <span>{command.label}</span>
                {command.hint && <span className="dim">{command.hint}</span>}
              </button>
            </div>
          ))}
          {!visible.length && <div className="menu-empty">Nada encontrado</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
