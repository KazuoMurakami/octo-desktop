import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { AgentSession, ClaudeAccount, HistoryKind, Issue, Repo, Workspace } from '../shared/types.ts';
import { broadcast } from './events.ts';
import { db, save } from './store.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Garante que a pasta existe antes de abrir algo nela (ela pode ter sido movida ou apagada). */
export function requireFolder(dir: string, message = `A pasta ${dir} não existe mais. Ela pode ter sido movida, renomeada ou apagada.`): void {
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
  } catch {
    /* não existe */
  }
  if (!ok) throw new HttpError(400, message);
}

export function now(): string {
  return new Date().toISOString();
}

export function getWorkspace(id: string): Workspace {
  const workspace = db.workspaces.find((w) => w.id === id);
  if (!workspace) throw new HttpError(404, 'Workspace não encontrado.');
  return workspace;
}

export function getIssue(id: string): Issue {
  const issue = db.issues.find((i) => i.id === id);
  if (!issue) throw new HttpError(404, 'Issue não encontrada.');
  return issue;
}

export function getSession(id: string): AgentSession {
  const session = db.sessions.find((s) => s.id === id);
  if (!session) throw new HttpError(404, 'Sessão não encontrada.');
  return session;
}

export function getAccount(id: string | null | undefined): ClaudeAccount {
  const account = db.accounts.find((a) => a.id === id);
  if (!account) throw new HttpError(400, 'Escolha uma conta do Claude válida.');
  return account;
}

export function workspaceRepos(workspaceId: string): Repo[] {
  return db.repos.filter((r) => r.workspaceId === workspaceId);
}

export function addHistory(issue: Issue, kind: HistoryKind, actor: string, text: string): void {
  issue.history.push({ id: randomUUID(), ts: now(), kind, actor, text });
}

export function commitIssue(issue: Issue): void {
  issue.updatedAt = now();
  save();
  broadcast({ type: 'issue', issue });
}

export function commitSession(session: AgentSession): void {
  session.updatedAt = now();
  save();
  broadcast({ type: 'session', session });
}
