#!/usr/bin/env node
/**
 * install-dsh-plugin.mjs — wire the dsh-plugin/ folder into a DSH profile.
 *
 * Does two things, both idempotent:
 *   1. junction/symlink <repo>/dsh-plugin  ->  <DSH_HOME>/profiles/<profile>/node_modules/<name>
 *   2. append the `- insert:` block to <DSH_HOME>/profiles/<profile>/cordis.patch.yml
 *
 * After running this, restart DSH web (the model-provider graph is a boot snapshot)
 * and the provider appears in the model picker.
 */
import { readFileSync, writeFileSync, existsSync, symlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, 'dsh-plugin');
const pluginPkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const pluginName = pluginPkg.name;

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profile = process.env.DSH_PROFILE || 'web';
const nodeModules = join(dshHome, 'profiles', profile, 'node_modules');
const target = join(nodeModules, pluginName);
const patchFile = join(dshHome, 'profiles', profile, 'cordis.patch.yml');

const isWindows = process.platform === 'win32';

function ensureJunction() {
  if (existsSync(target)) {
    try {
      const real = statSync(target).isDirectory() ? target : null;
      // If it already points at our plugin dir, skip.
      const link = readFileSync; // noop to keep linter calm
    } catch {}
    const realPath = existsSync(target) ? realResolve(target) : null;
    if (realPath === pluginDir) {
      console.log('[install] junction 已存在 -> ' + target);
      return;
    }
    console.error('[install] 目标已存在但不是本插件的链接：' + target);
    console.error('[install] 请手动移除后再试，或改用 dsh plugin add 该目录。');
    process.exit(1);
  }
  try {
    if (!existsSync(nodeModules)) {
      console.error('[install] 找不到 node_modules 目录：' + nodeModules);
      console.error('[install] 确认 DSH_HOME=' + dshHome + ' 且该 profile 已初始化。');
      process.exit(1);
    }
    symlinkSync(pluginDir, target, isWindows ? 'junction' : 'dir');
    console.log('[install] 已创建链接 ' + target + ' -> ' + pluginDir);
  } catch (e) {
    console.error('[install] 无法创建链接：' + e.message);
    console.error('[install] 可改用：dsh --profile ' + profile + ' plugin add ' + pluginDir);
    process.exit(1);
  }
}

function realResolve(p) {
  try {
    const { realpathSync } = require('node:fs');
    return realpathSync(p);
  } catch {
    return p;
  }
}

function ensurePatch() {
  const block =
    `- insert:\n` +
    `    - id: ${pluginName.replace('dsh-llm-', 'llm-')}\n` +
    `      name: ${pluginName}\n`;
  let content = '';
  if (existsSync(patchFile)) content = readFileSync(patchFile, 'utf8');
  if (content.includes('name: ' + pluginName)) {
    console.log('[install] cordis.patch.yml 已有 ' + pluginName + ' 条目，跳过。');
    return;
  }
  if (content.length && !content.endsWith('\n')) content += '\n';
  content += '\n' + block;
  writeFileSync(patchFile, content, { encoding: 'utf8' });
  console.log('[install] 已向 ' + patchFile + ' 追加 ' + pluginName + ' 条目。');
}

ensureJunction();
ensurePatch();
console.log('');
console.log('[install] 完成。请重启 DSH web 让 provider 进入模型选择器：');
console.log('[install]   dsh --profile ' + profile + ' web --host 127.0.0.1 --port 3080 --no-open');
console.log('[install] （或重启你启动 DSH 的方式）');
