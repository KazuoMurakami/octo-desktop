import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
      {/* Sem o diff (grande demais), a linha ainda abre para dizer por quê; só a de um binário não tem o que mostrar. */}
      <button className="change-row" onClick={onToggle} disabled={!expandable && file.binary} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        <ChevronRight size={13} className="change-chevron" />
        <span className={`change-status is-${file.status}`} title={status.label}>{status.letter}</span>
        <span className="change-path">
          {slash > -1 && <span className="dim">{file.path.slice(0, slash + 1)}</span>}
          {file.path.slice(slash + 1)}
        </span>
        {file.preexisting && (
          <span
            className="change-badge"
            title="Já tinha alterações sem commit quando a sessão começou e não mudou desde então: provavelmente não foi o agente."
          >
            já estava alterado
          </span>
        )}
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
 * incluindo arquivos novos. Só leitura. Na aba da sessão, os arquivos que já estavam alterados
 * quando ela começou ficam separados no fim de cada repositório.
 */
export function ChangesView({ fetcher, target, emptyText, note }: {
  fetcher: () => Promise<RepoChanges[]>;
  target: OpenTarget;
  emptyText: string;
  /** Explicação fixa abaixo do resumo (ex.: o que a aba da sessão inclui). */
  note?: ReactNode;
}) {
  const [repos, setRepos] = useState<RepoChanges[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRepos(await fetcher());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const changed = (repos ?? []).filter((r) => r.files.length || r.omittedFiles || r.error);
  const files = changed.reduce((n, r) => n + r.files.length, 0);
  const preexisting = changed.reduce((n, r) => n + r.files.filter((f) => f.preexisting).length, 0);
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
          {repos === null ? (error ? 'Não foi possível ler as mudanças.' : 'Lendo os repositórios…') : files ? (
            <>
              <strong>{files} {files === 1 ? 'arquivo' : 'arquivos'}</strong> em {changed.length} {changed.length === 1 ? 'repositório' : 'repositórios'}
              {additions > 0 && <em className="is-add"> +{additions}</em>}
              {deletions > 0 && <em className="is-del"> −{deletions}</em>}
              {preexisting > 0 && (
                <span className="dim">
                  {' · '}
                  {preexisting === files
                    ? files === 1 ? 'já estava alterado antes da sessão' : 'todos já estavam alterados antes da sessão'
                    : `${preexisting} já ${preexisting === 1 ? 'estava alterado' : 'estavam alterados'} antes da sessão`}
                </span>
              )}
            </>
          ) : 'Sem mudanças'}
        </span>
        <button className="icon-btn" onClick={() => void refresh()} disabled={loading} title="Atualizar" aria-label="Atualizar">
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
        </button>
        <OpenMenu target={target} />
      </div>
      {note && <p className="changes-note">{note}</p>}

      {error && (
        <div className="inline-error">
          {repos === null ? 'Não foi possível ler as mudanças' : 'Não foi possível atualizar'}: {error}{' '}
          <button className="link-btn" onClick={() => void refresh()} disabled={loading}>Tentar de novo</button>
        </div>
      )}

      {repos !== null && !changed.length && <div className="changes-empty">{emptyText}</div>}

      {changed.map((repo) => {
        // Primeiro o que mudou durante a sessão; depois o que já estava alterado quando ela começou.
        const fresh = repo.files.filter((f) => !f.preexisting);
        const before = repo.files.filter((f) => f.preexisting);
        const row = (file: FileChange) => {
          const key = `${repo.repoId}:${file.path}`;
          return <FileRow key={key} file={file} open={open.has(key)} onToggle={() => toggle(key)} />;
        };
        return (
          <section key={repo.repoId} className="changes-repo">
            <header className="changes-repo-head">
              <i style={{ background: hue(repo.name) }} />
              <strong>{repo.name}</strong>
              {repo.branch && <span className="dim mono with-icon"><GitBranch size={12} /> {repo.branch}</span>}
              <button className="link-btn" onClick={() => void openInEditor({ kind: 'folder', workspaceId: target.workspaceId, dir: repo.absPath })}>abrir no editor</button>
            </header>
            {repo.error && <div className="change-note is-error"><FileWarning size={13} /> {repo.error}</div>}
            {fresh.map(row)}
            {before.length > 0 && (
              <div className="change-group-head">
                Já {before.length === 1 ? 'estava alterado' : 'estavam alterados'} antes da sessão começar
              </div>
            )}
            {before.map(row)}
            {Boolean(repo.omittedFiles) && (
              <div className="change-note">
                Mais {repo.omittedFiles} {repo.omittedFiles === 1 ? 'arquivo alterado ficou' : 'arquivos alterados ficaram'} fora da lista, por serem muitos
                (dependências fora do .gitignore, por exemplo). Abra no editor para ver tudo.
              </div>
            )}
            {repo.truncated && <div className="change-note">O diff é grande: alguns arquivos aparecem sem o conteúdo. Abra no editor para ver tudo.</div>}
          </section>
        );
      })}
    </div>
  );
}
