// Aviso de versão nova: consulta a última release publicada no GitHub, no máximo a cada 6 horas.
// É a única conexão que o Octo faz por conta própria, e dá para desligar em Preferências.
import type { UpdateInfo } from '../shared/types.ts';

export const RELEASES_REPO = 'KazuoMurakami/octo-desktop';
const INTERVAL = 6 * 3600_000;

let cache: { at: number; info: UpdateInfo | null } | null = null;

/** Compara versões x.y.z numericamente (ignora sufixos como -beta). */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(candidate), parse(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export async function checkUpdate(current: string): Promise<UpdateInfo | null> {
  if (cache && Date.now() - cache.at < INTERVAL) return cache.info;
  try {
    const response = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Octo/${current}` },
      signal: AbortSignal.timeout(5000),
    });
    // 404 = nenhuma release publicada ainda; guarda o resultado para não perguntar de novo à toa.
    if (!response.ok) {
      cache = { at: Date.now(), info: null };
      return null;
    }
    const release = (await response.json()) as { tag_name?: string; html_url?: string };
    const latest = String(release.tag_name ?? '').replace(/^v/, '');
    const info: UpdateInfo = {
      current,
      latest,
      url: release.html_url ?? `https://github.com/${RELEASES_REPO}/releases/latest`,
      available: Boolean(latest) && isNewer(latest, current),
    };
    cache = { at: Date.now(), info };
    return info;
  } catch {
    return null; // sem internet: tenta de novo na próxima vez
  }
}
