// Oficina 3D estilo videojuego: diorama con personajes chibi, un escritorio por sesión de Claude Code.
// Los personajes entran por la puerta, se sientan, teclean, piden permiso con la mano levantada,
// celebran al terminar un turno y se van cuando la sesión se cierra.
import * as THREE from '/vendor/three/three.module.js';

export const COLORES = {
  inactivo: '#8d99ae', pensando: '#4ea1ff', ejecutando: '#2ee59d', esperando: '#ffb545',
  guardia: '#c9a6ff', error: '#ff4d6d', terminada: '#4a5268'
};
export const NOMBRES = {
  inactivo: 'Inactivo', pensando: 'Pensando', ejecutando: 'Trabajando', esperando: 'Espera tu aprobación',
  guardia: 'En guardia: espera órdenes', error: 'Error', terminada: 'Sesión terminada'
};
export function nivelDe(herramientas) {
  const x = (herramientas || 0) / 4;
  const nivel = Math.floor(Math.sqrt(x)) + 1;
  const base = (nivel - 1) ** 2, sig = nivel ** 2;
  return { nivel, progreso: Math.min(1, (x - base) / (sig - base)) };
}

const MONO = '"JetBrains Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace';
const SANS = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const REDUCIDO = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Paletas de personajes (se elige por hash del id de sesión: siempre el mismo aspecto).
const CAMISAS = ['#ff6b6b', '#4ecdc4', '#ffd166', '#6c8cff', '#c77dff', '#06d6a0', '#ff9f1c', '#ef476f', '#118ab2', '#f78c6b'];
const PIELES = ['#f6d3b3', '#eebb99', '#d9a066', '#c68a5e', '#a86b45', '#7a4b2e'];
const PELOS = ['#2b2118', '#5a3825', '#d4a017', '#b5482b', '#1c1c1c', '#9aa0a6', '#3d5a80', '#7b2d8b'];
const TAZAS = ['#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#f8f9fa'];

function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const elegir = (lista, h, sal = 0) => lista[(h >>> sal) % lista.length];

