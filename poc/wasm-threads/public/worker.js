// App-level worker hosting the WASM module. Mirrors src/workers/slicer.worker.ts
// in the real app: the Emscripten module runs inside a dedicated Worker.
//
// Picks between the two build variants at runtime — this is the dual-mode
// loading pattern documented in INTEGRATION-NOTES.md §3, applied to a real,
// working build instead of just described:
//   - crossOriginIsolated + SharedArrayBuffer available → dist-mt/ (real threads)
//   - otherwise (e.g. today's GitHub Pages demo)         → dist-st/ (sequential
//     fallback baked into the same source — see build.sh)
const CAN_USE_THREADS = self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
const DIST_DIR = CAN_USE_THREADS ? './dist-mt/' : './dist-st/';

importScripts(DIST_DIR + 'parallel_demo.js');

let modulePromise = null;

function getModule() {
  if (!modulePromise) {
    modulePromise = ParallelDemoModule({
      locateFile: (p) => DIST_DIR + p,
      // Needed with MODULARIZE + pthreads: nested pthread Workers can't
      // otherwise infer the URL of this glue script to reload themselves.
      // Harmless (unused) on the dist-st/ build.
      mainScriptUrlOrBlob: DIST_DIR + 'parallel_demo.js',
    });
  }
  return modulePromise;
}

self.onmessage = async (e) => {
  const { id, cmd, n, threads } = e.data;
  try {
    const Module = await getModule();

    if (cmd === 'info') {
      const cores = Module.ccall('get_hardware_concurrency', 'number', [], []);
      self.postMessage({
        id,
        ok: true,
        cores,
        variant: CAN_USE_THREADS ? 'multithreaded' : 'single-threaded',
        crossOriginIsolated: self.crossOriginIsolated,
        hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      });
      return;
    }

    const fn = cmd === 'sequential' ? 'run_sequential' : 'run_parallel';
    const argTypes = cmd === 'sequential' ? ['number'] : ['number', 'number'];
    const argValues = cmd === 'sequential' ? [n] : [n, threads];

    const t0 = performance.now();
    const result = Module.ccall(fn, 'number', argTypes, argValues);
    const elapsed = performance.now() - t0;

    self.postMessage({ id, ok: true, result, elapsed });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.stack) || err) });
  }
};
