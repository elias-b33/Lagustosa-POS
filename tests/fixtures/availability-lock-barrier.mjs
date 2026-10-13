// Test-only interleaving: pause one startup after it has read a stale PID file.
// A second startup can then acquire ownership before this one resumes.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const originalRead = fs.readFileSync;
let intercepted = false;
fs.readFileSync = function (filename, ...args) {
  const result = originalRead.call(this, filename, ...args);
  if (!intercepted && String(filename) === process.env.AVAILABILITY_LOCK_FILE) {
    intercepted = true;
    fs.writeFileSync(process.env.AVAILABILITY_OBSERVED_FILE, 'read');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(process.env.AVAILABILITY_RELEASE_FILE)) {
      if (Date.now() >= deadline) throw new Error('Test lock barrier timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return result;
};
syncBuiltinESMExports();