export function crearEscena(canvas, { alSeleccionar }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = fondoDegradado();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 400);

  // ---------- Materiales "toon" ----------
  const rampa = new THREE.DataTexture(new Uint8Array([110, 110, 110, 255, 185, 185, 185, 255, 255, 255, 255, 255]), 3, 1);
  rampa.minFilter = rampa.magFilter = THREE.NearestFilter; rampa.needsUpdate = true;
  const cacheMat = new Map();
  const toon = (color) => {
    if (!cacheMat.has(color)) cacheMat.set(color, new THREE.MeshToonMaterial({ color, gradientMap: rampa }));
    return cacheMat.get(color);
  };
  const compartidos = new Set();
  const malla = (geo, mat, sombra = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = sombra; m.receiveShadow = true; return m; };

  // ---------- Luz ----------
  scene.add(new THREE.HemisphereLight('#dfe9ff', '#7a5c44', 1.5));
  const sol = new THREE.DirectionalLight('#fff1dc', 2.4);
  sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048);
  sol.shadow.bias = -0.0005;
  sol.shadow.normalBias = 0.02;
  scene.add(sol, sol.target);

  // ---------- Sala (diorama) ----------
  let sala = null;
  const paredes = { fondo: null, izq: null };
  const dimSala = { W: 0, D: 0, puerta: new THREE.Vector3(), zPasillo: 0 };
  const cielo = lienzoTextura(256, 256);
  const reloj = lienzoTextura(256, 256);
  pintarCielo(); pintarReloj();
  setInterval(() => { pintarCielo(); pintarReloj(); }, 30000);

  function construirSala(W, D) {
    if (sala) { scene.remove(sala); liberar(sala); }
    sala = new THREE.Group();
    dimSala.W = W; dimSala.D = D;
    const x0 = -W / 2, z0 = -D / 2;

    // Losa del diorama con suelo de madera
    const losa = malla(new THREE.BoxGeometry(W, 0.8, D), toon('#5b4636'), false);
    losa.position.y = -0.4; sala.add(losa);
    const tex = texturaMadera();
    tex.repeat.set(W / 6, D / 6);
    const suelo = malla(new THREE.PlaneGeometry(W, D), new THREE.MeshToonMaterial({ map: tex, gradientMap: rampa }), false);
    suelo.rotation.x = -Math.PI / 2; suelo.position.y = 0.002; sala.add(suelo);
    // Alfombra bajo los escritorios
    const alfombra = malla(new THREE.BoxGeometry(W - 9, 0.03, D - 9), toon('#2f6f73'), false);
    alfombra.position.set(1, 0.015, 1); sala.add(alfombra);
    const borde = malla(new THREE.BoxGeometry(W - 8.4, 0.02, D - 8.4), toon('#e9c46a'), false);
    borde.position.set(1, 0.01, 1); sala.add(borde);

    // Paredes en L (fondo e izquierda)
    const pared = toon('#f1e3cf'), zocalo = toon('#b07d56');
    const fondo = malla(new THREE.BoxGeometry(W, 5, 0.4), pared); fondo.position.set(0, 2.5, z0 - 0.2); sala.add(fondo);
    const izq = malla(new THREE.BoxGeometry(0.4, 5, D + 0.4), pared); izq.position.set(x0 - 0.2, 2.5, -0.2); sala.add(izq);
    const z1 = malla(new THREE.BoxGeometry(W, 0.35, 0.1), zocalo, false); z1.position.set(0, 0.18, z0 + 0.05); sala.add(z1);
    const z2 = malla(new THREE.BoxGeometry(0.1, 0.35, D), zocalo, false); z2.position.set(x0 + 0.05, 0.18, 0); sala.add(z2);
    const remate = toon('#d8c3a5');
    const r1 = malla(new THREE.BoxGeometry(W + 0.4, 0.2, 0.6), remate); r1.position.set(-0.2, 5.1, z0 - 0.2); sala.add(r1);
    const r2 = malla(new THREE.BoxGeometry(0.6, 0.2, D + 0.4), remate); r2.position.set(x0 - 0.2, 5.1, -0.2); sala.add(r2);

    // Ventanas en la pared del fondo
    const nVent = Math.max(2, Math.floor(W / 9));
    const matCielo = new THREE.MeshBasicMaterial({ map: cielo.tex, toneMapped: false });
    compartidos.add(matCielo);
    for (let i = 0; i < nVent; i++) {
      const x = x0 + (W / (nVent + 1)) * (i + 1) + 2;
      if (x > W / 2 - 4) continue;
      const marco = malla(new THREE.BoxGeometry(3.2, 2.4, 0.15), toon('#ffffff'), false);
      marco.position.set(x, 2.9, z0 + 0.05); sala.add(marco);
      const vidrio = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 2.1), matCielo);
      vidrio.position.set(x, 2.9, z0 + 0.14); sala.add(vidrio);
      const cruz1 = malla(new THREE.BoxGeometry(0.1, 2.1, 0.06), toon('#ffffff'), false); cruz1.position.set(x, 2.9, z0 + 0.17); sala.add(cruz1);
      const cruz2 = malla(new THREE.BoxGeometry(2.9, 0.1, 0.06), toon('#ffffff'), false); cruz2.position.set(x, 2.9, z0 + 0.17); sala.add(cruz2);
      const alfeizar = malla(new THREE.BoxGeometry(3.4, 0.12, 0.4), toon('#ffffff')); alfeizar.position.set(x, 1.65, z0 + 0.2); sala.add(alfeizar);
      if (i % 2 === 0) { const m = maceta(0.22, '#e76f51', '#2a9d8f'); m.position.set(x + 1.1, 1.71, z0 + 0.22); m.scale.setScalar(0.6); sala.add(m); }
    }

    // Puerta en la pared izquierda, cerca del frente
    const zPuerta = D / 2 - 2.6;
    const marcoP = malla(new THREE.BoxGeometry(0.2, 3.3, 1.9), toon('#8d5a3b'), false); marcoP.position.set(x0 + 0.02, 1.65, zPuerta); sala.add(marcoP);
    const hoja = malla(new THREE.BoxGeometry(0.12, 3.0, 1.5), toon('#e76f51'), false); hoja.position.set(x0 + 0.1, 1.5, zPuerta); sala.add(hoja);
    const pomo = malla(new THREE.SphereGeometry(0.08, 10, 8), toon('#ffd166'), false); pomo.position.set(x0 + 0.2, 1.45, zPuerta + 0.5); sala.add(pomo);
    const cartel = etiqueta('SALIDA', { tam: 30, color: '#ffffff', fondoColor: '#2a9d8f', escala: 0.008 });
    cartel.position.set(x0 + 0.4, 3.5, zPuerta); sala.add(cartel);
    dimSala.puerta.set(x0 + 0.8, 0, zPuerta);
    dimSala.zPasillo = D / 2 - 2.6;

    // Reloj (hora real) y pizarra en la pared izquierda
    const matReloj = new THREE.MeshBasicMaterial({ map: reloj.tex, transparent: true, toneMapped: false });
    compartidos.add(matReloj);
    const esfera = new THREE.Mesh(new THREE.CircleGeometry(0.75, 40), matReloj);
    esfera.rotation.y = Math.PI / 2; esfera.position.set(x0 + 0.03, 3.7, -D / 2 + 3); sala.add(esfera);
    const pizarra = malla(new THREE.BoxGeometry(0.1, 2, 3.6), toon('#ffffff'), false); pizarra.position.set(x0 + 0.05, 2.6, -D / 2 + 7); sala.add(pizarra);
    const garabatos = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.8), new THREE.MeshBasicMaterial({ map: texturaPizarra(), transparent: true }));
    garabatos.rotation.y = Math.PI / 2; garabatos.position.set(x0 + 0.11, 2.6, -D / 2 + 7); sala.add(garabatos);

    // Estantería con libros (rincón del fondo a la izquierda)
    const est = new THREE.Group();
    const madera = toon('#a0714f');
    const cuerpo = malla(new THREE.BoxGeometry(2.6, 3.4, 0.7), madera); cuerpo.position.y = 1.7; est.add(cuerpo);
    for (let f = 0; f < 3; f++) {
      let x = -1.1;
      while (x < 1.05) {
        const ancho = 0.12 + Math.random() * 0.1, alto = 0.55 + Math.random() * 0.3;
        const libro = malla(new THREE.BoxGeometry(ancho, alto, 0.5), toon(elegir(CAMISAS, Math.floor(Math.random() * 1e6))), false);
        libro.position.set(x + ancho / 2, 0.45 + f * 1.05 + alto / 2, 0.12);
        if (Math.random() < 0.15) libro.rotation.z = 0.25;
        est.add(libro); x += ancho + 0.03;
      }
    }
    est.position.set(x0 + 2.2, 0, z0 + 0.6); sala.add(est);

    // Zona de café (rincón del fondo a la derecha)
    const cafe = new THREE.Group();
    const mueble = malla(new THREE.BoxGeometry(3, 1.1, 0.9), toon('#264653')); mueble.position.y = 0.55; cafe.add(mueble);
    const encimera = malla(new THREE.BoxGeometry(3.1, 0.08, 1), toon('#e9edc9')); encimera.position.y = 1.14; cafe.add(encimera);
    const maquina = malla(new THREE.BoxGeometry(0.7, 0.8, 0.55), toon('#3d405b')); maquina.position.set(-0.8, 1.58, 0); cafe.add(maquina);
    const piloto = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff4d6d' })); piloto.position.set(-0.6, 1.8, 0.28); cafe.add(piloto);
    for (let i = 0; i < 3; i++) { const t = taza(TAZAS[i]); t.position.set(0.1 + i * 0.35, 1.18, 0.1); cafe.add(t); }
    const garrafa = malla(new THREE.CylinderGeometry(0.28, 0.28, 0.7, 16), new THREE.MeshToonMaterial({ color: '#8ecae6', gradientMap: rampa, transparent: true, opacity: 0.8 })); garrafa.position.set(1.1, 1.53, 0); cafe.add(garrafa);
    cafe.position.set(W / 2 - 2.4, 0, z0 + 0.6); sala.add(cafe);

    // Sofá y mesita (rincón delantero derecho)
    const sofa = new THREE.Group();
    const tapiz = toon('#ef476f');
    const base = malla(new THREE.BoxGeometry(3, 0.6, 1.1), tapiz); base.position.y = 0.45; sofa.add(base);
    const resp = malla(new THREE.BoxGeometry(3, 0.9, 0.3), tapiz); resp.position.set(0, 0.95, -0.42); sofa.add(resp);
    [-1.45, 1.45].forEach((x) => { const b = malla(new THREE.BoxGeometry(0.25, 0.75, 1.1), tapiz); b.position.set(x, 0.65, 0); sofa.add(b); });
    const cojin = malla(new THREE.BoxGeometry(0.6, 0.45, 0.2), toon('#ffd166')); cojin.position.set(-0.8, 0.95, -0.2); cojin.rotation.z = 0.3; sofa.add(cojin);
    sofa.rotation.y = -Math.PI / 2; sofa.position.set(W / 2 - 1.6, 0, D / 2 - 3.2); sala.add(sofa);

    // Plantas
    [[W / 2 - 1, -D / 2 + 2.6], [x0 + 1, D / 2 - 5.2], [W / 2 - 1, D / 2 - 1], [x0 + 4.4, z0 + 0.8]].forEach(([x, z], i) => {
      const p = maceta(0.45, ['#e76f51', '#f4a261', '#2a9d8f', '#e9c46a'][i], ['#2a9d8f', '#40916c', '#52b788', '#2d6a4f'][i]);
      p.position.set(x, 0, z); sala.add(p);
    });

    // Lo que cuelga de cada pared va en su grupo, para ocultarlo si la cámara queda detrás.
    paredes.fondo = new THREE.Group(); paredes.izq = new THREE.Group();
    for (const o of [...sala.children]) {
      if (o.position.z < z0 + 0.5) paredes.fondo.add(o);
      else if (o.position.x < x0 + 0.5) paredes.izq.add(o);
    }
    sala.add(paredes.fondo, paredes.izq);
    scene.add(sala);
    // Sombra del sol cubriendo toda la sala
    const r = Math.max(W, D) * 0.75;
    sol.position.set(W * 0.35, 26, D * 0.55);
    sol.target.position.set(0, 0, 0);
    Object.assign(sol.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 90 });
    sol.shadow.camera.updateProjectionMatrix();
  }

  function maceta(radio, colorMaceta, colorHojas) {
    const g = new THREE.Group();
    const m = malla(new THREE.CylinderGeometry(radio, radio * 0.75, radio * 1.6, 14), toon(colorMaceta)); m.position.y = radio * 0.8; g.add(m);
    const hojas = toon(colorHojas);
    for (let i = 0; i < 5; i++) {
      const h = malla(new THREE.IcosahedronGeometry(radio * (0.75 + Math.random() * 0.35), 0), hojas);
      const a = (i / 5) * Math.PI * 2;
      h.position.set(Math.cos(a) * radio * 0.6, radio * 2.2 + Math.random() * radio * 0.8, Math.sin(a) * radio * 0.6);
      g.add(h);
    }
    const copa = malla(new THREE.IcosahedronGeometry(radio * 1.05, 0), hojas); copa.position.y = radio * 3; g.add(copa);
    return g;
  }

  function taza(color) {
    const g = new THREE.Group();
    const c = malla(new THREE.CylinderGeometry(0.1, 0.085, 0.2, 12), toon(color), false); c.position.y = 0.1; g.add(c);
    const asa = malla(new THREE.TorusGeometry(0.06, 0.018, 6, 12), toon(color), false); asa.position.set(0.11, 0.1, 0); asa.rotation.y = Math.PI / 2; g.add(asa);
    return g;
  }

  // ---------- Escritorios y personajes ----------
  const escritorios = new Map();
  const objetivosClic = [];
  let seleccionado = null;
  let primeraCarga = true;

  const geoClic = new THREE.BoxGeometry(4.4, 3.6, 4.6);
  const matClic = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  compartidos.add(matClic);

  function nuevoEscritorio(s) {
    const h = hash(s.id);
    const g = new THREE.Group();
    const e = { id: s.id, g, h, destino: new THREE.Vector3(), firmaPantalla: '', firmaEtiqueta: '', previo: null, robots: [], ultimaParticula: 0 };

    const madera = toon('#c8935f'), metal = toon('#3d405b');
    const tablero = malla(new THREE.BoxGeometry(3.2, 0.14, 1.6), madera); tablero.position.y = 1.0; g.add(tablero);
    [[-1.45, -0.65], [1.45, -0.65], [-1.45, 0.65], [1.45, 0.65]].forEach(([x, z]) => {
      const p = malla(new THREE.BoxGeometry(0.12, 1, 0.12), metal); p.position.set(x, 0.5, z); g.add(p);
    });
    const cajonera = malla(new THREE.BoxGeometry(0.8, 0.75, 1.3), toon('#e9edc9')); cajonera.position.set(1, 0.45, -0.05); g.add(cajonera);

    // Monitor
    const marco = malla(new THREE.BoxGeometry(2.0, 1.25, 0.1), toon('#2b2d42')); marco.position.set(0, 1.85, -0.45); g.add(marco);
    const pie = malla(new THREE.BoxGeometry(0.14, 0.4, 0.14), toon('#2b2d42')); pie.position.set(0, 1.25, -0.45); g.add(pie);
    const peana = malla(new THREE.BoxGeometry(0.6, 0.04, 0.35), toon('#2b2d42')); peana.position.set(0, 1.09, -0.45); g.add(peana);
    e.lienzo = document.createElement('canvas'); e.lienzo.width = 640; e.lienzo.height = 384;
    e.textura = new THREE.CanvasTexture(e.lienzo); e.textura.colorSpace = THREE.SRGBColorSpace; e.textura.anisotropy = 4;
    e.matPantalla = new THREE.MeshBasicMaterial({ map: e.textura, toneMapped: false });
    const pantalla = new THREE.Mesh(new THREE.PlaneGeometry(1.88, 1.13), e.matPantalla);
    pantalla.position.set(0, 1.85, -0.394); g.add(pantalla);
    e.led = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: COLORES.inactivo, toneMapped: false }));
    e.led.position.set(0.85, 1.32, -0.39); g.add(e.led);

    const teclado = malla(new THREE.BoxGeometry(0.95, 0.05, 0.32), toon('#edf2f4'), false); teclado.position.set(0, 1.09, 0.25); g.add(teclado);
    const raton = malla(new THREE.SphereGeometry(0.08, 10, 8), toon('#edf2f4'), false); raton.scale.set(1, 0.5, 1.4); raton.position.set(0.75, 1.1, 0.3); g.add(raton);
    const t = taza(elegir(TAZAS, h, 3)); t.position.set(-1.2, 1.07, 0.15); g.add(t);
    if (h % 3 === 0) { const p = maceta(0.16, '#f4a261', '#52b788'); p.position.set(-1.25, 1.07, -0.45); g.add(p); }
    else { const pila = malla(new THREE.BoxGeometry(0.5, 0.15, 0.4), toon(elegir(CAMISAS, h, 5)), false); pila.position.set(-1.15, 1.15, -0.4); g.add(pila); }

    // Silla
    const tapiz = toon(elegir(['#3d405b', '#264653', '#6d597a', '#355070'], h, 7));
    const asiento = malla(new THREE.BoxGeometry(0.9, 0.12, 0.85), tapiz); asiento.position.set(0, 0.62, 1.25); g.add(asiento);
    const respaldo = malla(new THREE.BoxGeometry(0.9, 1.0, 0.12), tapiz); respaldo.position.set(0, 1.2, 1.7); g.add(respaldo);
    const columna = malla(new THREE.CylinderGeometry(0.06, 0.06, 0.55, 8), metal); columna.position.set(0, 0.3, 1.25); g.add(columna);
    const estrella = malla(new THREE.CylinderGeometry(0.45, 0.45, 0.06, 5), metal); estrella.position.set(0, 0.05, 1.25); g.add(estrella);

    // Anillo de estado en el suelo
    e.anillo = new THREE.Mesh(new THREE.RingGeometry(2.25, 2.45, 64), new THREE.MeshBasicMaterial({ color: COLORES.inactivo, transparent: true, opacity: 0.9, toneMapped: false }));
    e.anillo.rotation.x = -Math.PI / 2; e.anillo.position.set(0, 0.035, 0.4); g.add(e.anillo);
    e.seleccion = new THREE.Mesh(new THREE.RingGeometry(2.55, 2.65, 64), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, toneMapped: false }));
    e.seleccion.rotation.x = -Math.PI / 2; e.seleccion.position.set(0, 0.04, 0.4); g.add(e.seleccion);

    // Placa con nombre y nivel
    e.etiqueta = etiqueta(' ', { tam: 34, fijo: true, px: 26 });
    e.etiqueta.position.set(0, 3.4, -0.45); g.add(e.etiqueta);
    e.sobre = etiqueta('✉', { tam: 40, color: '#140b2a', fondoColor: '#c9a6ff' });
    e.sobre.position.set(1.35, 2.75, -0.45); e.sobre.visible = false; g.add(e.sobre);

    const clic = new THREE.Mesh(geoClic, matClic);
    clic.position.set(0, 1.7, 0.5); clic.userData.id = s.id; g.add(clic);
    objetivosClic.push(clic); e.clic = clic;

    g.scale.setScalar(0.01);
    scene.add(g);
    e.p = nuevoPersonaje(h);
    scene.add(e.p.raiz);
    escritorios.set(s.id, e);
    return e;
  }

  function nuevoPersonaje(h) {
    const raiz = new THREE.Group();
    const camisa = toon(elegir(CAMISAS, h)), piel = toon(elegir(PIELES, h, 4)), pelo = toon(elegir(PELOS, h, 9));
    const pantalon = toon(elegir(['#2b2d42', '#3d5a80', '#5c4033', '#495057'], h, 13));
    const p = { raiz, modo: 'fuera', ruta: [], fase: (h % 1000) / 160, parpadeo: 2 + (h % 30) / 10, sacudida: 0, saludo: 0, mano: 0 };

    const cadera = new THREE.Group(); cadera.position.y = 0.62; raiz.add(cadera);
    p.piernas = [-0.14, 0.14].map((x) => {
      const piv = new THREE.Group(); piv.position.set(x, 0, 0); cadera.add(piv);
      const pierna = malla(new THREE.CapsuleGeometry(0.11, 0.36, 4, 10), pantalon); pierna.position.y = -0.3; piv.add(pierna);
      const zapato = malla(new THREE.BoxGeometry(0.2, 0.12, 0.3), toon('#1f1f1f')); zapato.position.set(0, -0.56, 0.06); piv.add(zapato);
      return piv;
    });
    p.torso = malla(new THREE.CapsuleGeometry(0.3, 0.42, 6, 14), camisa); p.torso.position.y = 0.98; raiz.add(p.torso);
    p.brazos = [-1, 1].map((lado) => {
      const piv = new THREE.Group(); piv.position.set(0.37 * lado, 1.24, 0); raiz.add(piv);
      const brazo = malla(new THREE.CapsuleGeometry(0.09, 0.34, 4, 10), camisa); brazo.position.y = -0.24; piv.add(brazo);
      const manoM = malla(new THREE.SphereGeometry(0.09, 10, 8), piel); manoM.position.y = -0.5; piv.add(manoM);
      return piv;
    });
    p.cabeza = new THREE.Group(); p.cabeza.position.y = 1.62; raiz.add(p.cabeza);
    const craneo = malla(new THREE.SphereGeometry(0.36, 20, 16), piel); p.cabeza.add(craneo);
    const melena = malla(new THREE.SphereGeometry(0.385, 20, 16, 0, Math.PI * 2, 0, Math.PI * (0.42 + (h % 5) * 0.03)), pelo);
    melena.rotation.x = -0.35; melena.position.set(0, 0.03, -0.03); p.cabeza.add(melena);
    if (h % 4 === 0) { const mono = malla(new THREE.SphereGeometry(0.14, 12, 10), pelo); mono.position.set(0, 0.32, -0.25); p.cabeza.add(mono); }
    const negro = toon('#1b1b1b');
    p.ojos = [-0.13, 0.13].map((x) => { const o = malla(new THREE.SphereGeometry(0.055, 10, 8), negro, false); o.position.set(x, 0.02, 0.32); p.cabeza.add(o); return o; });
    const brillo = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    p.ojos.forEach((o) => { const b = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 6), brillo); b.position.set(0.02, 0.02, 0.045); o.add(b); });
    [-0.22, 0.22].forEach((x) => { const m = new THREE.Mesh(new THREE.CircleGeometry(0.06, 12), new THREE.MeshBasicMaterial({ color: '#ff8fa3', transparent: true, opacity: 0.6 })); m.position.set(x, -0.09, 0.315); m.rotation.y = x * 1.4; p.cabeza.add(m); });
    p.boca = malla(new THREE.TorusGeometry(0.06, 0.015, 6, 12, Math.PI), negro, false); p.boca.position.set(0, -0.12, 0.33); p.boca.rotation.z = Math.PI; p.cabeza.add(p.boca);
    if (h % 5 === 1) { // gafas
      const montura = toon('#14213d');
      [-0.13, 0.13].forEach((x) => { const a = malla(new THREE.TorusGeometry(0.085, 0.015, 6, 16), montura, false); a.position.set(x, 0.02, 0.34); p.cabeza.add(a); });
      const puente = malla(new THREE.BoxGeometry(0.08, 0.015, 0.015), montura, false); puente.position.set(0, 0.03, 0.35); p.cabeza.add(puente);
    }
    // Bocadillo de emoción
    p.bocadillo = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false }));
    p.bocadillo.position.set(0.55, 2.35, 0); p.bocadillo.visible = false; raiz.add(p.bocadillo);
    p.tipoBocadillo = '';
    raiz.visible = false;
    return p;
  }

  function quitarEscritorio(id) {
    const e = escritorios.get(id);
    if (!e) return;
    scene.remove(e.g); liberar(e.g);
    scene.remove(e.p.raiz); liberar(e.p.raiz);
    e.robots.forEach((r) => { scene.remove(r.g); liberar(r.g); });
    objetivosClic.splice(objetivosClic.indexOf(e.clic), 1);
    escritorios.delete(id);
  }

  function liberar(obj) {
    obj.traverse((o) => {
      if (o.geometry && o.geometry !== geoClic) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if ([...cacheMat.values()].includes(m) || compartidos.has(m)) continue;
        if (m.map && m.map !== cielo.tex && m.map !== reloj.tex) m.map.dispose();
        m.dispose();
      }
    });
  }

  // Posiciones del mundo de un escritorio
  const asientoDe = (e) => new THREE.Vector3(e.destino.x, 0.1, e.destino.z + 1.25);
  function rutaEntrada(e) {
    const a = asientoDe(e), lateral = e.destino.x + 2.6, frente = e.destino.z + 2.6;
    return [dimSala.puerta.clone(), new THREE.Vector3(lateral, 0, dimSala.zPasillo), new THREE.Vector3(lateral, 0, frente), new THREE.Vector3(a.x, 0, frente), new THREE.Vector3(a.x, 0, a.z + 0.35)];
  }

  function pintarPantalla(e, s) {
    const pend = s.ordenes.filter((o) => o.estado === 'pendiente').length;
    const firma = [s.proyecto, s.estado, s.herramienta, s.detalle, s.permiso, pend, s.subagentes.length, s.ultimoPrompt].join('|');
    if (firma === e.firmaPantalla) return;
    e.firmaPantalla = firma;
    const c = e.lienzo.getContext('2d'), W = e.lienzo.width, H = e.lienzo.height;
    const color = COLORES[s.estado] || COLORES.inactivo;
    c.fillStyle = s.estado === 'terminada' ? '#05070c' : '#0d1b2a';
    c.fillRect(0, 0, W, H);
    if (s.estado === 'terminada') { e.textura.needsUpdate = true; return; }
    // Barra de ventana estilo terminal
    c.fillStyle = '#1b263b'; c.fillRect(0, 0, W, 52);
    ['#ff5f56', '#ffbd2e', '#27c93f'].forEach((col, i) => { c.fillStyle = col; c.beginPath(); c.arc(28 + i * 30, 26, 9, 0, Math.PI * 2); c.fill(); });
    c.font = '600 24px ' + MONO; c.fillStyle = '#e0e1dd'; c.textBaseline = 'middle';
    c.fillText(recortar(c, s.proyecto, W - 140), 120, 27);
    c.fillStyle = color; c.fillRect(0, 52, W, 4);
    c.font = '700 28px ' + SANS; c.fillStyle = color;
    c.fillText('● ' + (NOMBRES[s.estado] || s.estado), 20, 92);
    let y = 142;
    if (s.estado === 'esperando' && s.permiso) {
      c.font = '500 24px ' + MONO; c.fillStyle = '#ffb545'; parrafo(c, s.permiso, 20, y, W - 40, 30, 4);
    } else if (s.herramienta) {
      c.font = '700 30px ' + MONO; c.fillStyle = '#e0e1dd'; c.fillText('> ' + s.herramienta, 20, y); y += 42;
      c.font = '400 23px ' + MONO; c.fillStyle = '#a3b1c6'; parrafo(c, s.detalle, 20, y, W - 40, 30, 4);
    } else if (s.ultimoPrompt) {
      c.font = '400 23px ' + SANS; c.fillStyle = '#8d99ae'; parrafo(c, '«' + s.ultimoPrompt + '»', 20, y, W - 40, 30, 5);
    }
    const pie = [];
    if (s.subagentes.length) pie.push(s.subagentes.length + (s.subagentes.length === 1 ? ' ayudante' : ' ayudantes'));
    if (pend) pie.push('✉ ' + pend + (pend === 1 ? ' orden' : ' órdenes'));
    if (pie.length) { c.font = '600 22px ' + SANS; c.fillStyle = '#c9a6ff'; c.fillText(pie.join('   '), 20, H - 26); }
    e.textura.needsUpdate = true;
  }

  function actualizarEscritorio(e, s) {
    const anterior = e.previo;
    e.s = s;
    pintarPantalla(e, s);
    const color = COLORES[s.estado] || COLORES.inactivo;
    e.anillo.material.color.set(color);
    e.led.material.color.set(color);
    const { nivel } = nivelDe(s.herramientasUsadas);
    const textoEtq = 'Nv ' + nivel + '  ' + s.proyecto;
    if (textoEtq + s.estado !== e.firmaEtiqueta) {
      e.firmaEtiqueta = textoEtq + s.estado;
      repintarEtiqueta(e.etiqueta, textoEtq, { tam: 34, fijo: true, px: 26, color: '#ffffff', fondoColor: color === COLORES.inactivo ? 'rgba(43,45,66,0.92)' : color, colorTexto: color === COLORES.inactivo ? '#ffffff' : '#10131c' });
    }
    e.sobre.visible = s.ordenes.some((o) => o.estado === 'pendiente');

    // Robots ayudantes = subagentes
    while (e.robots.length < s.subagentes.length) { const r = nuevoRobot(e.robots.length); scene.add(r.g); e.robots.push(r); }
    while (e.robots.length > s.subagentes.length) { const r = e.robots.pop(); efectos.chispas(r.g.position, '#c9a6ff', 14); scene.remove(r.g); liberar(r.g); }
    e.robots.forEach((r, i) => r.visor.material.color.set(COLORES[s.subagentes[i].estado] || COLORES.pensando));

    // Eventos de juego al cambiar de estado
    if (anterior) {
      const cabezaMundo = () => e.p.raiz.position.clone().add(new THREE.Vector3(0, 2.4, 0));
      const entregadasAntes = anterior.ordenes.filter((o) => o.estado === 'entregada').length;
      const entregadas = s.ordenes.filter((o) => o.estado === 'entregada').length;
      if (entregadas > entregadasAntes) { efectos.texto(cabezaMundo(), '¡Orden recibida!', '#c9a6ff'); efectos.chispas(cabezaMundo(), '#c9a6ff', 30); e.p.saludo = 1.2; }
      if ((anterior.estado === 'pensando' || anterior.estado === 'ejecutando') && (s.estado === 'inactivo' || s.estado === 'guardia') && s.turnos > anterior.turnos) {
        efectos.confeti(cabezaMundo()); efectos.texto(cabezaMundo(), '¡Turno completado!', '#2ee59d'); e.p.saludo = 1.5;
      }
      if (s.estado === 'error' && anterior.estado !== 'error') { efectos.texto(cabezaMundo(), '¡Error!', '#ff4d6d'); e.p.sacudida = 1; }
      const nAntes = nivelDe(anterior.herramientasUsadas).nivel;
      if (nivel > nAntes) { efectos.texto(cabezaMundo().add(new THREE.Vector3(0, 0.6, 0)), '¡Nivel ' + nivel + '!', '#ffd166'); efectos.confeti(cabezaMundo(), ['#ffd166', '#ffffff', '#f4a261']); }
      if (s.estado === 'terminada' && anterior.estado !== 'terminada') salir(e);
    }
    e.previo = s;
  }

  function salir(e) {
    const p = e.p;
    if (p.modo === 'fuera') return;
    p.ruta = rutaEntrada(e).reverse();
    p.ruta.unshift(asientoDe(e).setY(0).add(new THREE.Vector3(0, 0, 0.35)));
    p.raiz.position.y = 0;
    p.modo = 'saliendo';
  }

  function nuevoRobot(i) {
    const g = new THREE.Group();
    const cuerpo = malla(new THREE.BoxGeometry(0.34, 0.3, 0.3), toon('#edf2f4')); g.add(cuerpo);
    const cab = malla(new THREE.SphereGeometry(0.17, 14, 10), toon('#edf2f4')); cab.position.y = 0.27; g.add(cab);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.07, 0.05), new THREE.MeshBasicMaterial({ color: COLORES.pensando, toneMapped: false }));
    visor.position.set(0, 0.29, 0.15); g.add(visor);
    const antena = malla(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 6), toon('#3d405b'), false); antena.position.y = 0.48; g.add(antena);
    const bola = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff4d6d' })); bola.position.y = 0.58; g.add(bola);
    const helice = malla(new THREE.BoxGeometry(0.5, 0.015, 0.06), toon('#3d405b'), false); helice.position.y = 0.62; g.add(helice);
    g.userData.helice = helice;
    g.scale.setScalar(1.3);
    return { g, visor, fase: i * 2.1 };
  }

  // ---------- Efectos ----------
  const efectos = crearEfectos(scene);

  // ---------- Distribución ----------
  const encuadre = { radio: 16 };
  function recolocar() {
    const lista = [...escritorios.values()].sort((a, b) => (a.s.inicio || 0) - (b.s.inicio || 0));
    const n = lista.length;
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(n))));
    const filas = Math.max(1, Math.ceil(n / cols));
    const dx = 7.5, dz = 7.5;
    const W = Math.max(30, cols * dx + 15), D = Math.max(24, filas * dz + 13);
    if (W !== dimSala.W || D !== dimSala.D) construirSala(W, D);
    lista.forEach((e, i) => {
      const c = i % cols, f = Math.floor(i / cols);
      const enFila = Math.min(cols, n - f * cols);
      e.destino.set(1 + (c - (enFila - 1) / 2) * dx, 0, -1 + (f - (filas - 1) / 2) * dz);
    });
    encuadre.radio = Math.max(W, D) * 0.62;
    if (!seleccionado) { cam.objetivo.set(0, 0.5, 0); cam.distDeseada = encuadre.radio * 2.3; }
  }

  function actualizar(sesiones) {
    const vivos = new Set(sesiones.map((s) => s.id));
    let cambioLista = false;
    const nuevos = [];
    for (const id of [...escritorios.keys()]) if (!vivos.has(id)) { quitarEscritorio(id); cambioLista = true; }
    for (const s of sesiones) {
      let e = escritorios.get(s.id);
      if (!e) { e = nuevoEscritorio(s); e.s = s; cambioLista = true; nuevos.push(e); }
      actualizarEscritorio(e, s);
    }
    if (cambioLista) recolocar();
    for (const e of nuevos) {
      const p = e.p;
      p.raiz.visible = true;
      if (primeraCarga || e.s.estado === 'terminada') {
        // Al abrir la oficina, cada uno ya está en su sitio.
        p.raiz.position.copy(asientoDe(e)); p.raiz.rotation.y = Math.PI; p.modo = e.s.estado === 'terminada' ? 'fuera' : 'sentado';
        if (p.modo === 'fuera') p.raiz.visible = false;
        e.g.scale.setScalar(1);
      } else {
        p.ruta = rutaEntrada(e); p.raiz.position.copy(p.ruta.shift()); p.modo = 'entrando';
        efectos.texto(dimSala.puerta.clone().add(new THREE.Vector3(1.5, 3.2, 0)), '¡Nuevo agente!', '#ffd166');
      }
    }
    primeraCarga = false;
    if (seleccionado && !escritorios.has(seleccionado)) seleccionar(null);
  }

  function seleccionar(id) {
    seleccionado = id && escritorios.has(id) ? id : null;
    escritorios.forEach((e) => { e.seleccion.material.opacity = e.id === seleccionado ? 0.95 : 0; });
    if (seleccionado) {
      const e = escritorios.get(seleccionado);
      cam.objetivo.copy(e.destino).add(new THREE.Vector3(0, 1.4, 0.6));
      cam.distDeseada = 17;
    } else {
      cam.objetivo.set(0, 0.5, 0);
      cam.distDeseada = encuadre.radio * 2.3;
    }
    interaccion();
  }

  // ---------- Cámara orbital (con paseo automático en reposo) ----------
  const cam = { theta: 0.7, phi: 0.92, dist: 60, distDeseada: 60, objetivo: new THREE.Vector3(0, 0.5, 0), centro: new THREE.Vector3(0, 0.5, 0) };
  let ultimaInteraccion = performance.now();
  const interaccion = () => { ultimaInteraccion = performance.now(); };
  const punteros = new Map();
  let pinza = 0, arrastre = 0;
  canvas.addEventListener('pointerdown', (ev) => { punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); arrastre = 0; canvas.setPointerCapture(ev.pointerId); interaccion(); });
  canvas.addEventListener('pointermove', (ev) => {
    const p = punteros.get(ev.pointerId);
    if (!p) { flotar(ev); return; }
    interaccion();
    if (punteros.size === 1) {
      cam.theta -= (ev.clientX - p.x) * 0.006;
      cam.phi = Math.max(0.35, Math.min(1.35, cam.phi - (ev.clientY - p.y) * 0.006));
      arrastre += Math.abs(ev.clientX - p.x) + Math.abs(ev.clientY - p.y);
    }
    punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (punteros.size === 2) {
      const [a, b] = [...punteros.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinza) cam.distDeseada = limitarDist(cam.distDeseada * pinza / d);
      pinza = d; arrastre = 99;
    }
  });
  canvas.addEventListener('pointerup', (ev) => { if (punteros.size === 1 && arrastre < 6) alSeleccionar(golpe(ev)); punteros.delete(ev.pointerId); pinza = 0; });
  canvas.addEventListener('pointercancel', (ev) => { punteros.delete(ev.pointerId); pinza = 0; });
  canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); interaccion(); cam.distDeseada = limitarDist(cam.distDeseada * (1 + ev.deltaY * 0.0012)); }, { passive: false });
  canvas.addEventListener('keydown', (ev) => {
    const k = ev.key; let ok = true;
    if (k === 'ArrowLeft') cam.theta += 0.12;
    else if (k === 'ArrowRight') cam.theta -= 0.12;
    else if (k === 'ArrowUp') cam.phi = Math.max(0.35, cam.phi - 0.08);
    else if (k === 'ArrowDown') cam.phi = Math.min(1.35, cam.phi + 0.08);
    else if (k === '+' || k === '=') cam.distDeseada = limitarDist(cam.distDeseada * 0.88);
    else if (k === '-') cam.distDeseada = limitarDist(cam.distDeseada * 1.12);
    else if (k === 'Escape') alSeleccionar(null);
    else ok = false;
    if (ok) { ev.preventDefault(); interaccion(); }
  });
  const limitarDist = (d) => Math.max(8, Math.min(140, d));

  const ray = new THREE.Raycaster(), puntero = new THREE.Vector2();
  function golpe(ev) {
    const r = canvas.getBoundingClientRect();
    puntero.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(puntero, camera);
    const h = ray.intersectObjects(objetivosClic, false)[0];
    return h ? h.object.userData.id : null;
  }
  function flotar(ev) { canvas.style.cursor = golpe(ev) ? 'pointer' : 'grab'; }

  function ajustarTamano() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 0.9 ? 44 : 32; // en móvil vertical, más campo de visión
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(ajustarTamano).observe(canvas);
  ajustarTamano();
  recolocar();

  // ---------- Animación ----------
  const tmp = new THREE.Vector3();
  function animarPersonaje(e, t, dt) {
    const p = e.p, s = e.s || {}, st = s.estado;
    if (!p.raiz.visible) return;
    const mov = REDUCIDO ? 0.25 : 1;
    let andando = false;

    if (p.modo === 'entrando' || p.modo === 'saliendo') {
      const destino = p.ruta[0];
      if (!destino) {
        if (p.modo === 'entrando') { p.modo = 'sentado'; }
        else { p.modo = 'fuera'; p.raiz.visible = false; efectos.chispas(dimSala.puerta.clone().setY(1.5), '#ffffff', 12); }
      } else {
        tmp.subVectors(destino, p.raiz.position); tmp.y = 0;
        const d = tmp.length(), paso = 5.2 * dt;
        if (d <= paso) { p.raiz.position.x = destino.x; p.raiz.position.z = destino.z; p.ruta.shift(); }
        else { tmp.multiplyScalar(paso / d); p.raiz.position.add(tmp); }
        const objetivoRot = Math.atan2(tmp.x, tmp.z);
        p.raiz.rotation.y = girar(p.raiz.rotation.y, objetivoRot, dt * 10);
        p.raiz.position.y = Math.abs(Math.sin(t * 11)) * 0.06 * mov;
        andando = true;
      }
    }
    if (p.modo === 'sentado') {
      p.raiz.position.lerp(asientoDe(e), 1 - Math.pow(0.0005, dt));
      p.raiz.rotation.y = girar(p.raiz.rotation.y, Math.PI, dt * 6);
    }

    // Piernas
    const sentado = p.modo === 'sentado';
    p.piernas.forEach((pi, i) => {
      const objetivo = sentado ? -Math.PI / 2 : andando ? Math.sin(t * 11 + i * Math.PI) * 0.7 * mov : 0;
      pi.rotation.x += (objetivo - pi.rotation.x) * Math.min(1, dt * 12);
    });

    // Brazos según estado
    p.saludo = Math.max(0, p.saludo - dt);
    p.brazos.forEach((br, i) => {
      let rx = 0, rz = 0;
      if (andando) rx = Math.sin(t * 11 + (i ? 0 : Math.PI)) * 0.6 * mov;
      else if (sentado) {
        if (p.saludo > 0) { rx = -Math.PI * 0.95; rz = (i ? -1 : 1) * (0.3 + Math.sin(t * 14) * 0.25 * mov); }
        else if (st === 'ejecutando') rx = -1.25 + Math.sin(t * 18 + i * 1.9) * 0.18 * mov;
        else if (st === 'esperando' && i === 1) { rx = -Math.PI * 0.95; rz = -0.2 + Math.sin(t * 6) * 0.15 * mov; }
        else if (st === 'pensando' && i === 1) { rx = -2.3; rz = 0.55; } // mano al mentón
        else if (st === 'inactivo') rx = -0.35;
        else if (st === 'guardia') { rx = i ? -2.6 : -0.3; rz = i ? 0.9 : 0; } // saludo militar
        else rx = -1.0;
      }
      br.rotation.x += (rx - br.rotation.x) * Math.min(1, dt * 10);
      br.rotation.z += ((i ? -1 : 1) * 0.08 + rz - br.rotation.z) * Math.min(1, dt * 10);
    });

    // Cabeza
    p.sacudida = Math.max(0, p.sacudida - dt * 0.8);
    let ry = 0, rxCab = 0;
    if (p.sacudida > 0) ry = Math.sin(t * 25) * 0.4 * p.sacudida;
    else if (st === 'pensando') ry = Math.sin(t * 1.2 + p.fase) * 0.35 * mov;
    else if (st === 'inactivo' && sentado) { ry = Math.sin(t * 0.4 + p.fase) * 0.5 * mov; rxCab = 0.05; }
    else if (st === 'ejecutando') rxCab = 0.12 + Math.sin(t * 4) * 0.03 * mov;
    p.cabeza.rotation.y += (ry - p.cabeza.rotation.y) * Math.min(1, dt * 8);
    p.cabeza.rotation.x += (rxCab - p.cabeza.rotation.x) * Math.min(1, dt * 8);
    p.cabeza.position.y = 1.62 + (st === 'ejecutando' ? Math.sin(t * 9 + p.fase) * 0.015 * mov : Math.sin(t * 1.8 + p.fase) * 0.012 * mov);
    p.torso.scale.y = 1 + Math.sin(t * 2 + p.fase) * 0.015 * mov; // respiración

    // Parpadeo
    p.parpadeo -= dt;
    const cerrado = p.parpadeo < 0.12;
    if (p.parpadeo < 0) p.parpadeo = 2.5 + Math.random() * 3;
    p.ojos.forEach((o) => { o.scale.y = cerrado ? 0.15 : 1; });
    p.boca.scale.set(1, st === 'error' ? -1 : 1, 1);

    // Bocadillo
    let tipo = '';
    if (p.modo === 'sentado') {
      if (st === 'pensando') tipo = 'pensando';
      else if (st === 'esperando') tipo = 'esperando';
      else if (st === 'error') tipo = 'error';
      else if (st === 'guardia') tipo = 'guardia';
      else if (st === 'inactivo' && s.ultimaActividad && Date.now() - s.ultimaActividad > 90000) tipo = 'dormido';
    }
    if (tipo === 'pensando') { const fr = Math.floor(t * 3) % 4; if (p.tipoBocadillo !== 'pensando' + fr) { pintarBocadillo(p.bocadillo, 'pensando', fr); p.tipoBocadillo = 'pensando' + fr; } }
    else if (tipo !== p.tipoBocadillo) { if (tipo) pintarBocadillo(p.bocadillo, tipo); p.tipoBocadillo = tipo; }
    p.bocadillo.visible = !!tipo;
    if (tipo) p.bocadillo.position.y = 2.35 + Math.sin(t * 3) * 0.05 * mov;
  }

  let previo = performance.now();
  function animar(ahoraMs) {
    requestAnimationFrame(animar);
    const dt = Math.min((ahoraMs - previo) / 1000, 0.05); previo = ahoraMs;
    const t = ahoraMs / 1000;
    const mov = REDUCIDO ? 0 : 1;

    escritorios.forEach((e) => {
      e.g.position.lerp(e.destino, 1 - Math.pow(0.001, dt));
      const sc = e.g.scale.x;
      if (sc < 1) e.g.scale.setScalar(Math.min(1, sc + (1.08 - sc) * dt * 6)); // aparece con un "pop"
      const st = e.s ? e.s.estado : 'inactivo';
      // Anillo: pulso según estado
      let op = 0.9;
      if (st === 'esperando' || st === 'error') op = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 6));
      else if (st === 'guardia') op = 0.5 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2));
      else if (st === 'inactivo' || st === 'terminada') op = 0.45;
      e.anillo.material.opacity = REDUCIDO ? 0.85 : op;
      e.anillo.scale.setScalar(st === 'ejecutando' ? 1 + Math.sin(t * 5) * 0.02 * mov : 1);
      e.matPantalla.color.setScalar(st === 'inactivo' ? 0.75 : st === 'terminada' ? 0.35 : 1);
      if (e.sobre.visible) e.sobre.position.y = 2.75 + Math.sin(t * 3) * 0.1 * mov;
      // Código que sale del monitor mientras trabaja
      if (st === 'ejecutando' && !REDUCIDO && t - e.ultimaParticula > 0.28) {
        e.ultimaParticula = t;
        efectos.codigo(tmp.set(e.g.position.x + (Math.random() - 0.5) * 1.6, 2.5, e.g.position.z - 0.45));
      }
      // Robots de subagentes orbitando
      e.robots.forEach((r, i) => {
        const a = t * 0.9 + r.fase + (i / Math.max(1, e.robots.length)) * Math.PI * 2;
        r.g.position.set(e.g.position.x + Math.cos(a) * 2.1, 2.2 + Math.sin(t * 3 + i) * 0.15 * mov, e.g.position.z + 0.4 + Math.sin(a) * 2.1);
        r.g.rotation.y = -a;
        r.g.userData.helice.rotation.y += dt * 25;
      });
      animarPersonaje(e, t, dt);
    });

    efectos.actualizar(dt, camera);

    // Paseo automático de cámara tras 30 s sin tocar nada
    if (!REDUCIDO && performance.now() - ultimaInteraccion > 30000 && !seleccionado) cam.theta += dt * 0.05;
    cam.centro.lerp(cam.objetivo, 1 - Math.pow(0.02, dt));
    cam.dist += (cam.distDeseada - cam.dist) * Math.min(1, dt * 3);
    camera.position.set(
      cam.centro.x + cam.dist * Math.sin(cam.phi) * Math.sin(cam.theta),
      cam.centro.y + cam.dist * Math.cos(cam.phi),
      cam.centro.z + cam.dist * Math.sin(cam.phi) * Math.cos(cam.theta));
    camera.lookAt(cam.centro);
    if (paredes.fondo) {
      paredes.fondo.visible = camera.position.z > -dimSala.D / 2 + 0.5;
      paredes.izq.visible = camera.position.x > -dimSala.W / 2 + 0.5;
    }
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animar);

  // ---------- Texturas de la sala ----------
  function pintarCielo() {
    const c = cielo.ctx, W = 256, H = 256, hora = new Date().getHours() + new Date().getMinutes() / 60;
    let arriba, abajo;
    if (hora >= 7 && hora < 17) { arriba = '#5fa8ff'; abajo = '#bde0fe'; }
    else if (hora >= 17 && hora < 19.5) { arriba = '#6d597a'; abajo = '#ffb4a2'; }
    else if (hora >= 5.5 && hora < 7) { arriba = '#8ecae6'; abajo = '#ffd6a5'; }
    else { arriba = '#0b132b'; abajo = '#1c2541'; }
    const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, arriba); g.addColorStop(1, abajo);
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const noche = hora < 5.5 || hora >= 19.5;
    if (noche) { c.fillStyle = '#ffffff'; for (let i = 0; i < 40; i++) c.fillRect(Math.random() * W, Math.random() * H * 0.7, 2, 2); c.fillStyle = '#fefae0'; c.beginPath(); c.arc(190, 60, 22, 0, Math.PI * 2); c.fill(); }
    else { c.fillStyle = 'rgba(255,255,255,0.9)'; [[60, 70, 30], [90, 62, 24], [170, 110, 28], [195, 104, 20]].forEach(([x, y, r]) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); }); }
    // Ciudad al fondo
    c.fillStyle = noche ? '#14213d' : '#8d99ae';
    for (let x = 0; x < W; x += 28) { const h = 40 + ((x * 37) % 70); c.fillRect(x, H - h, 24, h); }
    if (noche) { c.fillStyle = '#ffd166'; for (let x = 4; x < W; x += 28) for (let y = H - 30; y > H - 90; y -= 14) if ((x * y) % 3 === 0) c.fillRect(x, y, 5, 6); }
    cielo.tex.needsUpdate = true;
  }

  function pintarReloj() {
    const c = reloj.ctx, ahora = new Date();
    c.clearRect(0, 0, 256, 256);
    c.fillStyle = '#ffffff'; c.beginPath(); c.arc(128, 128, 120, 0, Math.PI * 2); c.fill();
    c.lineWidth = 12; c.strokeStyle = '#e76f51'; c.stroke();
    c.fillStyle = '#2b2d42';
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; c.beginPath(); c.arc(128 + Math.sin(a) * 92, 128 - Math.cos(a) * 92, i % 3 === 0 ? 8 : 4, 0, Math.PI * 2); c.fill(); }
    const aguja = (ang, largo, ancho, col) => { c.strokeStyle = col; c.lineWidth = ancho; c.lineCap = 'round'; c.beginPath(); c.moveTo(128, 128); c.lineTo(128 + Math.sin(ang) * largo, 128 - Math.cos(ang) * largo); c.stroke(); };
    const h = ahora.getHours() % 12, m = ahora.getMinutes();
    aguja(((h + m / 60) / 12) * Math.PI * 2, 55, 12, '#2b2d42');
    aguja((m / 60) * Math.PI * 2, 85, 7, '#2b2d42');
    c.fillStyle = '#e76f51'; c.beginPath(); c.arc(128, 128, 10, 0, Math.PI * 2); c.fill();
    reloj.tex.needsUpdate = true;
  }

  return { actualizar, seleccionar };
}

