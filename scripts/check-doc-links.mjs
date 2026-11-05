import { existsSync, readFileSync } from 'node:fs';
import { dirname, normalize, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  throw new Error('Usage: check-doc-links.mjs <base-sha> <head-sha>');
}

const changedMarkdown = execFileSync('git', ['diff', '--name-only', base, head], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file.endsWith('.md'));

const markdownLink = /!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;
const ignoredSchemes = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;
const missing = [];

for (const file of changedMarkdown) {
  const content = readFileSync(file, 'utf8');
  for (const match of content.matchAll(markdownLink)) {
    const target = match[1];
    if (!target || ignoredSchemes.test(target)) continue;

    const path = target.split('#', 1)[0];
    if (!path) continue;
    const resolved = normalize(resolve(dirname(file), path));
    if (!existsSync(resolved)) missing.push(`${file}: ${target}`);
  }
}

if (missing.length > 0) {
  throw new Error(`Broken local Markdown links:\n${missing.join('\n')}`);
}
