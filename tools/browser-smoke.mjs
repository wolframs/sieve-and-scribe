#!/usr/bin/env node
import { accessSync, constants, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const command = process.argv[2] ?? 'status';
const root = process.cwd();
const stateDir = resolve(root, '.browser-smoke');
const profileDir = resolve(stateDir, 'chrome-profile');
const logFile = resolve(stateDir, 'chrome-devtools.log');
const extensionDir = resolve(root, '.output/chrome-mv3');
const extensionIdFile = resolve(stateDir, 'extension-id');
const sessionId = process.env.CLLP_E2E_SESSION_ID ?? 'sieve-and-scribe-smoke';

function executable(path) {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function newestChildExecutable(parent, childPath) {
  try {
    return readdirSync(parent)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((entry) => resolve(parent, entry, childPath))
      .find(executable);
  } catch {
    return undefined;
  }
}

function findChrome() {
  const explicit = process.env.CLLP_E2E_CHROME_PATH;
  if (explicit) {
    if (!executable(explicit)) throw new Error(`CLLP_E2E_CHROME_PATH is not executable: ${explicit}`);
    return explicit;
  }
  const home = homedir();
  const candidates = [
    newestChildExecutable(resolve(home, '.cache/puppeteer-cft/chrome'), 'chrome-linux64/chrome'),
    newestChildExecutable(resolve(home, '.cache/ms-playwright'), 'chrome-linux64/chrome'),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];
  const found = candidates.find(executable);
  if (!found) {
    throw new Error('No Chrome executable found. Set CLLP_E2E_CHROME_PATH to an absolute path.');
  }
  return found;
}

function run(args, capture = false) {
  const result = spawnSync('chrome-devtools', ['--sessionId', sessionId, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  return capture ? result.stdout : '';
}

function start() {
  mkdirSync(stateDir, { recursive: true });
  run([
    'start',
    '--executablePath', findChrome(),
    '--userDataDir', profileDir,
    '--headless=false',
    '--categoryExtensions=true',
    // The standalone CLI cannot negotiate MCP workspace roots. This dedicated local
    // daemon needs filesystem access only so install_extension can read the build.
    '--allowUnrestrictedPaths=true',
    '--usageStatistics=false',
    '--logFile', logFile,
  ]);
}

function install() {
  if (!existsSync(resolve(extensionDir, 'background.js'))) {
    throw new Error('Chrome build missing. Run pnpm build before installing the smoke extension.');
  }
  run(['install_extension', extensionDir]);
  const extensions = run(['list_extensions'], true);
  const block = extensions
    .split(/\n(?=##?\s|Name:)/)
    .find((item) => item.includes('Sieve & Scribe')) ?? extensions;
  const id = block.match(/(?:ID|Id|id):\s*`?([a-p]{32})`?/i)?.[1]
    ?? block.match(/\b([a-p]{32})\b/)?.[1];
  if (!id) {
    process.stdout.write(extensions);
    throw new Error('Extension installed, but its ID could not be identified.');
  }
  writeFileSync(extensionIdFile, `${id}\n`, { mode: 0o600 });
  console.log(`Project smoke extension ID: ${id}`);
}

switch (command) {
  case 'setup':
    start();
    install();
    run(['status']);
    break;
  case 'start':
    start();
    run(['status']);
    break;
  case 'install':
    install();
    break;
  case 'status':
    run(['status']);
    break;
  case 'stop':
    run(['stop']);
    break;
  default:
    console.error('Usage: node tools/browser-smoke.mjs setup|start|install|status|stop');
    process.exit(2);
}
