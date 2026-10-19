// Os menus do botão direito de cada lugar (pasta, repositório, pasta de grupo, issue e sessão), montados na hora em
// que abrem, com as mesmas ações e as mesmas regras dos botões das telas.
import {
  Bot, CircleCheck, Code2, Copy, FileDiff, FolderInput, FolderOpen, ListFilter, PanelRight, Plus, RefreshCw, Settings2, Square,
  SquareTerminal, Terminal, Trash2, Unplug,
} from 'lucide-react';
import {
  PRIORITY_LABEL, STATUSES, STATUS_LABEL, type AgentSession, type Issue, type Priority, type Repo, type Workspace,
} from '../../shared/types.ts';
import { copyText, finishTerminalSession, openWorkspaceSettings, rescan, resumeInTerminal, updateIssueNow } from '../actions.ts';
import { api } from '../api.ts';
import { loadedIntegrations, openClaudeIn, terminalLabel } from '../integrations.ts';
import { toast, useStore } from '../store.ts';
import type { RepoGroup } from '../util.ts';
import { isLive, lostWorktree } from '../worktree.ts';
import type { ContextEntry } from './ContextMenu.tsx';
import { PriorityIcon, StatusIcon } from './icons.tsx';
import { fileManagerName, openInEditor, openInItems, openShellAt } from './OpenMenu.tsx';

const PRIORITIES: Priority[] = [0, 1, 2, 3, 4];

/** Abrir o Claude, o editor, um terminal e o gerenciador de arquivos numa pasta do workspace (a raiz, sem `dir`). */
function folderItems(workspaceId: string, claudeLabel: string, dir?: string, repoIds?: string[]): ContextEntry[] {
  const integrations = loadedIntegrations();
  const editor = integrations?.editors.find((e) => e.id === integrations.editor);
  const noEditor = Boolean(integrations && !integrations.editors.length);
  // As falhas já viram aviso em api.ts.
  return [
    { key: 'claude', label: claudeLabel, icon: <SquareTerminal size={14} />, onSelect: () => void openClaudeIn(workspaceId, dir) },
    {
      key: 'editor',
      label: 'Abrir no editor',
      icon: <Code2 size={14} />,
      hint: noEditor ? 'nenhum encontrado' : editor?.label,
      disabled: noEditor,
      onSelect: () => void openInEditor({ kind: 'folder', workspaceId, dir, repoIds }).catch(() => undefined),
    },
    {
      key: 'shell',
      label: 'Terminal aqui',
      icon: <Terminal size={14} />,
      hint: integrations ? terminalLabel(integrations) : undefined,
      onSelect: () => void openShellAt({ kind: 'folder', workspaceId, dir }).catch(() => undefined),
    },
    {
      key: 'reveal',
      label: `Mostrar no ${fileManagerName(useStore.getState().meta?.platform)}`,
      icon: <FolderOpen size={14} />,
      onSelect: () => void api.reveal(workspaceId, dir).catch(() => undefined),
    },
  ];
}

/** Pasta: o seletor do topo da barra lateral e cada pasta da lista dele. */
export function workspaceMenu(workspace: Workspace): ContextEntry[] {
  const s = useStore.getState();
  const isOpen = s.workspaceId === workspace.id;
  return [
    {
      key: 'open',
      label: 'Abrir',
      icon: <FolderInput size={14} />,
      disabled: isOpen,
      hint: isOpen ? 'já está aberta' : undefined,
      onSelect: () => s.selectWorkspace(workspace.id),
    },
    { key: 'settings', label: 'Configurações', icon: <Settings2 size={14} />, onSelect: () => openWorkspaceSettings(workspace.id) },
    { key: 'scan', label: 'Procurar repositórios de novo', icon: <RefreshCw size={14} />, onSelect: () => void rescan(workspace).catch(() => undefined) },
    'separator',
    ...folderItems(workspace.id, 'Abrir Claude na raiz'),
    'separator',
    { key: 'copy', label: 'Copiar caminho', icon: <Copy size={14} />, onSelect: () => void copyText(workspace.rootPath, 'Caminho copiado.') },
    'separator',
    {
      key: 'disconnect',
      label: 'Desconectar…',
      icon: <Unplug size={14} />,
      danger: true,
      onSelect: () => s.set({ modal: { kind: 'disconnect', workspaceId: workspace.id } }),
    },
  ];
}

