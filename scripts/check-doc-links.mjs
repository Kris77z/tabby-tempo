import { readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const guides = [
  'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'docs/tempo-upstream-sync-20261015.md',
  'docs/README.md', 'docs/ARCHITECTURE.md', 'docs/VERIFICATION.md', 'docs/ATTRIBUTION.md',
  'contracts/README.md', 'services/underwriter/README.md', 'services/provider-relay/README.md',
  'services/hosted-agents/README.md', 'services/arena/README.md',
  'packages/sdk/README.md', 'packages/pi-loop/README.md', 'packages/erc8004/README.md', 'frontend/README.md',
];
const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
if (git.status !== 0) throw new Error('Run the documentation check from a Git checkout.');
const published = new Set(git.stdout.split('\0').filter(Boolean));
const failures = [];
let links = 0;
const cache = new Map();

// Ignore code examples when resolving document links and heading fragments.
function prose(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker && !fence) { fence = marker[1]; return ''; }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    return line;
  }).join('\n');
}
function document(path) {
  if (cache.has(path)) return cache.get(path);
  const text = prose(readFileSync(path, 'utf8'));
  const anchors = new Set();
  const counts = new Map();
  for (const line of text.split('\n')) {
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const slug = heading[1].replace(/<[^>]+>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) || 0;
    counts.set(slug, count + 1);
    anchors.add(count ? `${slug}-${count}` : slug);
  }
  for (const match of text.matchAll(/<(?:a|[a-z][\w-]*)\b[^>]*\bid=["']([^"']+)["']/gi)) anchors.add(match[1]);
  const result = { text, anchors };
  cache.set(path, result);
  return result;
}
function check(source, raw) {
  if (/^(?:https?:|mailto:|tel:|ipfs:|\/\/)/i.test(raw)) return;
  links++;
  const label = `${relative(root, source)} -> ${raw}`;
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) { failures.push(`${label}: unsupported local scheme`); return; }
  let decoded;
  try { decoded = decodeURIComponent(raw.replace(/^<|>$/g, '')); }
  catch { failures.push(`${label}: invalid URL escaping`); return; }
  const hash = decoded.indexOf('#');
  const fragment = hash >= 0 ? decoded.slice(hash + 1) : '';
  const path = (hash >= 0 ? decoded.slice(0, hash) : decoded).split('?')[0];
  const target = path ? resolve(path.startsWith('/') ? root : dirname(source), path.replace(/^\//, '')) : source;
  const rel = relative(root, target).split(sep).join('/');
  if (rel.startsWith('../') || rel === '..') { failures.push(`${label}: outside repository`); return; }
  let info;
  try { info = statSync(target); }
  catch { failures.push(`${label}: missing file`); return; }
  const visible = info.isDirectory() ? [...published].some(file => file.startsWith(`${rel}/`)) : published.has(rel);
  if (!visible) { failures.push(`${label}: target is not part of the public checkout`); return; }
  if (fragment && /\.md$/i.test(target) && !document(target).anchors.has(fragment)) {
    failures.push(`${label}: missing heading or explicit anchor`);
  }
}

const inputs = process.argv.slice(2);
for (const file of inputs.length ? inputs : guides) {
  const source = resolve(root, file);
  let text;
  try { text = document(source).text; }
  catch { failures.push(`${file}: missing or unreadable document`); continue; }
  // These guides use inline Markdown links/images and quoted HTML asset paths.
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*["'])?\s*\)/g)) check(source, match[1]);
  for (const match of text.matchAll(/<(?:img|a)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)) check(source, match[1]);
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  console.error(`Documentation check failed: ${failures.length} issue(s).`);
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed: ${inputs.length || guides.length} guides, ${links} local links/assets. External URLs were not fetched.`);
}
