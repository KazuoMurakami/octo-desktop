import type { ReactNode } from 'react';
import { ChevronDown, Code2, FolderOpen, Settings2, SquareTerminal } from 'lucide-react';
import type { Integrations, Workspace } from '../../shared/types.ts';
import { api } from '../api.ts';
import { terminalLabel, useIntegrations } from '../integrations.ts';
import { toast, useStore } from '../store.ts';
import { relativeTo } from '../util.ts';
import { Menu } from './ui.tsx';

/** O que abrir: a pasta de uma sessão (com os repositórios dela) ou uma pasta do workspace. */
export type OpenTarget =
  | { kind: 'session'; sessionId: string; workspaceId: string; dir: string }
  | { kind: 'folder'; workspaceId: string; dir?: string; repoIds?: string[] };

export function fileManagerName(platform: string | undefined): string {
  return platform === 'win32' ? 'Explorador de Arquivos' : platform === 'darwin' ? 'Finder' : 'gerenciador de arquivos';
}

/** Pasta relativa à raiz do workspace; a própria raiz aparece como "raiz (Nome)", e não como ".". */
export function folderLabel(workspace: Workspace, dir: string): string {
  const rel = relativeTo(workspace.rootPath, dir);
  return rel === '.' ? `raiz (${workspace.name})` : rel;
}

/** Abre no editor escolhido (ou no padrão das preferências). */
export function openInEditor(target: OpenTarget, editor?: string): Promise<unknown> {
  const request =
    target.kind === 'session'
      ? api.openSessionEditor(target.sessionId, editor)
      : api.openEditor(target.workspaceId, { dir: target.dir, repoIds: target.repoIds, editor });
  return request.then(({ editor: label }) => toast(`Abrindo no ${label}…`, 'success'));
}

export function openShellAt(target: OpenTarget): Promise<unknown> {
  return (target.kind === 'session' ? api.openSessionShell(target.sessionId) : api.openShell(target.workspaceId, target.dir)).then(() =>
    toast('Terminal aberto na pasta.', 'success'),
  );
}

/** Um item de "Abrir em…": serve tanto ao menu suspenso quanto ao submenu do botão direito. */
export interface OpenItem {
  key: string;
  label: string;
  icon: ReactNode;
  hint?: string;
  onSelect: () => void;
}

/** Itens de "Abrir em…": os editores instalados, um terminal na pasta, o gerenciador de arquivos e as preferências. */
export function openInItems(target: OpenTarget, integrations: Integrations | null, platform: string | undefined): OpenItem[] {
  const openPreferences = () => useStore.getState().set({ modal: { kind: 'preferences' } });
  // As falhas já viram aviso em api.ts.
  const editors: OpenItem[] = (integrations?.editors ?? []).map((editor) => ({
    key: `editor:${editor.id}`,
    label: `Abrir no ${editor.label}`,
    icon: <Code2 size={14} />,
    hint: editor.id === integrations?.editor ? 'padrão' : undefined,
    onSelect: () => void openInEditor(target, editor.id).catch(() => undefined),
  }));

  return [
    ...(editors.length
      ? editors
      : [{ key: 'no-editor', label: 'Nenhum editor encontrado', hint: 'VS Code, Cursor…', icon: <Code2 size={14} />, onSelect: openPreferences }]),
    {
      key: 'shell',
      label: `Terminal aqui (${terminalLabel(integrations)})`,
      icon: <SquareTerminal size={14} />,
      onSelect: () => void openShellAt(target).catch(() => undefined),
    },
    {
      key: 'reveal',
      label: `Mostrar no ${fileManagerName(platform)}`,
      icon: <FolderOpen size={14} />,
      onSelect: () => void api.reveal(target.workspaceId, target.dir).catch(() => undefined),
    },
    { key: 'prefs', label: 'Escolher terminal e editor…', icon: <Settings2 size={14} />, onSelect: openPreferences },
  ];
}

/** "Abrir em…": editores instalados, um terminal na pasta e o gerenciador de arquivos. */
export function OpenMenu({ target, trigger, className = 'ghost-btn is-small', align = 'end', label }: {
  target: OpenTarget;
  trigger?: ReactNode;
  className?: string;
  align?: 'start' | 'end';
  /** Nome do gatilho (leitor de tela e dica do mouse); obrigatório na prática quando o gatilho é só um ícone. */
  label?: string;
}) {
  const integrations = useIntegrations();
  const platform = useStore((s) => s.meta?.platform);
  return (
    <Menu
      className={className}
      align={align}
      width={290}
      label={label}
      trigger={trigger ?? <><Code2 size={13} /> Abrir em <ChevronDown size={12} /></>}
      items={openInItems(target, integrations, platform)}
    />
  );
}
