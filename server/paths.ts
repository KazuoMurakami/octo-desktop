import { homedir } from 'node:os';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.OCTO_DATA_DIR ?? path.join(homedir(), '.octo'));
export const DB_FILE = path.join(DATA_DIR, 'db.json');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
/** Imagens enviadas nas conversas, numa pasta por sessão (ver images.ts). */
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
/** Worktrees das issues, numa pasta por workspace e uma por issue (ver worktrees.ts). */
export const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees');
/** Quem está servindo esta pasta de dados agora (pid e endereço). */
export const LOCK_FILE = path.join(DATA_DIR, 'server.json');
/** Segredo que a interface apresenta para usar a API (só o dono da pasta consegue ler). */
export const TOKEN_FILE = path.join(DATA_DIR, 'token');
