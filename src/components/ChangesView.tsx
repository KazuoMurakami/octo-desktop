import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, FileWarning, GitBranch, RefreshCw } from 'lucide-react';
import type { FileChange, FileChangeStatus, RepoChanges } from '../../shared/types.ts';
import { hue } from '../util.ts';
import { OpenMenu, openInEditor, type OpenTarget } from './OpenMenu.tsx';

const STATUS: Record<FileChangeStatus, { letter: string; label: string }> = {
  modified: { letter: 'M', label: 'modificado' },
  added: { letter: 'A', label: 'adicionado' },
  deleted: { letter: 'D', label: 'removido' },
  renamed: { letter: 'R', label: 'renomeado' },
  untracked: { letter: 'N', label: 'novo, fora do git' },
  conflict: { letter: 'U', label: 'em conflito' },
};

/** Diff unificado com cores; os cabeçalhos do git (diff --git, index…) ficam de fora. */
function DiffBlock({ patch }: { patch: string }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => {
    const body = patch.split('\n');
    const start = body.findIndex((line) => line.startsWith('@@'));
    return start === -1 ? [] : body.slice(start);
  }, [patch]);
  const visible = all ? lines : lines.slice(0, 600);
  return (
    <div className="diff">
      {visible.map((line, index) => {
        const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('\\') ? 'meta' : 'ctx';
        return <div key={index} className={`diff-line is-${kind}`}>{line || ' '}</div>;
      })}
      {lines.length > visible.length && (
        <button className="diff-more" onClick={() => setAll(true)}>Mostrar mais {lines.length - visible.length} linhas</button>
      )}
    </div>
  );
}

function FileRow({ file, open, onToggle }: { file: FileChange; open: boolean; onToggle: () => void }) {
  const slash = file.path.lastIndexOf('/');
  const status = STATUS[file.status];
  const expandable = Boolean(file.patch);
  return (
    <div className={`change-file${open ? ' is-open' : ''}`}>
      <button className="change-row" onClick={onToggle} disabled={!expandable} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        <ChevronRight size={13} className="change-chevron" />
        <span className={`change-status is-${file.status}`} title={status.label}>{status.letter}</span>
        <span className="change-path">
          {slash > -1 && <span className="dim">{file.path.slice(0, slash + 1)}</span>}
          {file.path.slice(slash + 1)}
        </span>
        <span className="change-counts">
          {file.binary ? <span className="dim">binário</span> : (
            <>
              {file.additions > 0 && <em className="is-add">+{file.additions}</em>}
              {file.deletions > 0 && <em className="is-del">−{file.deletions}</em>}
            </>
          )}
        </span>
      </button>
      {open && expandable && <DiffBlock patch={file.patch} />}
      {open && !expandable && !file.binary && <div className="change-note">Grande demais para mostrar aqui. Abra no editor para ver o diff.</div>}
    </div>
  );
}

/**
 * O que mudou desde o último commit em cada repositório (o mesmo que `git diff HEAD`),
 * incluindo arquivos novos. Só leitura.
 */
export function ChangesView({ fetcher, target, emptyText }: { fetcher: () => Promise<RepoChanges[]>; target: OpenTarget; emptyText: string }) {
  const [repos, setRepos] = useState<RepoChanges[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRepos(await fetcher());
    } catch {
      setRepos((current) => current ?? []);
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const changed = (repos ?? []).filter((r) => r.files.length || r.error);
  const files = changed.reduce((n, r) => n + r.files.length, 0);
  const additions = changed.reduce((n, r) => n + r.files.reduce((m, f) => m + f.additions, 0), 0);
  const deletions = changed.reduce((n, r) => n + r.files.reduce((m, f) => m + f.deletions, 0), 0);
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="changes">
      <div className="changes-head">
        <span className="changes-summary">
          {repos === null ? 'Lendo os repositórios…' : files ? (
            <>
              <strong>{files} {files === 1 ? 'arquivo' : 'arquivos'}</strong> em {changed.length} {changed.length === 1 ? 'repositório' : 'repositórios'}
              {additions > 0 && <em className="is-add"> +{additions}</em>}
              {deletions > 0 && <em className="is-del"> −{deletions}</em>}
            </>
          ) : 'Sem mudanças'}
        </span>
        <button className="icon-btn" onClick={() => void refresh()} disabled={loading} title="Atualizar">
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
        </button>
        <OpenMenu target={target} />
      </div>

      {repos !== null && !changed.length && <div className="changes-empty">{emptyText}</div>}

      {changed.map((repo) => (
        <section key={repo.repoId} className="changes-repo">
          <header className="changes-repo-head">
            <i style={{ background: hue(repo.name) }} />
            <strong>{repo.name}</strong>
            {repo.branch && <span className="dim mono with-icon"><GitBranch size={12} /> {repo.branch}</span>}
            <button className="link-btn" onClick={() => void openInEditor({ kind: 'folder', workspaceId: target.workspaceId, dir: repo.absPath })}>abrir no editor</button>
          </header>
          {repo.error && <div className="change-note is-error"><FileWarning size={13} /> {repo.error}</div>}
          {repo.files.map((file) => {
            const key = `${repo.repoId}:${file.path}`;
            return <FileRow key={key} file={file} open={open.has(key)} onToggle={() => toggle(key)} />;
          })}
          {repo.truncated && <div className="change-note">O diff é grande: alguns arquivos aparecem sem o conteúdo. Abra no editor para ver tudo.</div>}
        </section>
      ))}
    </div>
  );
}