/** Repositório: na barra lateral e na tabela de Repositórios. */
export function repoMenu(repo: Repo): ContextEntry[] {
  const s = useStore.getState();
  const filtered = s.repoFilter === repo.id;
  const dirty = repo.dirty === null ? undefined : repo.dirty === 0 ? 'limpo' : `${repo.dirty} ${repo.dirty === 1 ? 'arquivo' : 'arquivos'}`;
  return [
    {
      key: 'filter',
      label: 'Filtrar issues',
      icon: <ListFilter size={14} />,
      // Como o clique no repositório da barra lateral: escolher de novo tira o filtro.
      checked: filtered,
      onSelect: () => s.set({ view: 'issues', repoFilter: filtered ? null : repo.id }),
    },
    { key: 'new', label: 'Nova issue aqui', icon: <Plus size={14} />, onSelect: () => s.set({ modal: { kind: 'new-issue', repoIds: [repo.id] } }) },
    'separator',
    ...folderItems(repo.workspaceId, 'Abrir Claude aqui', repo.absPath),
    'separator',
    {
      key: 'changes',
      label: 'Ver mudanças',
      icon: <FileDiff size={14} />,
      hint: dirty,
      onSelect: () => s.set({ modal: { kind: 'changes', dir: repo.absPath, title: repo.name } }),
    },
    { key: 'copy', label: 'Copiar caminho', icon: <Copy size={14} />, onSelect: () => void copyText(repo.absPath, 'Caminho copiado.') },
  ];
}

/** Pasta de grupo, com os repositórios dela: na barra lateral e nos cards de Repositórios (não há filtro por grupo). */
export function groupMenu(workspaceId: string, group: RepoGroup): ContextEntry[] {
  const s = useStore.getState();
  const repoIds = group.repos.map((r) => r.id);
  return [
    {
      key: 'new',
      label: 'Nova issue aqui',
      icon: <Plus size={14} />,
      hint: `${group.repos.length} ${group.repos.length === 1 ? 'repositório' : 'repositórios'}`,
      onSelect: () => s.set({ modal: { kind: 'new-issue', repoIds } }),
    },
    'separator',
    ...folderItems(workspaceId, 'Abrir Claude aqui', group.dir, repoIds),
    'separator',
    { key: 'changes', label: 'Ver mudanças', icon: <FileDiff size={14} />, onSelect: () => s.set({ modal: { kind: 'changes', dir: group.dir, title: group.rel } }) },
    { key: 'copy', label: 'Copiar caminho', icon: <Copy size={14} />, onSelect: () => void copyText(group.dir, 'Caminho copiado.') },
  ];
}

/** Card ou linha de issue. Status e prioridade mudam na hora, como ao arrastar o card. */
export function issueMenu(issue: Issue): ContextEntry[] {
  const { set } = useStore.getState();
  return [
    { key: 'open', label: 'Abrir', icon: <PanelRight size={14} />, onSelect: () => set({ openIssueId: issue.id }) },
    'separator',
    {
      key: 'delegate',
      label: 'Delegar ao Claude',
      icon: <Bot size={14} />,
      onSelect: () => set({ modal: { kind: 'delegate', issueId: issue.id, mode: 'headless' } }),
    },
    {
      key: 'terminal',
      label: 'Abrir no terminal',
      icon: <SquareTerminal size={14} />,
      onSelect: () => set({ modal: { kind: 'delegate', issueId: issue.id, mode: 'terminal' } }),
    },
    'separator',
    {
      key: 'status',
      label: 'Status',
      icon: <StatusIcon status={issue.status} />,
      hint: STATUS_LABEL[issue.status],
      submenu: STATUSES.map((status) => ({
        key: status,
        label: STATUS_LABEL[status],
        icon: <StatusIcon status={status} />,
        checked: status === issue.status,
        radio: true,
        onSelect: () => {
          updateIssueNow(issue.id, { status });
          // Com as canceladas ocultas, o card some da tela: o aviso diz para onde ele foi.
          if (status === 'canceled') {
            requestAnimationFrame(() => {
              if (!document.getElementById(`issue-${issue.id}`)) toast(`${issue.identifier} cancelada. As canceladas ficam ocultas no quadro.`);
            });
          }
        },
      })),
    },
    {
      key: 'priority',
      label: 'Prioridade',
      icon: <PriorityIcon priority={issue.priority} />,
      hint: PRIORITY_LABEL[issue.priority],
      submenu: PRIORITIES.map((priority) => ({
        key: String(priority),
        label: PRIORITY_LABEL[priority],
        icon: <PriorityIcon priority={priority} />,
        checked: priority === issue.priority,
        radio: true,
        onSelect: () => updateIssueNow(issue.id, { priority }),
      })),
    },
    'separator',
    {
      key: 'copy',
      label: 'Copiar identificador',
      icon: <Copy size={14} />,
      hint: issue.identifier,
      onSelect: () => void copyText(issue.identifier, `${issue.identifier} copiado.`),
    },
    'separator',
    { key: 'delete', label: 'Excluir…', icon: <Trash2 size={14} />, danger: true, onSelect: () => set({ modal: { kind: 'delete-issue', issueId: issue.id } }) },
  ];
}

