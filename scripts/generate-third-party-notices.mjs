import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noticeName = /licen[sc]e|copying|copyright|notice/i;
const codeExtension = /\.(?:[cm]?js|map|node|wasm)$/i;
const normalize = (text) => text.replace(/\r\n?/g, '\n');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const textHash = (text) => sha256(Buffer.from(normalize(text), 'utf8'));

function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error(`Invalid relative license path: ${relative}`);
  }
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`License path leaves its directory: ${relative}`);
  }
  return target;
}

function licenseText(filename, expectedHash) {
  const bytes = readFileSync(filename);
  const text = bytes.toString('utf8');
  if (!text.trim() || text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`Invalid UTF-8 license text: ${filename}`);
  }
  if (textHash(text) !== expectedHash) {
    throw new Error(`License text changed; review required: ${filename}`);
  }
  return normalize(text);
}

function noticeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && noticeName.test(entry.name) && !codeExtension.test(entry.name))
    .map((entry) => entry.name).sort();
}

function compareNames(actual, expected, message) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error(message);
}

function packageNotices(root, lock, reviewed, { allowBuildSnapshot = false } = {}) {
  const metadata = lock.packages[reviewed.path];
  if (!metadata || metadata.version !== reviewed.version || metadata.license !== reviewed.declaredLicense) {
    throw new Error(`Unreviewed package version or license: ${reviewed.path}`);
  }
  const directory = inside(root, reviewed.path);
  const installed = existsSync(path.join(directory, 'package.json'));
  if (!installed && !allowBuildSnapshot) throw new Error(`Runtime package is missing: ${reviewed.path}`);
  if (installed) {
    const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (pkg.name !== reviewed.name || pkg.version !== reviewed.version || pkg.license !== reviewed.declaredLicense) {
      throw new Error(`Installed package differs from reviewed lockfile: ${reviewed.path}`);
    }
    compareNames(noticeFiles(directory), reviewed.files.map((file) => file.path),
      `License files changed; review required: ${reviewed.path}`);
  }
  const documents = reviewed.files.map((file) => {
    const text = installed
      ? licenseText(inside(directory, file.path), file.sha256)
      : licenseText(inside(root, file.snapshotPath), file.sha256);
    if (file.snapshotPath) licenseText(inside(root, file.snapshotPath), file.sha256);
    return { path: `${reviewed.path}/${file.path}`, sha256: file.sha256, text };
  });
  if (reviewed.supplement) {
    const supplement = reviewed.supplement;
    if (supplement.reference) {
      licenseText(inside(directory, supplement.reference.path), supplement.reference.sha256);
    }
    documents.push({
      path: supplement.path, source: supplement.source, retrievedAt: supplement.retrievedAt,
      sha256: supplement.sha256, text: licenseText(inside(root, supplement.path), supplement.sha256),
    });
  }
  if (!documents.length) throw new Error(`No reviewed license text: ${reviewed.path}`);
  return {
    name: reviewed.name, version: reviewed.version, path: reviewed.path,
    declaredLicense: reviewed.declaredLicense, integrity: metadata.integrity,
    reviewNote: reviewed.reviewNote, documents,
  };
}

function fontNotices(root, reviewed, mode) {
  let fontPath = reviewed.path;
  let licensePath = reviewed.licensePath;
  if (mode === 'package') {
    const assets = inside(root, 'dist/web/assets');
    const fonts = readdirSync(assets).filter((name) => /^IBMPlexSans-[\w-]+\.ttf$/.test(name));
    if (fonts.length !== 1) throw new Error('Expected exactly one bundled IBM Plex Sans font.');
    fontPath = `dist/web/assets/${fonts[0]}`;
    licensePath = 'dist/web/licenses/ibm-plex-sans-OFL.txt';
  }
  if (sha256(readFileSync(inside(root, fontPath))) !== reviewed.sha256) {
    throw new Error('Bundled font changed; version and license review required.');
  }
  return {
    name: reviewed.name, declaredLicense: reviewed.declaredLicense,
    path: fontPath, sha256: reviewed.sha256, source: reviewed.source, reviewNote: reviewed.reviewNote,
    documents: [{ path: licensePath, sha256: reviewed.licenseSha256,
      text: licenseText(inside(root, licensePath), reviewed.licenseSha256) }],
  };
}

function nodeNotices(root, reviews) {
  const binary = inside(root, 'runtime/node.exe');
  if (!existsSync(binary)) throw new Error('The packaged runtime/node.exe is missing.');
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  const reviewed = reviews.find((entry) => entry.version === version);
  if (!/^v\d+\.\d+\.\d+$/.test(version) || !reviewed) {
    throw new Error(`Node ${version} has no reviewed complete upstream LICENSE; add an exact-version review first.`);
  }
  const text = licenseText(inside(root, reviewed.path), reviewed.sha256);
  return {
    name: 'Node.js', version, path: 'runtime/node.exe', sha256: sha256(readFileSync(binary)),
    source: reviewed.source,
    documents: [{ path: 'runtime/LICENSE', sha256: reviewed.sha256, source: reviewed.source, text }],
  };
}

