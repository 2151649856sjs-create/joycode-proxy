#!/usr/bin/env node
/**
 * setup.mjs — bootstrap JoyCode credentials from THIS machine's IDE login state.
 *
 * JoyCode stores its login ticket inside its VSCode-style SQLite state database
 * (state.vscdb). This helper reads it and writes the needed environment
 * variables into .env so that `node server.mjs` can run without manual copy.
 *
 * It never connects to JoyCode, never uploads anything, and never falls back to
 * a shared/remote credential — the values come from YOUR local IDE only.
 *
 * If it can't find the login state (IDE not installed / different OS), it prints
 * manual instructions and exits 0.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '.env');

function fail(msg) {
  console.error('[setup] ' + msg);
  console.error('[setup] 无法自动读取，请手动：复制 .env.example 为 .env，');
  console.error('[setup] 打开 JoyCode IDE 登录后，从 state.vscdb 的 JoyCoder.IDE');
  console.error('[setup] 里 jdhLoginInfo/joyCoderUser 抠出 ptKey / tenant 填进去。');
  process.exit(0);
}

async function readLogin() {
  // JoyCode stores the db at the VSCode globalStorage location.
  const candidates = [];
  const appData = process.env.APPDATA;
  if (appData) candidates.push(join(appData, 'JoyCode', 'User', 'globalStorage', 'state.vscdb'));
  candidates.push(
    join(homedir(), 'Library', 'Application Support', 'JoyCode', 'User', 'globalStorage', 'state.vscdb'),
    join(homedir(), '.config', 'JoyCode', 'User', 'globalStorage', 'state.vscdb')
  );
  const dbPath = candidates.find((p) => existsSync(p));
  if (!dbPath) fail('未找到 JoyCode 登录数据库（先装并登录 JoyCode IDE）。');

  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readonly: true });
  } catch (e) {
    fail('node:sqlite 不可用（需要 Node 22+）。' + e.message);
  }

  const row = db.prepare("SELECT value FROM ItemTable WHERE key='JoyCoder.IDE'").get();
  if (!row) fail('state.vscdb 中没有 JoyCoder.IDE 这一行。');
  const doc = JSON.parse(row.value);
  const u = doc.joyCoderUser || doc.jdhLoginInfo || {};
  const ptKey = u.ptKey || u.pt_key;
  if (!ptKey) fail('登录态里没有 ptKey（先在 JoyCode IDE 完成登录）。');
  return {
    JOYCODE_PT_KEY: ptKey,
    JOYCODE_TENANT: u.tenant || '',
    JOYCODE_COLOR_BASE_URL: u.colorBaseUrl || '',
    JOYCODE_MASTER_BASE_URL: u.masterBaseUrl || u.base_url || '',
    JOYCODE_LOGIN_TYPE: u.loginType || 'PIN_JD_CLOUD',
  };
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const creds = await readLogin();
  // Merge into existing .env so we don't clobber other settings.
  let existing = {};
  if (existsSync(envPath)) {
    try { existing = parseEnv(readFileSync(envPath, 'utf8')); } catch {}
  }
  const merged = { ...existing, ...creds };
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
  writeFileSync(envPath, body, 'utf8');
  console.log('[setup] 已从本机 JoyCode 登录态写入 .env：');
  console.log('[setup]   JOYCODE_PT_KEY = ' + (creds.JOYCODE_PT_KEY ? creds.JOYCODE_PT_KEY.slice(0, 12) + '…' : '(empty)'));
  console.log('[setup]   JOYCODE_TENANT = ' + creds.JOYCODE_TENANT);
  console.log('[setup]   JOYCODE_COLOR_BASE_URL = ' + creds.JOYCODE_COLOR_BASE_URL);
  console.log('[setup] 现在可以运行：  node server.mjs');
}

main();