// ---------- Efectos de juego: código flotante, confeti, chispas y textos ----------
function crearEfectos(scene) {
  const vivos = [];
  const glifos = ['{ }', '</>', '01', '=>', 'fn', '[ ]', ';', '++', '#!', '&&'].map((txt, i) => {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
    const c = cv.getContext('2d');
    c.font = '700 40px ' + MONO; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = i % 3 === 0 ? '#2ee59d' : i % 3 === 1 ? '#4ea1ff' : '#c9a6ff';
    c.shadowColor = c.fillStyle; c.shadowBlur = 10;
    c.fillText(txt, 64, 34);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
  const geoConfeti = new THREE.PlaneGeometry(0.12, 0.2);
  const geoChispa = new THREE.OctahedronGeometry(0.07, 0);

  function codigo(pos) {
    if (vivos.length > 260) return;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glifos[Math.floor(Math.random() * glifos.length)], transparent: true, depthWrite: false, toneMapped: false }));
    sp.scale.set(0.7, 0.35, 1); sp.position.copy(pos);
    scene.add(sp);
    vivos.push({ o: sp, vida: 1.5, total: 1.5, vel: new THREE.Vector3((Math.random() - 0.5) * 0.3, 1.1, (Math.random() - 0.5) * 0.3), tipo: 'sprite' });
  }

  function confeti(pos, colores = ['#ff6b6b', '#ffd166', '#06d6a0', '#4ea1ff', '#c77dff', '#ff9f1c']) {
    for (let i = 0; i < 45; i++) {
      const m = new THREE.Mesh(geoConfeti, new THREE.MeshBasicMaterial({ color: colores[i % colores.length], side: THREE.DoubleSide, transparent: true }));
      m.position.copy(pos);
      const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 2.5;
      scene.add(m);
      vivos.push({ o: m, vida: 2.2, total: 2.2, vel: new THREE.Vector3(Math.cos(a) * v * 0.6, 3 + Math.random() * 3, Math.sin(a) * v * 0.6), giro: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10), gravedad: 7, tipo: 'malla' });
    }
  }

  function chispas(pos, color, n = 20) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geoChispa, new THREE.MeshBasicMaterial({ color, transparent: true, toneMapped: false }));
      m.position.copy(pos);
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 2);
      scene.add(m);
      vivos.push({ o: m, vida: 0.9, total: 0.9, vel: dir, giro: new THREE.Vector3(5, 7, 3), gravedad: 2, tipo: 'malla' });
    }
  }

  function texto(pos, contenido, color) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false, toneMapped: false, sizeAttenuation: false }));
    repintarEtiqueta(sp, contenido, { tam: 44, color, fondo: false, contorno: true, fijo: true, px: 34 });
    // Si ya hay textos flotando en ese sitio, el nuevo se apila encima.
    const cerca = vivos.filter((v) => v.tipo === 'texto' && v.o.position.distanceTo(pos) < 2.5).length;
    sp.position.copy(pos).add(new THREE.Vector3(0, cerca * 0.7, 0)); sp.renderOrder = 10;
    scene.add(sp);
    vivos.push({ o: sp, vida: 2.2, total: 2.2, vel: new THREE.Vector3(0, 0.9, 0), tipo: 'texto', escalaBase: sp.scale.clone() });
  }

  function actualizar(dt) {
    for (let i = vivos.length - 1; i >= 0; i--) {
      const v = vivos[i];
      v.vida -= dt;
      if (v.vida <= 0) {
        scene.remove(v.o);
        if (v.tipo === 'texto') v.o.material.map.dispose();
        v.o.material.dispose();
        vivos.splice(i, 1);
        continue;
      }
      if (v.gravedad) v.vel.y -= v.gravedad * dt;
      v.o.position.addScaledVector(v.vel, dt);
      if (v.giro) { v.o.rotation.x += v.giro.x * dt; v.o.rotation.y += v.giro.y * dt; v.o.rotation.z += v.giro.z * dt; }
      if (v.tipo === 'malla' && v.o.position.y < 0.05) { v.o.position.y = 0.05; v.vel.set(0, 0, 0); v.giro = null; }
      const k = v.vida / v.total;
      v.o.material.opacity = Math.min(1, k * 2.5);
      if (v.tipo === 'texto') {
        const pop = 1 + Math.max(0, (k - 0.85) * 4);
        v.o.scale.copy(v.escalaBase).multiplyScalar(pop);
      }
    }
  }

  return { codigo, confeti, chispas, texto, actualizar };
}

