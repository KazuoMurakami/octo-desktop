import type { Response } from 'express';
import type { ServerEvent } from '../shared/types.ts';

const clients = new Set<Response>();

export function subscribe(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcast(event: ServerEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(payload);
}

setInterval(() => {
  for (const client of clients) client.write(': ping\n\n');
}, 25_000).unref();