/**
 * Sessão do agente, com as regras dos botões do painel dela: Parar só enquanto ela roda, Marcar como concluída só no
 * terminal, e Continuar no terminal e Abrir em só com a conta e o worktree dela ainda no Octo.
 */
export function sessionMenu(session: AgentSession): ContextEntry[] {
  const s = useStore.getState();
  const issue = s.issues.find((i) => i.id === session.issueId);
  const account = s.accounts.find((a) => a.id === session.accountId);
  const workspace = s.workspaces.find((w) => w.id === session.workspaceId);
  const lost = lostWorktree(session, s.issues);
  const live = isLive(session);
  const integrations = loadedIntegrations();
  const gone = lost === 'issue' ? 'issue excluída' : lost ? 'worktree removido' : undefined;
  // Worktree removido: não há o que abrir (no mesmo caminho pode estar um worktree novo, de outra branch).
  const openIn = workspace && !lost
    ? openInItems({ kind: 'session', sessionId: session.id, workspaceId: workspace.id, dir: session.cwd }, integrations, s.meta?.platform)
    : [];

  const resume = () => {
    // Já foi aberta no terminal: aquela janela pode continuar aberta nesta conversa, então pergunta antes.
    if (session.mode === 'terminal') s.set({ modal: { kind: 'resume-terminal', sessionId: session.id } });
    else void resumeInTerminal(session.id, terminalLabel(integrations)).catch(() => undefined);
  };

  const actions: ContextEntry[] = [];
  if (!live) {
    actions.push({
      key: 'resume',
      label: 'Continuar no terminal',
      icon: <SquareTerminal size={14} />,
      disabled: !account || Boolean(lost),
      hint: !account ? 'conta removida' : (gone ?? (integrations ? terminalLabel(integrations) : undefined)),
      onSelect: resume,
    });
  }
  if (live) {
    actions.push({ key: 'stop', label: 'Parar', icon: <Square size={14} />, danger: true, onSelect: () => void api.stop(session.id).catch(() => undefined) });
  }
  if (session.state === 'terminal') {
    actions.push({
      key: 'finish',
      label: 'Marcar como concluída',
      icon: <CircleCheck size={14} />,
      onSelect: () => void finishTerminalSession(session.id).catch(() => undefined),
    });
  }
  actions.push({
    key: 'open-in',
    label: 'Abrir em',
    icon: <Code2 size={14} />,
    disabled: !openIn.length,
    hint: openIn.length ? undefined : (gone ?? 'pasta desconectada'),
    submenu: openIn.length ? openIn : undefined,
  });

  return [
    {
      key: 'open',
      label: 'Abrir',
      icon: <PanelRight size={14} />,
      // Com issue, abre a issue já nesta sessão (como o clique na lista).
      onSelect: () => s.set(issue ? { openIssueId: issue.id, openSessionId: session.id } : { openSessionId: session.id }),
    },
    'separator',
    ...actions,
    'separator',
    {
      key: 'copy',
      label: 'Copiar ID da conversa',
      icon: <Copy size={14} />,
      hint: `${session.claudeSessionId.slice(0, 8)}…`,
      onSelect: () => void copyText(session.claudeSessionId, 'ID da conversa copiado.'),
    },
  ];
}