// ---------- Utilidades de texto y texturas ----------
function lienzoTextura(w, h) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  return { cv, ctx: cv.getContext('2d'), tex };
}

function fondoDegradado() {
  const { ctx, tex } = lienzoTextura(4, 256);
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#1d2b53'); g.addColorStop(0.6, '#2a1b3d'); g.addColorStop(1, '#120d1f');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 256);
  return tex;
}

function texturaMadera() {
  const { cv, ctx: c, tex } = lienzoTextura(256, 256);
  const tonos = ['#d4a373', '#c99566', '#ddb07f', '#c78f5c'];
  for (let i = 0; i < 8; i++) {
    c.fillStyle = tonos[i % tonos.length]; c.fillRect(0, i * 32, 256, 32);
    c.fillStyle = 'rgba(80,50,30,0.35)'; c.fillRect(0, i * 32 + 31, 256, 1);
    const corte = ((i * 97) % 200) + 20; c.fillRect(corte, i * 32, 1, 32);
    c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(0, i * 32 + 4, 256, 3);
  }
  void cv;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function texturaPizarra() {
  const { ctx: c, tex } = lienzoTextura(512, 272);
  c.lineCap = 'round'; c.lineWidth = 5;
  c.strokeStyle = '#1d3557'; c.font = '700 34px ' + SANS; c.fillStyle = '#1d3557';
  c.fillText('Sprint', 24, 50);
  c.strokeStyle = '#e63946'; c.strokeRect(30, 80, 120, 60); c.strokeRect(220, 80, 120, 60); c.strokeRect(380, 160, 110, 60);
  c.beginPath(); c.moveTo(150, 110); c.lineTo(220, 110); c.moveTo(340, 110); c.lineTo(430, 160); c.stroke();
  c.strokeStyle = '#2a9d8f'; c.beginPath(); c.moveTo(30, 240); for (let x = 30; x < 330; x += 30) c.lineTo(x, 240 - (x - 30) * 0.25 - Math.sin(x) * 10); c.stroke();
  c.fillStyle = '#2a9d8f'; c.font = '600 26px ' + SANS; c.fillText('✔ tests', 380, 250);
  return tex;
}

function pintarBocadillo(sp, tipo, frame = 0) {
  const cv = document.createElement('canvas'); cv.width = 160; cv.height = 128;
  const c = cv.getContext('2d');
  const estilos = { pensando: ['#ffffff', '#4ea1ff'], esperando: ['#ffb545', '#3d2600'], error: ['#ff4d6d', '#ffffff'], guardia: ['#c9a6ff', '#1d0f3a'], dormido: ['#e0e7ff', '#3d5a80'] };
  const [fondo, tinta] = estilos[tipo] || estilos.pensando;
  c.fillStyle = fondo; c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 4;
  c.beginPath(); c.roundRect(8, 8, 144, 84, 28); c.fill(); c.stroke();
  if (tipo === 'pensando') { c.beginPath(); c.arc(40, 104, 9, 0, Math.PI * 2); c.arc(24, 120, 5, 0, Math.PI * 2); c.fill(); }
  else { c.beginPath(); c.moveTo(34, 88); c.lineTo(22, 120); c.lineTo(58, 90); c.closePath(); c.fill(); }
  c.fillStyle = tinta; c.textAlign = 'center'; c.textBaseline = 'middle';
  if (tipo === 'pensando') { for (let i = 0; i < 3; i++) { c.globalAlpha = i < frame ? 1 : 0.25; c.beginPath(); c.arc(52 + i * 28, 50, 10, 0, Math.PI * 2); c.fill(); } c.globalAlpha = 1; }
  else if (tipo === 'esperando') { c.font = '900 64px ' + SANS; c.fillText('?', 80, 54); }
  else if (tipo === 'error') { c.font = '900 64px ' + SANS; c.fillText('!', 80, 54); }
  else if (tipo === 'guardia') { c.beginPath(); c.moveTo(80, 22); c.lineTo(108, 32); c.lineTo(104, 62); c.quadraticCurveTo(96, 80, 80, 86); c.quadraticCurveTo(64, 80, 56, 62); c.lineTo(52, 32); c.closePath(); c.fill(); }
  else if (tipo === 'dormido') { c.font = '800 34px ' + SANS; c.fillText('z', 58, 62); c.font = '800 46px ' + SANS; c.fillText('Z', 96, 46); }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  if (sp.material.map) sp.material.map.dispose();
  sp.material.map = tex; sp.material.needsUpdate = true;
  sp.scale.set(0.95, 0.76, 1);
}

function recortar(c, texto, max) {
  let t = String(texto || '');
  if (c.measureText(t).width <= max) return t;
  while (t.length > 1 && c.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function parrafo(c, texto, x, y, ancho, alto, maxLineas) {
  const palabras = String(texto || '').split(/(\s+|(?<=\/))/).filter(Boolean);
  let linea = '', n = 0;
  for (const p of palabras) {
    const prueba = linea + p;
    if (c.measureText(prueba).width > ancho && linea) {
      if (++n >= maxLineas) { c.fillText(recortar(c, linea + '…', ancho), x, y); return y + alto; }
      c.fillText(linea.trimEnd(), x, y); y += alto; linea = p.trimStart();
    } else linea = prueba;
  }
  if (linea) { c.fillText(recortar(c, linea, ancho), x, y); y += alto; }
  return y;
}

function etiqueta(texto, opts = {}) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false, sizeAttenuation: !opts.fijo }));
  repintarEtiqueta(sp, texto, opts);
  return sp;
}

