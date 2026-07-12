const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const runBtn = document.getElementById('run');
const nInput = document.getElementById('n');

const worker = new Worker('./worker.js');
let nextId = 1;
const pending = new Map();

worker.onmessage = (e) => {
  const resolve = pending.get(e.data.id);
  if (resolve) {
    pending.delete(e.data.id);
    resolve(e.data);
  }
};

function call(msg) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, ...msg });
  });
}

async function init() {
  const info = await call({ cmd: 'info' });
  if (!info.ok) {
    statusEl.textContent = 'Blad inicjalizacji: ' + info.error;
    statusEl.className = 'bad';
    runBtn.disabled = true;
    return;
  }
  const isolated = info.crossOriginIsolated;
  statusEl.innerHTML =
    `wariant załadowany przez worker.js: <b class="${isolated ? 'ok' : 'bad'}">${info.variant}</b> &middot; ` +
    `crossOriginIsolated: <b class="${isolated ? 'ok' : 'bad'}">${isolated}</b> &middot; ` +
    `SharedArrayBuffer: <b class="${info.hasSharedArrayBuffer ? 'ok' : 'bad'}">${info.hasSharedArrayBuffer}</b> &middot; ` +
    `navigator.hardwareConcurrency: <b>${navigator.hardwareConcurrency}</b> &middot; ` +
    `WASM-reported logical cores: <b>${info.cores}</b>`;
  if (!isolated) {
    statusEl.innerHTML +=
      '<br><span class="bad">Serwer nie wysyla naglowkow COOP/COEP - worker.js automatycznie ' +
      'zaladowal wariant single-threaded (dist-st/) zamiast dist-mt/. To jest dokladnie sytuacja ' +
      'produkcyjna na GitHub Pages dzisiaj: silnik nadal dziala, tylko bez przyspieszenia ' +
      'wielordzeniowego.</span>';
  }
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  resultEl.textContent = 'Licze...';

  const n = parseInt(nInput.value, 10);
  const maxThreads = Math.min(8, navigator.hardwareConcurrency || 4);
  const threadCounts = [2, 4, maxThreads].filter((v, i, a) => v >= 2 && a.indexOf(v) === i);

  const rows = [];
  rows.push(['sekwencyjnie (1 watek, zwykla petla)', await call({ cmd: 'sequential', n })]);
  for (const threads of threadCounts) {
    rows.push([`rownolegle, ${threads} watki pthread`, await call({ cmd: 'parallel', n, threads })]);
  }

  const base = rows[0][1].ok ? rows[0][1].elapsed : null;
  resultEl.innerHTML = `
    <table>
      <thead><tr><th>Wariant</th><th>Czas (ms)</th><th>Speedup</th><th>Wynik</th></tr></thead>
      <tbody>
        ${rows
          .map(([label, r]) =>
            r.ok
              ? `<tr><td>${label}</td><td>${r.elapsed.toFixed(1)}</td><td>${base ? (base / r.elapsed).toFixed(2) + '&times;' : '-'}</td><td>${r.result.toFixed(4)}</td></tr>`
              : `<tr><td>${label}</td><td colspan="3" class="bad">${r.error}</td></tr>`
          )
          .join('')}
      </tbody>
    </table>
    <p>Kolumna "Wynik" powinna byc identyczna (do bledu zaokraglenia) we wszystkich wierszach
    - to potwierdza, ze podzial pracy na watki jest poprawny, nie tylko szybszy.</p>
  `;
  runBtn.disabled = false;
});

init();
