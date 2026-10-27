// Build step: writes <file>.br and <file>.gz next to the large static text files in public/
// (polling-unit JSON, scripts, styles). Run by the Dockerfile; safe to re-run.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const wanted = (f) => /\.(json|js|css)$/.test(f);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (wanted(e.name)) yield p;
  }
}

let before = 0, afterBr = 0, n = 0;
for (const file of walk(root)) {
  const buf = fs.readFileSync(file);
  if (buf.length < 1024) continue;
  const br = zlib.brotliCompressSync(buf, { params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
  } });
  const gz = zlib.gzipSync(buf, { level: 9 });
  fs.writeFileSync(`${file}.br`, br);
  fs.writeFileSync(`${file}.gz`, gz);
  before += buf.length; afterBr += br.length; n++;
}
console.log(`precompressed ${n} files: ${(before / 1e6).toFixed(1)} MB -> ${(afterBr / 1e6).toFixed(2)} MB (brotli)`);
