// The shared secret every client sends as `x-bridge-token`. It lives in
// ~/.agy-acp/token, one per user, so every copy of this code (the Claude
// plugin in every session, the CLI) reaches the same bridge. Whoever needs it
// first creates it. `node token.mjs` prints it.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_DIR = join(homedir(), '.agy-acp');
export const TOKEN_FILE = join(STATE_DIR, 'token');

export function readToken() {
  try {
    const t = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {}
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    // 'wx' fails if another process created it meanwhile; then read theirs.
    writeFileSync(TOKEN_FILE, randomBytes(24).toString('hex'), { flag: 'wx' });
  } catch {}
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(readToken());
}
