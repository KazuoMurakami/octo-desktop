import { useEffect, useMemo, useState } from 'react';
import { Code2, ExternalLink, FileDiff, FileText, FolderOpen, GitBranch, Plus, RefreshCw, SquareTerminal, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api.ts';
import { setting, useAccountConfig } from '../claudeConfig.ts';
import { defaultAccountId, toast, useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { ago, hue, repoGroups, shortRepoName } from '../util.ts';
import { AccountAvatar } from './icons.tsx';
import { OpenMenu, openInEditor } from './OpenMenu.tsx';
import { EffortPicker, ModelPicker, PermissionPicker } from './SessionSettings.tsx';
import { AutoTextarea, Field, Menu, RepoChip } from './ui.tsx';

export function ReposView() {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const { accounts, accountStatus, set } = useStore(useShallow((s) => ({ accounts: s.accounts, accountStatus: s.accountStatus, set: s.set })));
  const [scanning, setScanning] = useState(false);
  const [guidance, setGuidance] = useState(workspace?.guidance ?? '');
  const groups = useMemo(() => (workspace ? repoGroups(workspace, repos).filter((g) => g.repos.length > 1) : []), [workspace, repos]);

  useEffect(() => setGuidance(workspace?.guidance ?? ''), [workspace?.id, workspace?.guidance]);
  const { config } = useAccountConfig(workspace?.defaultAccountId);

  if (!workspace) return null;
  const open = (dir?: string) => api.openTerminal(workspace.id, { accountId: defaultAccountId(), dir }).then(() => toast('Terminal aberto com o Claude.', 'success'));
  const rescan = async () => {
    setScanning(true);
    try {
      const found = await api.scan(workspace.id);
      toast(`${found.length} repositórios encontrados.`, 'success');
    } finally {
      setScanning(false);
    }
  };
  const defaultAccount = accounts.find((a) => a.id === workspace.defaultAccountId);

  return (
    <section className="view view-scroll">
      <header className="view-head">
        <h1>Repositórios</h1>
        <span className="mono dim root-path" title={workspace.rootPath}>{workspace.rootPath}</span>
        <div className="view-tools">
          <OpenMenu target={{ kind: 'folder', workspaceId: workspace.id }} className="ghost-btn" />
          <button className="ghost-btn" onClick={() => set({ modal: { kind: 'changes', dir: workspace.rootPath, title: workspace.name } })}><FileDiff size={14} /> Mudanças</button>
          <button className="ghost-btn" onClick={rescan} disabled={scanning}><RefreshCw size={14} className={scanning ? 'spin' : ''} /> Reescanear</button>
          <button className="ghost-btn" onClick={() => set({ modal: { kind: 'context' } })}><FileText size={14} /> CLAUDE.md da raiz</button>
          <button className="primary-btn" onClick={() => open()}><SquareTerminal size={14} /> Abrir Claude na raiz</button>
        </div>
      </header>

      {groups.length > 0 && (
        <>
          <h2 className="block-title">Pastas que agrupam repositórios</h2>
          <p className="block-sub">Abrir o Claude numa destas pastas dá a ele o contexto de todos os repositórios dela, sem um Claude por repo.</p>
          <div className="groups">
            {groups.map((group) => (
              <div key={group.rel} className="group-card">
                <div className="group-name"><FolderOpen size={15} /> {group.rel}</div>
                <div className="group-repos">{group.repos.map((r) => <RepoChip key={r.id} repo={r} />)}</div>
                <div className="group-actions">
                  <button className="primary-btn is-small" onClick={() => open(group.dir)}><SquareTerminal size={13} /> Claude aqui</button>
                  <button className="ghost-btn is-small" onClick={() => set({ modal: { kind: 'new-issue', repoIds: group.repos.map((r) => r.id) } })}><Plus size={13} /> Issue</button>
                  <button className="ghost-btn is-small" onClick={() => set({ modal: { kind: 'context', dir: group.dir } })} title="Gerar CLAUDE.md desta pasta"><FileText size={13} /></button>
                  <button className="ghost-btn is-small" onClick={() => set({ modal: { kind: 'changes', dir: group.dir, title: group.rel } })} title="Ver o que mudou nos repositórios desta pasta"><FileDiff size={13} /></button>
                  <OpenMenu target={{ kind: 'folder', workspaceId: workspace.id, dir: group.dir, repoIds: group.repos.map((r) => r.id) }} trigger={<Code2 size={13} />} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="block-title">Todos os repositórios <span className="dim">{repos.length}</span></h2>
      <div className="repo-table">
        <div className="repo-tr is-head">
          <span>Repositório</span><span>Branch</span><span>Alterações</span><span>Stack</span><span>Último commit</span><span />
        </div>
        {repos.map((repo) => (
          <div key={repo.id} className="repo-tr">
            <span className="repo-name">
              <i style={{ background: hue(repo.name) }} />
              <span>
                <strong>{shortRepoName(repo)}</strong>
                {repo.name.includes('/') && <small className="dim mono">{repo.name.split('/').slice(0, -1).join('/')}/</small>}
                {repo.description && <small className="dim repo-desc">{repo.description}</small>}
              </span>
            </span>
            <span className="mono">
              <GitBranch size={12} /> <span className="branch-name" title={repo.branch ?? ''}>{repo.branch ?? '—'}</span>
              {(repo.ahead ?? 0) > 0 && <em className="ahead">↑{repo.ahead}</em>}
              {(repo.behind ?? 0) > 0 && <em className="behind">↓{repo.behind}</em>}
            </span>
            <span>
              {repo.dirty === null ? '—' : repo.dirty === 0 ? <span className="dim">limpo</span> : (
                <button className="dirty-btn" title="Ver as mudanças" onClick={() => set({ modal: { kind: 'changes', dir: repo.absPath, title: repo.name } })}>
                  <em className="dirty">{repo.dirty}</em>
                </button>
              )}
            </span>
            <span className="stack">
              {repo.stack.slice(0, 4).map((s) => <span key={s} className="tag">{s}</span>)}
              {repo.hasClaudeMd && <span className="tag is-claude" title="Tem CLAUDE.md próprio">CLAUDE.md</span>}
            </span>
            <span className="dim" title={repo.lastCommitMessage ?? ''}>{ago(repo.lastCommitAt)}</span>
            <span className="repo-actions">
              <button className="icon-btn" title="Abrir o Claude neste repositório" onClick={() => open(repo.absPath)}><SquareTerminal size={14} /></button>
              <button className="icon-btn" title="Abrir no editor" onClick={() => void openInEditor({ kind: 'folder', workspaceId: workspace.id, dir: repo.absPath })}><Code2 size={14} /></button>
              <OpenMenu target={{ kind: 'folder', workspaceId: workspace.id, dir: repo.absPath }} className="icon-btn" trigger={<FolderOpen size={14} />} />
              {repo.remoteUrl?.startsWith('http') && (
                <a className="icon-btn" title={repo.remoteUrl} href={repo.remoteUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>
              )}
              <button className="icon-btn" title="Nova issue neste repositório" onClick={() => set({ modal: { kind: 'new-issue', repoIds: [repo.id] } })}><Plus size={14} /></button>
            </span>
          </div>
        ))}
      </div>

      <h2 className="block-title">Configuração do workspace</h2>
      <div className="settings">
        <Field label="Diretrizes para o agente" hint="Vão para o system prompt de toda sessão e para o CLAUDE.md gerado, como o “agent guidance” do Linear.">
          <AutoTextarea
            minRows={4}
            value={guidance}
            placeholder={'Ex.: Use pnpm. Commits em português no padrão Conventional Commits.\nO front (loja-web) consome a loja-api.'}
            onChange={(e) => setGuidance(e.target.value)}
            onBlur={() => guidance !== workspace.guidance && api.updateWorkspace(workspace.id, { guidance }).then(() => toast('Diretrizes salvas.', 'success'))}
          />
        </Field>
        <div className="settings-row">
          <Field label="Conta padrão">
            <Menu
              className="prop-btn"
              trigger={<><AccountAvatar account={defaultAccount} size={16} /> {defaultAccount?.name ?? 'Nenhuma'}</>}
              items={accounts.map((a) => ({
                key: a.id, label: a.name, hint: accountStatus[a.id]?.email ?? '', icon: <AccountAvatar account={a} size={16} />,
                selected: a.id === workspace.defaultAccountId, onSelect: () => api.updateWorkspace(workspace.id, { defaultAccountId: a.id }),
              }))}
            />
          </Field>
          <Field label="Permissões padrão">
            <PermissionPicker value={workspace.defaultPermissionMode} onChange={(m) => api.updateWorkspace(workspace.id, { defaultPermissionMode: m })} />
          </Field>
          <Field label="Modelo padrão">
            <ModelPicker
              key={workspace.id}
              value={workspace.defaultModel}
              onChange={(model) => api.updateWorkspace(workspace.id, { defaultModel: model })}
              accountDefault={setting(config, 'model')}
            />
          </Field>
          <Field label="Prefixo das issues">
            <input
              className="input mono"
              defaultValue={workspace.key}
              maxLength={6}
              onBlur={(e) => e.target.value !== workspace.key && api.updateWorkspace(workspace.id, { key: e.target.value })}
            />
          </Field>
          <Field label="Profundidade da busca">
            <input
              className="input"
              type="number"
              min={1}
              max={6}
              defaultValue={workspace.scanDepth}
              onBlur={(e) => Number(e.target.value) !== workspace.scanDepth && api.updateWorkspace(workspace.id, { scanDepth: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Field label="Esforço padrão (effort)" hint="Vale para as sessões novas deste workspace, inclusive o “Claude aqui”. Dá para trocar em cada delegação.">
          <EffortPicker
            value={workspace.defaultEffort}
            onChange={(effort) => api.updateWorkspace(workspace.id, { defaultEffort: effort })}
            accountDefault={setting(config, 'effortLevel')}
          />
        </Field>
        <button
          className="ghost-btn is-danger"
          onClick={() => confirm(`Desconectar "${workspace.name}"? As issues e sessões deste workspace serão apagadas do Octo (nada é apagado da pasta).`) && api.deleteWorkspace(workspace.id)}
        >
          <Trash2 size={14} /> Desconectar workspace
        </button>
      </div>
    </section>
  );
}
