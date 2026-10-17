import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, symlink, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.resolve(process.argv[2] || path.join(root, '..', 'node_modules'));
const require = createRequire(path.join(modules, '_native_build.cjs'));
const { build } = require('esbuild');
const output = path.join(root, 'artifacts', 'native-server');
await mkdir(output, { recursive: true });
const linked = path.join(output, 'node_modules');
try { await lstat(linked); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await symlink(modules, linked, process.platform === 'win32' ? 'junction' : 'dir');
}
for (const name of ['index', 'app', 'app.test']) {
  await build({ entryPoints: [path.join(root, 'server', name + '.ts')], outfile: path.join(output, name + '.mjs'),
    bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', logLevel: 'warning' });
}
console.log('Native server and regression tests built in ' + output);