function repintarEtiqueta(sp, texto, opts = {}) {
  const tam = opts.tam || 34, pad = 22;
  const cv = document.createElement('canvas');
  let c = cv.getContext('2d');
  c.font = '800 ' + tam + 'px ' + SANS;
  cv.width = Math.max(64, Math.ceil(c.measureText(texto).width) + pad * 2);
  cv.height = Math.ceil(tam * 1.75);
  c = cv.getContext('2d');
  if (opts.fondo !== false) {
    c.fillStyle = opts.fondoColor || 'rgba(43,45,66,0.92)';
    c.beginPath(); c.roundRect(2, 2, cv.width - 4, cv.height - 4, cv.height / 2); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 3; c.stroke();
  }
  c.font = '800 ' + tam + 'px ' + SANS;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  if (opts.contorno) { c.lineWidth = 8; c.strokeStyle = 'rgba(16,19,28,0.9)'; c.lineJoin = 'round'; c.strokeText(texto, cv.width / 2, cv.height / 2 + 1); }
  c.fillStyle = opts.colorTexto || opts.color || '#ffffff';
  c.fillText(texto, cv.width / 2, cv.height / 2 + 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (sp.material.map) sp.material.map.dispose();
  sp.material.map = tex; sp.material.needsUpdate = true;
  // fijo: tamaño constante en pantalla (como el HUD de un juego), en píxeles de alto aprox.
  const esc = opts.fijo ? (opts.px || 24) / 1400 / cv.height : (opts.escala || 0.0085);
  sp.scale.set(cv.width * esc, cv.height * esc, 1);
}

function girar(actual, objetivo, k) {
  let d = objetivo - actual;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return actual + d * Math.min(1, k);
}
