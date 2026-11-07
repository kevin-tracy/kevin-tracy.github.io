// Fetching and decoding the scan package written by preprocess/fidelity.py (format "fmt-scan/2").
// Everything heavy was done offline; here we only download, gunzip and slice byte ranges.

export async function gunzip(bytes) {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes; // server already decoded it
  if (typeof DecompressionStream === "undefined") throw new Error("This browser can't decompress the scan (needs Safari 16.4+ or a recent Chrome/Firefox).");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Read `url` as a stream, calling onRange(buf, received) as bytes arrive, until `end` bytes
// are in (then the request is cancelled: a level that needs only a prefix stops there).
async function streamPrefix(url, end, signal, onRange) {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`${resp.status} fetching ${url}`);
  const buf = new Uint8Array(end);
  if (!resp.body) {
    const all = new Uint8Array(await resp.arrayBuffer());
    buf.set(all.subarray(0, end));
    await onRange(buf, end);
    return buf;
  }
  const reader = resp.body.getReader();
  let got = 0;
  try {
    while (got < end) {
      const { done, value } = await reader.read();
      if (done) break;
      const n = Math.min(value.length, end - got);
      buf.set(value.subarray(0, n), got);
      got += n;
      await onRange(buf, got);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (got < end) throw new Error(`${url} ended early (${got} of ${end} bytes)`);
  return buf;
}

export async function loadManifest() {
  const r = await fetch("scan.json");
  if (!r.ok) throw new Error(`scan.json: ${r.status}`);
  const m = await r.json();
  if (m.format !== "fmt-scan/2") throw new Error(`unsupported scan format ${m.format}`);
  return m;
}

// base.bin: every section is its own gzip member, decoded once the whole file is in.
export async function loadBase(m, signal, onProgress) {
  const b = m.base;
  const buf = await streamPrefix(b.file, b.bytes, signal, (_, got) => onProgress(got, b.bytes));
  const out = {};
  for (const s of b.sections) {
    const v = await gunzip(buf.subarray(s.offset, s.offset + s.length));
    if (v.length !== s.dims[0] * s.dims[1] * s.dims[2]) throw new Error(`section ${s.name}: unexpected size ${v.length}`);
    out[s.name] = { data: v, dims: s.dims };
  }
  return out;
}

// fine.bin: stream the first `count` chunks, handing each decoded chunk to onChunk as soon as
// it has fully arrived, so the view sharpens while the rest downloads.
export async function streamFine(m, count, signal, onChunk, onProgress) {
  const chunks = m.fine.chunks.slice(0, count);
  if (!chunks.length) return;
  const end = chunks[chunks.length - 1].offset + chunks[chunks.length - 1].length;
  let next = 0;
  await streamPrefix(m.fine.file, end, signal, async (buf, got) => {
    onProgress(got, end);
    while (next < chunks.length && chunks[next].offset + chunks[next].length <= got) {
      const c = chunks[next++];
      await onChunk(parseChunk(await gunzip(buf.subarray(c.offset, c.offset + c.length))));
    }
  });
}

// u32 count, count x (bx, by, bz, max), then count x E^3 voxels.
function parseChunk(u8) {
  const count = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0, true);
  return { count, head: u8.subarray(4, 4 + 4 * count), vox: u8.subarray(4 + 4 * count) };
}