function renderDocuments(components) {
  return components.map((component) => {
    const header = [`Component: ${component.name}${component.version ? ` ${component.version}` : ''}`,
      `Package/file: ${component.path}`,
      ...(component.declaredLicense ? [`Declared package license: ${component.declaredLicense}`] : []),
      ...(component.reviewNote ? [`Review note: ${component.reviewNote}`] : [])].join('\n');
    return `${'='.repeat(78)}\n${header}\n\n${component.documents.map((doc) =>
      `--- ${doc.path}${doc.source ? `\nUpstream: ${doc.source}` : ''} ---\n${doc.text.trimEnd()}\n`).join('\n')}`;
  }).join('\n');
}

const withoutText = (component) => ({
  ...component, documents: component.documents.map(({ text: _text, ...document }) => document),
});

/** Read and verify every input before generating any output. No network requests. */
export function collectNotices(root = scriptRoot, { mode = 'web' } = {}) {
  if (!['web', 'package'].includes(mode)) throw new Error(`Unknown notice mode: ${mode}`);
  root = path.resolve(root);
  const lockBytes = readFileSync(inside(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const review = JSON.parse(readFileSync(inside(root, 'vendor/licenses/reviewed-components.json'), 'utf8'));
  if (lock.lockfileVersion !== 3 || review.schemaVersion !== 1) throw new Error('Unsupported license/lockfile format.');
  const runtimePaths = Object.entries(lock.packages).filter(([name, entry]) => name && !entry.dev).map(([name]) => name);
  compareNames(runtimePaths, review.packages.map((entry) => entry.path), 'Runtime dependency list changed; license review required.');
  const runtime = review.packages.map((entry) => packageNotices(root, lock, entry));
  const buildHelpers = review.buildHelpers.map((entry) => packageNotices(root, lock, entry,
    { allowBuildSnapshot: mode === 'package' }));
  const font = fontNotices(root, review.font, mode);
  const node = mode === 'package' ? nodeNotices(root, review.node) : undefined;
  const components = [...runtime, ...buildHelpers, font, ...(node ? [node] : [])];
  const manifest = {
    schemaVersion: 1, mode, reviewedAt: review.reviewedAt,
    scope: review.scope, licenseTextHashNormalization: review.licenseTextHashNormalization,
    packageLockSha256: textHash(lockBytes.toString('utf8')),
    runtimePackages: runtime.map(withoutText), buildHelperNotices: buildHelpers.map(withoutText),
    font: withoutText(font), ...(node ? { node: withoutText(node) } : {}),
  };
  const notices = `THIRD-PARTY LICENSES AND NOTICES\n\n` +
    `These complete upstream texts are provided with La Gustosa POS. Their terms\n` +
    `remain applicable independently of any commercial application agreement.\n` +
    `Scope: runtime npm dependencies, conservative build-helper notices, the\n` +
    `bundled font${node ? ', and the distributed Node.js runtime' : ''}. This does not mean that all development tools\n` +
    `are distributed or that every component appears in the browser bundle.\n` +
    `Package metadata is descriptive; the full texts below may contain additional\n` +
    `copyright and license terms. This file is not a product approval, ownership\n` +
    `certificate, trademark permission, or a license to La Gustosa branding.\n\n` +
    `${renderDocuments(components)}\n`;
  return { notices, manifest, nodeLicense: node?.documents[0].text };
}

export function generateNotices(root = scriptRoot, { mode = 'web' } = {}) {
  root = path.resolve(root);
  const result = collectNotices(root, { mode });
  const output = mode === 'web' ? inside(root, 'web/public/licenses/generated') : root;
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.txt'), result.notices, 'utf8');
  writeFileSync(path.join(output, 'THIRD-PARTY-MANIFEST.json'), `${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8');
  if (result.nodeLicense) writeFileSync(inside(root, 'runtime/LICENSE'), result.nodeLicense, 'utf8');
  return result.manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const isPackage = args.length === 2 && args[0] === '--package-root';
    if (args.length && !isPackage) throw new Error('Usage: node scripts/generate-third-party-notices.mjs [--package-root DIRECTORY]');
    const manifest = generateNotices(isPackage ? args[1] : scriptRoot, { mode: isPackage ? 'package' : 'web' });
    console.log(`Licenses verified: ${manifest.runtimePackages.length} runtime packages, ${manifest.buildHelperNotices.length} build-helper entries, font${manifest.node ? `, Node ${manifest.node.version}` : ''}.`);
  } catch (error) {
    console.error(`License generation stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
