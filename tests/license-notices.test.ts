import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Standalone Node licensing CLI shared with release packaging.
import { collectNotices, generateNotices } from '../scripts/generate-third-party-notices.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureParent = path.join(sourceRoot, 'artifacts');
const fixtures: string[] = [];
const read = (root: string, relative: string) => readFileSync(path.join(root, relative), 'utf8');

function copy(root: string, relative: string, destination = relative) {
  const target = path.join(root, destination);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(sourceRoot, relative), target);
}

function fixture(packaged = false) {
  mkdirSync(fixtureParent, { recursive: true });
  const root = mkdtempSync(path.join(fixtureParent, 'license-test-'));
  fixtures.push(root);
  const review = JSON.parse(read(sourceRoot, 'vendor/licenses/reviewed-components.json'));
  const lock = JSON.parse(read(sourceRoot, 'package-lock.json'));
  const names = new Set(['lucide-react', 'abstract-logging', 'reflect-metadata']);
  review.packages = review.packages.filter((entry: { name: string }) => names.has(entry.name));
  review.buildHelpers = review.buildHelpers.filter((entry: { name: string }) => entry.name === 'vite');
  const includedPaths = new Set([...review.packages, ...review.buildHelpers].map((entry) => entry.path));
  lock.packages = Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key === '' || includedPaths.has(key)));
  cpSync(path.join(sourceRoot, 'vendor/licenses'), path.join(root, 'vendor/licenses'), { recursive: true });
  writeFileSync(path.join(root, 'vendor/licenses/reviewed-components.json'), JSON.stringify(review));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  for (const entry of [...review.packages, ...(packaged ? [] : review.buildHelpers)]) {
    copy(root, `${entry.path}/package.json`);
    for (const file of entry.files) copy(root, `${entry.path}/${file.path}`);
    if (entry.supplement?.reference) copy(root, `${entry.path}/${entry.supplement.reference.path}`);
  }
  if (packaged) {
    copy(root, review.font.path, 'dist/web/assets/IBMPlexSans-test.ttf');
    copy(root, review.font.licensePath, 'dist/web/licenses/ibm-plex-sans-OFL.txt');
    mkdirSync(path.join(root, 'runtime'), { recursive: true });
    try { linkSync(process.execPath, path.join(root, 'runtime/node.exe')); }
    catch { copyFileSync(process.execPath, path.join(root, 'runtime/node.exe')); }
  } else {
    copy(root, review.font.path);
    copy(root, review.font.licensePath);
  }
  return root;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(fixtureParent) || !path.basename(absolute).startsWith('license-test-')) {
      throw new Error('Refusing to remove an unexpected license-test directory.');
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe('Release license notices', () => {
  it('preserves complete installed runtime notices including Lucide MIT portions and separate copyright notices', () => {
    const result = collectNotices(sourceRoot);
    expect(result.manifest.runtimePackages).toHaveLength(99);
    expect(result.manifest.buildHelperNotices).toHaveLength(4);
    expect(result.notices).toContain(read(sourceRoot, 'node_modules/lucide-react/LICENSE').replace(/\r\n?/g, '\n').trimEnd());
    expect(result.notices).toContain(read(sourceRoot, 'node_modules/reflect-metadata/CopyrightNotice.txt').replace(/\r\n?/g, '\n').trimEnd());
    expect(result.notices).toContain('James Sumners');
    expect(result.notices).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(result.manifest.node).toBeUndefined();
  });

  it('writes deterministic web notices with text hashes tolerant of Git line-ending conversion', () => {
    const root = fixture();
    const filename = 'node_modules/lucide-react/LICENSE';
    writeFileSync(path.join(root, filename), read(root, filename).replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'));
    const first = generateNotices(root);
    const file = 'web/public/licenses/generated/THIRD-PARTY-NOTICES.txt';
    const text = read(root, file);
    expect(generateNotices(root)).toEqual(first);
    expect(read(root, file)).toBe(text);
    expect(text).toContain('for portions derived from Feather');
    expect(text).not.toContain('\r');
  });

  it('stops before writing output if installed license text or the file inventory changes', () => {
    const root = fixture();
    const filename = path.join(root, 'node_modules/lucide-react/LICENSE');
    const original = readFileSync(filename, 'utf8');
    writeFileSync(filename, original.replace('Cole Bemis', 'Removed notice'));
    expect(() => generateNotices(root)).toThrow('License text changed');
    expect(existsSync(path.join(root, 'web/public/licenses/generated'))).toBe(false);
    writeFileSync(filename, original);
    writeFileSync(path.join(root, 'node_modules/lucide-react/NOTICE.txt'), 'New attribution that needs review.');
    expect(() => generateNotices(root)).toThrow('License files changed');
  });

  it('rejects unreviewed runtime dependencies, changed package metadata, and missing packages', () => {
    const root = fixture();
    const lock = JSON.parse(read(root, 'package-lock.json'));
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ ...lock,
      packages: { ...lock.packages, 'node_modules/unreviewed': { version: '1.0.0', license: 'MIT' } } }));
    expect(() => collectNotices(root)).toThrow('Runtime dependency list changed');
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    const filename = path.join(root, 'node_modules/lucide-react/package.json');
    const pkg = JSON.parse(readFileSync(filename, 'utf8'));
    writeFileSync(filename, JSON.stringify({ ...pkg, license: 'MIT' }));
    expect(() => collectNotices(root)).toThrow('Installed package differs');
    rmSync(filename);
    expect(() => collectNotices(root)).toThrow('Runtime package is missing');
  });

  it('does not silently substitute a license if its upstream supplement or bundled font changes', () => {
    const root = fixture();
    const review = JSON.parse(read(root, 'vendor/licenses/reviewed-components.json'));
    const supplement = review.packages.find((entry: { name: string }) => entry.name === 'abstract-logging').supplement;
    const filename = path.join(root, supplement.path);
    const original = readFileSync(filename);
    writeFileSync(filename, 'MIT');
    expect(() => generateNotices(root)).toThrow('License text changed');
    writeFileSync(filename, original);
    writeFileSync(path.join(root, review.font.path), 'Different font');
    expect(() => generateNotices(root)).toThrow('Bundled font changed');
  });

  it('packages the exact Node license and complete notices without requiring installed development tools', () => {
    const root = fixture(true);
    const manifest = generateNotices(root, { mode: 'package' });
    expect(manifest.node.version).toBe(process.version);
    const review = JSON.parse(read(root, 'vendor/licenses/reviewed-components.json'));
    const node = review.node.find((entry: { version: string }) => entry.version === process.version);
    const expected = read(root, node.path).replace(/\r\n?/g, '\n');
    expect(read(root, 'runtime/LICENSE')).toBe(expected);
    expect(read(root, 'THIRD-PARTY-NOTICES.txt')).toContain(expected.trimEnd());
    expect(read(root, 'THIRD-PARTY-NOTICES.txt')).toContain('Licenses of bundled dependencies');
    expect(existsSync(path.join(root, 'node_modules/vite'))).toBe(false);
    expect(JSON.parse(read(root, 'THIRD-PARTY-MANIFEST.json')).node.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unreviewed Node version before creating distribution notices', () => {
    const root = fixture(true);
    const filename = path.join(root, 'vendor/licenses/reviewed-components.json');
    const review = JSON.parse(readFileSync(filename, 'utf8'));
    review.node = [];
    writeFileSync(filename, JSON.stringify(review));
    expect(() => generateNotices(root, { mode: 'package' })).toThrow('no reviewed complete upstream LICENSE');
    expect(existsSync(path.join(root, 'runtime/LICENSE'))).toBe(false);
    expect(existsSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'))).toBe(false);
  });
});
