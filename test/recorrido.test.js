// Pruebas y simulación del decodificador de recorrido de mirada.
// Uso:  node test/recorrido.test.js            (rápido: muestra reducida)
//       COMPLETO=1 node test/recorrido.test.js  (2000 palabras por frecuencia + 1000 uniformes, todas las disposiciones y ambos métodos)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const Recorrido = require('../recorrido.js');

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'palabras.js'), 'utf8'), ctx);
const PALABRAS = ctx.window.PALABRAS;
const COMPLETO = !!process.env.COMPLETO;

// ---------- RNG reproducible ----------
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let rnd = mulberry32(12345);
const unif = (a, b) => a + (b - a) * rnd();
function gauss() { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// ---------- Simulador ----------
// Devuelve [{x,y,t}] entre el inicio de palabra y el parpadeo.
function simular(dec, palabra, sigma, o) {
  o = Object.assign({ hz: 25, outliers: 0.03, mirada: 0.5, retardo: [0, 150], sesgo: 0.03, deriva: 0 }, o || {});
  // deriva: desviación de un ruido correlado AR(1) (tau 600 ms) que se suma al ruido blanco
  const zonas = dec.zonas, norm = Recorrido.sinTildes(palabra);
  const zonaLetra = {}; zonas.forEach((z, i) => { for (const c of z.letras) zonaLetra[c] = i; });
  // Tamaño de zona aproximado (grid uniforme)
  const xs = [...new Set(zonas.map(z => z.x.toFixed(3)))].length, ys = [...new Set(zonas.map(z => z.y.toFixed(3)))].length;
  const hw = 1 / xs, hh = 1 / ys;
  // Trayectoria ideal: lista de segmentos {t0,t1,x0,y0,x1,y1}
  const segs = []; let t = 0, cx, cy;
  function fijar(x, y, d) { if (cx !== undefined) { const s = unif(40, 60); segs.push({ t0: t, t1: t + s, x0: cx, y0: cy, x1: x, y1: y }); t += s; } segs.push({ t0: t, t1: t + d, x0: x, y0: y, x1: x, y1: y }); t += d; cx = x; cy = y; }
  if (rnd() < o.mirada) fijar(unif(-1, 1), unif(-1, 1), unif(80, 300));
  const tInicioPalabra = t;
  for (const c of norm) {
    const z = zonas[zonaLetra[c]];
    // posición de la letra dentro de la zona: hasta ±60% de la semianchura
    fijar(z.x + unif(-0.6, 0.6) * hw, z.y + unif(-0.6, 0.6) * hh, unif(150, 400));
  }
  const tFin = t;
  const lag = unif(o.retardo[0], o.retardo[1]);
  const bx = gauss() * o.sesgo, by = gauss() * o.sesgo;
  function pos(tt) { if (tt <= 0) return segs[0]; for (const s of segs) if (tt <= s.t1) { const u = (tt - s.t0) / (s.t1 - s.t0 || 1); return { x0: s.x0 + u * (s.x1 - s.x0), y0: s.y0 + u * (s.y1 - s.y0) }; } const s = segs[segs.length - 1]; return { x0: s.x1, y0: s.y1 }; }
  // El usuario "empieza la palabra" (p. ej. tras el parpadeo anterior) antes de la mirada previa.
  const pts = []; const dt = 1000 / o.hz;
  let dx = gauss() * o.deriva, dy = gauss() * o.deriva; const rho = Math.exp(-dt / 600), inn = Math.sqrt(1 - rho * rho);
  for (let tt = 0; tt <= tFin; tt += dt * unif(0.85, 1.15)) {
    const p = pos(tt - lag);
    dx = rho * dx + inn * o.deriva * gauss(); dy = rho * dy + inn * o.deriva * gauss();
    let x = p.x0 + bx + dx + gauss() * sigma, y = p.y0 + by + dy + gauss() * sigma;
    if (rnd() < o.outliers) { x = unif(-1.5, 1.5); y = unif(-1.5, 1.5); }
    pts.push({ x, y, t: tt });
  }
  return pts;
}

// ---------- Muestras de palabras ----------
function validas() { const v = [], vis = new Set(); PALABRAS.forEach((w, r) => { const n = Recorrido.sinTildes(w); if (/^[a-zñ]+$/.test(n) && !vis.has(w.toLowerCase())) { vis.add(w.toLowerCase()); v.push({ w: w.toLowerCase(), r }); } }); return v; }
const VAL = validas();
function muestraFrecuencia(n, seed) { const R = mulberry32(seed); const pesos = VAL.map(x => 1 / (x.r + 20)); const tot = pesos.reduce((a, b) => a + b, 0); const out = []; for (let i = 0; i < n; i++) { let u = R() * tot, k = 0; while (u > pesos[k]) { u -= pesos[k]; k++; } out.push(VAL[k].w); } return out; }
function muestraUniforme(n, seed) { const R = mulberry32(seed); const out = []; for (let i = 0; i < n; i++) out.push(VAL[Math.floor(R() * VAL.length)].w); return out; }

function evaluar(dec, palabras, sigma, metodo, seed, simOpc) {
  rnd = mulberry32(seed);
  let t1 = 0, t3 = 0, tiempo = 0, tmax = 0;
  for (const w of palabras) {
    const pts = simular(dec, w, sigma, simOpc);
    const a = process.hrtime.bigint();
    const r = dec.decodificar(pts, { n: 5, metodo });
    const ms = Number(process.hrtime.bigint() - a) / 1e6; tiempo += ms; if (ms > tmax) tmax = ms;
    const i = r.findIndex(e => e.w === w);
    if (i === 0) t1++; if (i >= 0 && i < 3) t3++;
  }
  return { top1: t1 / palabras.length, top3: t3 / palabras.length, ms: tiempo / palabras.length, msMax: tmax };
}
module.exports = { simular, evaluar, muestraFrecuencia, muestraUniforme, VAL, PALABRAS };

if (require.main === module) {
  let fallos = 0;
  function afirmar(cond, msg) { if (!cond) { fallos++; console.log('FALLO: ' + msg); } else console.log('ok   ' + msg); }

  // ---------- Pruebas básicas de API ----------
  const dec = Recorrido.crear(PALABRAS);
  afirmar(dec.zonas.length >= 6 && dec.zonas.every(z => z.x >= -1 && z.x <= 1 && z.y >= -1 && z.y <= 1), 'zonas dentro de [-1,1]');
  afirmar(dec.zonas.map(z => z.letras).join('') === 'abcdefghijklmnñopqrstuvwxyz', 'zonas alfabéticas contiguas con ñ junto a n');
  afirmar(dec.zonaDe(dec.zonas[0].x, dec.zonas[0].y) === 0 && dec.zonaDe(5, 5) === dec.zonas.length - 1, 'zonaDe');
  afirmar(dec.plantilla('llama').length === dec.plantilla('lama').length, 'plantilla colapsa duplicados consecutivos');
  afirmar(JSON.stringify(dec.plantilla('Ñandú')) === JSON.stringify(dec.plantilla('nandu')), 'plantilla ignora tildes, ñ con n');
  afirmar(dec.decodificar([], { n: 3 }).length === 0, 'sin puntos -> []');
  // Plantilla ideal limpia (5 muestras por letra) -> top-1
  for (const w of ['hola', 'que', 'casa', 'gracias', 'mañana']) {
    const pts = []; dec.plantilla(w).forEach(p => { for (let k = 0; k < 6; k++) pts.push({ x: p.x, y: p.y, t: pts.length * 40 }); });
    const r = dec.decodificar(pts, { n: 3 });
    afirmar(r.length > 0 && r.slice(0, 3).some(e => e.w === w), `plantilla limpia "${w}" -> top3 [${r.map(e => e.w).join(',')}]`);
  }
  // Palabras de una letra: fijación única
  for (const w of ['a', 'y', 'o', 'e']) {
    const p = dec.plantilla(w)[0]; const pts = []; for (let k = 0; k < 8; k++) pts.push({ x: p.x + 0.03 * Math.sin(k), y: p.y, t: k * 40 });
    const r = dec.decodificar(pts, { n: 3 });
    afirmar(r.some(e => e.w === w), `una letra "${w}" -> top3 [${r.map(e => e.w).join(',')}]`);
  }
  // Simuladas con σ=0.05 (5 repeticiones, se exige top3 en al menos 4)
  for (const w of ['hola', 'que', 'casa']) {
    rnd = mulberry32(777); let ok = 0;
    for (let k = 0; k < 5; k++) { const r = dec.decodificar(simular(dec, w, 0.05), { n: 3 }); if (r.some(e => e.w === w)) ok++; }
    afirmar(ok >= 4, `simulada σ=0.05 "${w}" top3 ${ok}/5`);
  }

  // ---------- Tabla de resultados ----------
  const nF = COMPLETO ? 2000 : 400, nU = COMPLETO ? 1000 : 200;
  const frec = muestraFrecuencia(nF, 1), uni = muestraUniforme(nU, 2);
  const sigmas = [0.05, 0.1, 0.15, 0.2];
  const DEF = Recorrido.DISPOSICION_DEFECTO;
  const filas = COMPLETO
    ? Object.keys(Recorrido.DISPOSICIONES).map(d => [d, 'hmm']).concat([[DEF, 'forma']])
    : [[DEF, 'hmm']];
  const pct = v => (100 * v).toFixed(1).padStart(5);
  console.log(`\nPrecisión top1/top3 (%) — F: muestra por frecuencia n=${nF} | U: uniforme n=${nU}`);
  console.log('(simulación: mirada previa 50%, retardo 0-150 ms, 3% outliers, sesgo 0.03, 25 Hz)');
  console.log('disp  método  ' + sigmas.map(s => ('σ=' + s).padEnd(28)).join(''));
  let msTot = 0, msMax = 0, nT = 0;
  const decs = {};
  for (const [d, m] of filas) {
    const dd = decs[d] || (decs[d] = Recorrido.crear(PALABRAS, { zonas: d }));
    let fila = d.padEnd(6) + m.padEnd(8);
    for (const s of sigmas) {
      const a = evaluar(dd, frec, s, m, 100), b = evaluar(dd, uni, s, m, 200);
      fila += `F ${pct(a.top1)}/${pct(a.top3)} U ${pct(b.top1)}/${pct(b.top3)}   `;
      if (m === 'hmm' && d === DEF) { msTot += a.ms + b.ms; nT += 2; msMax = Math.max(msMax, a.msMax, b.msMax); }
    }
    console.log(fila);
  }
  if (COMPLETO) {
    console.log(`\nRobustez (${DEF}, hmm, muestra por frecuencia):`);
    const conds = [['sin mirada previa, σ=0.1', 0.1, { mirada: 0 }], ['sesgo 0.1, σ=0.1', 0.1, { sesgo: 0.1 }],
      ['sesgo 0.15, σ=0.2', 0.2, { sesgo: 0.15 }], ['deriva AR(1) 0.1 + σ=0.1', 0.1, { deriva: 0.1 }],
      ['deriva AR(1) 0.15 + σ=0.15', 0.15, { deriva: 0.15 }], ['σ=0.3', 0.3, {}], ['15 Hz, σ=0.1', 0.1, { hz: 15 }], ['60 Hz, σ=0.1', 0.1, { hz: 60 }]];
    for (const [nom, s, o] of conds) {
      const r = evaluar(decs[DEF], frec, s, 'hmm', 300, o);
      console.log(`  ${nom.padEnd(28)} ${pct(r.top1)}/${pct(r.top3)}  (${r.ms.toFixed(2)} ms/palabra)`);
    }
  }
  console.log(`\nTiempo de decodificación (${Recorrido.DISPOSICION_DEFECTO}, hmm, ${dec.numPalabras} palabras): medio ${(msTot / nT).toFixed(2)} ms, máx ${msMax.toFixed(1)} ms`);
  const tcrear = Date.now(); Recorrido.crear(PALABRAS); console.log(`Tiempo de crear(): ${Date.now() - tcrear} ms`);

  // Umbral mínimo de calidad con σ=0.1 en la disposición por defecto
  const q = evaluar(dec, frec.slice(0, 300), 0.1, 'hmm', 5);
  afirmar(q.top3 > 0.8, `top3 σ=0.1 (frecuencia) > 80%: ${pct(q.top3)}%`);
  afirmar(q.ms < 50, `tiempo medio < 50 ms: ${q.ms.toFixed(2)} ms`);
  console.log(fallos ? `\n${fallos} fallo(s)` : '\nTodo OK');
  process.exit(fallos ? 1 : 0);
}
