// Oficina 3D: un escritorio por sesión de Claude Code, con su avatar, su monitor y su estado.
import * as THREE from '/vendor/three/three.module.js';

export const COLORES = {
  inactivo: '#6b7a96', pensando: '#4ea1ff', ejecutando: '#3ddc97', esperando: '#ffb545',
  guardia: '#c9a6ff', error: '#ff4d6d', terminada: '#34405a'
};
export const NOMBRES = {
  inactivo: 'Inactivo', pensando: 'Pensando', ejecutando: 'Trabajando', esperando: 'Espera tu aprobación',
  guardia: 'En guardia: espera órdenes', error: 'Error', terminada: 'Sesión terminada'
};

const MONO = '"JetBrains Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace';
const SANS = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const REDUCIDO = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function crearEscena(canvas, { alSeleccionar }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b0f17');
  scene.fog = new THREE.Fog('#0b0f17', 45, 110);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);

  scene.add(new THREE.HemisphereLight('#a9bde6', '#0b0f17', 1.1));
  const sol = new THREE.DirectionalLight('#ffffff', 1.4);
  sol.position.set(12, 25, 14);
  scene.add(sol);

  // ---------- Sala ----------
  const sala = new THREE.Group();
  scene.add(sala);
  const suelo = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: '#141c2c', roughness: 0.95 }));
  suelo.rotation.x = -Math.PI / 2;
  sala.add(suelo);
  const rejilla = new THREE.GridHelper(160, 80, '#1f2a40', '#161f31');
  rejilla.position.y = 0.01;
  sala.add(rejilla);
  const paredMat = new THREE.MeshStandardMaterial({ color: '#151d2e', roughness: 0.9 });
  const tiraMat = new THREE.MeshBasicMaterial({ color: '#c9a6ff', toneMapped: false });
  const fondo = new THREE.Mesh(new THREE.BoxGeometry(1, 4.5, 0.3), paredMat);
  const tira = new THREE.Mesh(new THREE.BoxGeometry(1, 0.06, 0.05), tiraMat);
  sala.add(fondo, tira);
  const rotulo = etiqueta('OFICINA IA', { tam: 64, color: '#c9a6ff', fondo: false, escala: 0.016 });
  sala.add(rotulo);

  function ajustarSala(ancho, fondoZ) {
    const w = Math.max(24, ancho + 14);
    fondo.scale.x = w; fondo.position.set(0, 2.25, fondoZ - 5);
    tira.scale.x = w; tira.position.set(0, 3.7, fondoZ - 4.83);
    rotulo.position.set(0, 5.4, fondoZ - 5);
  }

  // ---------- Escritorios ----------
  const escritorios = new Map(); // id -> objeto escritorio
  const objetivosClic = [];
  let seleccionado = null;

  const matMesa = new THREE.MeshStandardMaterial({ color: '#2a3550', roughness: 0.6, metalness: 0.2 });
  const matPata = new THREE.MeshStandardMaterial({ color: '#1b2336', roughness: 0.8 });
  const matMarco = new THREE.MeshStandardMaterial({ color: '#0f1522', roughness: 0.4, metalness: 0.5 });
  const matSilla = new THREE.MeshStandardMaterial({ color: '#232c42', roughness: 0.8 });
  const geoPata = new THREE.BoxGeometry(0.1, 1, 0.1);

  function nuevoEscritorio(s) {
    const g = new THREE.Group();
    const e = { id: s.id, g, firmaPantalla: '', firmaEtiqueta: '', fase: Math.random() * 10, destino: new THREE.Vector3(), drones: [] };

    const mesa = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 1.6), matMesa);
    mesa.position.y = 1.0;
    g.add(mesa);
    [[-1.5, -0.7], [1.5, -0.7], [-1.5, 0.7], [1.5, 0.7]].forEach(([x, z]) => {
      const p = new THREE.Mesh(geoPata, matPata); p.position.set(x, 0.5, z); g.add(p);
    });

    // Monitor con lienzo dinámico
    const marco = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.25, 0.08), matMarco);
    marco.position.set(0, 1.8, -0.45);
    g.add(marco);
    const pie = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.12), matMarco);
    pie.position.set(0, 1.2, -0.45);
    g.add(pie);
    e.lienzo = document.createElement('canvas');
    e.lienzo.width = 640; e.lienzo.height = 384;
    e.textura = new THREE.CanvasTexture(e.lienzo);
    e.textura.colorSpace = THREE.SRGBColorSpace;
    e.textura.anisotropy = 4;
    e.matPantalla = new THREE.MeshBasicMaterial({ map: e.textura, toneMapped: false });
    const pantalla = new THREE.Mesh(new THREE.PlaneGeometry(1.88, 1.13), e.matPantalla);
    pantalla.position.set(0, 1.8, -0.405);
    g.add(pantalla);

    const teclado = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.3), matMarco);
    teclado.position.set(0, 1.08, 0.25);
    g.add(teclado);

    // Silla
    const asiento = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 0.8), matSilla);
    asiento.position.set(0, 0.62, 1.25);
    const respaldo = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.9, 0.1), matSilla);
    respaldo.position.set(0, 1.1, 1.65);
    const columna = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6), matPata);
    columna.position.set(0, 0.3, 1.25);
    g.add(asiento, respaldo, columna);

    // Avatar
    e.matCuerpo = new THREE.MeshStandardMaterial({ color: '#d7deeb', roughness: 0.45, metalness: 0.1, emissive: '#000000' });
    e.cuerpo = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.55, 6, 14), e.matCuerpo);
    e.cuerpo.position.set(0, 1.2, 1.15);
    e.cabeza = new THREE.Mesh(new THREE.SphereGeometry(0.25, 20, 16), e.matCuerpo);
    e.cabeza.position.set(0, 1.85, 1.1);
    e.visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 0.05), new THREE.MeshBasicMaterial({ color: '#4ea1ff', toneMapped: false }));
    e.visor.position.set(0, 1.88, 0.86);
    const geoBrazo = new THREE.BoxGeometry(0.12, 0.12, 0.55);
    e.brazoI = new THREE.Mesh(geoBrazo, e.matCuerpo);
    e.brazoD = new THREE.Mesh(geoBrazo, e.matCuerpo);
    e.brazoI.position.set(-0.32, 1.2, 0.7);
    e.brazoD.position.set(0.32, 1.2, 0.7);
    g.add(e.cuerpo, e.cabeza, e.visor, e.brazoI, e.brazoD);

    // Halo (pensando) y anillo de estado en el suelo
    e.halo = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.03, 8, 40), new THREE.MeshBasicMaterial({ color: COLORES.pensando, transparent: true, opacity: 0, toneMapped: false }));
    e.halo.rotation.x = Math.PI / 2;
    e.halo.position.set(0, 2.25, 1.1);
    g.add(e.halo);
    e.anillo = new THREE.Mesh(new THREE.RingGeometry(2.05, 2.2, 64), new THREE.MeshBasicMaterial({ color: COLORES.inactivo, transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false }));
    e.anillo.rotation.x = -Math.PI / 2; e.anillo.position.y = 0.02;
    e.charco = new THREE.Mesh(new THREE.CircleGeometry(2.05, 48), new THREE.MeshBasicMaterial({ color: COLORES.inactivo, transparent: true, opacity: 0.08, depthWrite: false, toneMapped: false }));
    e.charco.rotation.x = -Math.PI / 2; e.charco.position.y = 0.015;
    e.seleccion = new THREE.Mesh(new THREE.RingGeometry(2.35, 2.42, 64), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, side: THREE.DoubleSide, toneMapped: false }));
    e.seleccion.rotation.x = -Math.PI / 2; e.seleccion.position.y = 0.025;
    g.add(e.anillo, e.charco, e.seleccion);

    // Etiqueta flotante y sobre de órdenes pendientes
    e.etiqueta = etiqueta(' ', { tam: 34 });
    e.etiqueta.position.set(0, 3.05, -0.45);
    g.add(e.etiqueta);
    e.sobre = etiqueta('✉', { tam: 40, color: '#140b2a', fondoColor: '#c9a6ff' });
    e.sobre.position.set(1.4, 2.6, -0.45);
    e.sobre.visible = false;
    g.add(e.sobre);

    e.drones = [];
    e.grupoDrones = new THREE.Group();
    e.grupoDrones.position.set(0, 2.55, 0.4);
    g.add(e.grupoDrones);

    // Zona de clic (transparente)
    const clic = new THREE.Mesh(new THREE.BoxGeometry(4.4, 3.4, 4.2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    clic.position.set(0, 1.6, 0.4);
    clic.userData.id = s.id;
    g.add(clic);
    objetivosClic.push(clic);
    e.clic = clic;

    g.scale.setScalar(0.01);
    scene.add(g);
    escritorios.set(s.id, e);
    return e;
  }

  function quitarEscritorio(id) {
    const e = escritorios.get(id);
    if (!e) return;
    scene.remove(e.g);
    e.g.traverse((o) => {
      if (o.geometry && o.geometry !== geoPata) o.geometry.dispose();
      if (o.material && ![matMesa, matPata, matMarco, matSilla].includes(o.material)) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    objetivosClic.splice(objetivosClic.indexOf(e.clic), 1);
    escritorios.delete(id);
  }

  function pintarPantalla(e, s) {
    const pend = s.ordenes.filter((o) => o.estado === 'pendiente').length;
    const firma = [s.proyecto, s.estado, s.herramienta, s.detalle, s.permiso, pend, s.subagentes.length, s.ultimoPrompt].join('|');
    if (firma === e.firmaPantalla) return;
    e.firmaPantalla = firma;
    const c = e.lienzo.getContext('2d'), W = e.lienzo.width, H = e.lienzo.height;
    const color = COLORES[s.estado] || COLORES.inactivo;
    c.fillStyle = s.estado === 'terminada' ? '#05070c' : '#0a1220';
    c.fillRect(0, 0, W, H);
    if (s.estado === 'terminada') return void (e.textura.needsUpdate = true);
    c.fillStyle = '#121c30'; c.fillRect(0, 0, W, 54);
    c.fillStyle = color; c.fillRect(0, 54, W, 4);
    c.font = '600 28px ' + MONO; c.fillStyle = '#e6ecf5'; c.textBaseline = 'middle';
    c.fillText(recortar(c, s.proyecto, W - 40), 20, 28);
    c.font = '600 26px ' + SANS; c.fillStyle = color;
    c.fillText(NOMBRES[s.estado] || s.estado, 20, 92);
    let y = 140;
    c.font = '500 24px ' + MONO;
    if (s.estado === 'esperando' && s.permiso) {
      c.fillStyle = '#ffb545'; y = parrafo(c, s.permiso, 20, y, W - 40, 30, 4);
    } else if (s.herramienta) {
      c.fillStyle = '#e6ecf5'; c.font = '700 30px ' + MONO; c.fillText(s.herramienta, 20, y); y += 40;
      c.font = '400 23px ' + MONO; c.fillStyle = '#b9c4d8'; y = parrafo(c, s.detalle, 20, y, W - 40, 30, 4);
    } else if (s.ultimoPrompt) {
      c.fillStyle = '#8a97ad'; c.font = '400 23px ' + SANS; y = parrafo(c, '«' + s.ultimoPrompt + '»', 20, y, W - 40, 30, 5);
    }
    c.font = '600 22px ' + SANS;
    const pie = [];
    if (s.subagentes.length) pie.push(s.subagentes.length + (s.subagentes.length === 1 ? ' subagente' : ' subagentes'));
    if (pend) pie.push('✉ ' + pend + (pend === 1 ? ' orden pendiente' : ' órdenes pendientes'));
    if (pie.length) { c.fillStyle = '#c9a6ff'; c.fillText(pie.join(' · '), 20, H - 26); }
    e.textura.needsUpdate = true;
  }

  function actualizarEscritorio(e, s) {
    e.s = s;
    pintarPantalla(e, s);
    const color = new THREE.Color(COLORES[s.estado] || COLORES.inactivo);
    e.anillo.material.color.copy(color);
    e.charco.material.color.copy(color);
    e.visor.material.color.copy(color);
    e.matCuerpo.emissive.copy(color).multiplyScalar(s.estado === 'inactivo' || s.estado === 'terminada' ? 0 : 0.18);
    const textoEtq = s.proyecto + '  ·  ' + (NOMBRES[s.estado] || s.estado);
    if (textoEtq !== e.firmaEtiqueta) {
      e.firmaEtiqueta = textoEtq;
      repintarEtiqueta(e.etiqueta, textoEtq, { tam: 34, color: COLORES[s.estado] });
    }
    const pend = s.ordenes.filter((o) => o.estado === 'pendiente').length;
    e.sobre.visible = pend > 0;
    // Drones = subagentes
    while (e.drones.length < s.subagentes.length) {
      const d = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), new THREE.MeshStandardMaterial({ color: '#e6ecf5', emissive: '#3ddc97', emissiveIntensity: 0.6 }));
      e.grupoDrones.add(d); e.drones.push(d);
    }
    while (e.drones.length > s.subagentes.length) {
      const d = e.drones.pop(); e.grupoDrones.remove(d); d.geometry.dispose(); d.material.dispose();
    }
    e.drones.forEach((d, i) => d.material.emissive.set(COLORES[s.subagentes[i].estado] || COLORES.pensando));
  }

  // Distribuye los escritorios en una cuadrícula centrada.
  function recolocar() {
    const lista = [...escritorios.values()].sort((a, b) => (a.s.inicio || 0) - (b.s.inicio || 0));
    const n = lista.length;
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(n))));
    const filas = Math.ceil(n / cols);
    const dx = 7, dz = 7;
    lista.forEach((e, i) => {
      const c = i % cols, f = Math.floor(i / cols);
      const enFila = Math.min(cols, n - f * cols);
      e.destino.set((c - (enFila - 1) / 2) * dx, 0, (f - (filas - 1) / 2) * dz);
    });
    ajustarSala((cols - 1) * dx, -((filas - 1) / 2) * dz - 2);
    encuadre.radio = Math.max(14, Math.max(cols * dx, filas * dz) * 1.1);
    if (!seleccionado) { cam.objetivo.set(0, 1.2, 0); cam.distDeseada = encuadre.radio + 6; }
  }
  const encuadre = { radio: 14 };

  // ---------- API pública ----------
  function actualizar(sesiones) {
    const vivos = new Set(sesiones.map((s) => s.id));
    let cambioLista = false;
    for (const id of [...escritorios.keys()]) if (!vivos.has(id)) { quitarEscritorio(id); cambioLista = true; }
    for (const s of sesiones) {
      let e = escritorios.get(s.id);
      if (!e) { e = nuevoEscritorio(s); cambioLista = true; }
      actualizarEscritorio(e, s);
    }
    if (cambioLista) recolocar();
    if (seleccionado && !escritorios.has(seleccionado)) seleccionar(null);
  }

  function seleccionar(id) {
    seleccionado = id && escritorios.has(id) ? id : null;
    escritorios.forEach((e) => { e.seleccion.material.opacity = e.id === seleccionado ? 0.9 : 0; });
    if (seleccionado) {
      const e = escritorios.get(seleccionado);
      cam.objetivo.copy(e.destino).add(new THREE.Vector3(0, 1.5, 0));
      cam.distDeseada = 13;
    } else {
      cam.objetivo.set(0, 1.2, 0);
      cam.distDeseada = encuadre.radio + 6;
    }
  }

  // ---------- Cámara orbital ----------
  const cam = { theta: 0.5, phi: 1.0, dist: 26, distDeseada: 26, objetivo: new THREE.Vector3(0, 1.2, 0), centro: new THREE.Vector3(0, 1.2, 0) };
  const punteros = new Map();
  let pinza = 0, arrastre = 0;
  canvas.addEventListener('pointerdown', (ev) => { punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); arrastre = 0; canvas.setPointerCapture(ev.pointerId); });
  canvas.addEventListener('pointermove', (ev) => {
    const p = punteros.get(ev.pointerId);
    if (!p) { flotar(ev); return; }
    if (punteros.size === 1) {
      cam.theta -= (ev.clientX - p.x) * 0.006;
      cam.phi = Math.max(0.3, Math.min(1.45, cam.phi - (ev.clientY - p.y) * 0.006));
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
  const soltar = (ev) => {
    if (punteros.size === 1 && arrastre < 6) clic(ev);
    punteros.delete(ev.pointerId); pinza = 0;
  };
  canvas.addEventListener('pointerup', soltar);
  canvas.addEventListener('pointercancel', (ev) => { punteros.delete(ev.pointerId); pinza = 0; });
  canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); cam.distDeseada = limitarDist(cam.distDeseada * (1 + ev.deltaY * 0.0012)); }, { passive: false });
  canvas.addEventListener('keydown', (ev) => {
    const k = ev.key; let ok = true;
    if (k === 'ArrowLeft') cam.theta += 0.12;
    else if (k === 'ArrowRight') cam.theta -= 0.12;
    else if (k === 'ArrowUp') cam.phi = Math.max(0.3, cam.phi - 0.08);
    else if (k === 'ArrowDown') cam.phi = Math.min(1.45, cam.phi + 0.08);
    else if (k === '+' || k === '=') cam.distDeseada = limitarDist(cam.distDeseada * 0.88);
    else if (k === '-') cam.distDeseada = limitarDist(cam.distDeseada * 1.12);
    else if (k === 'Escape') alSeleccionar(null);
    else ok = false;
    if (ok) ev.preventDefault();
  });
  function limitarDist(d) { return Math.max(6, Math.min(90, d)); }

  const ray = new THREE.Raycaster();
  const puntero = new THREE.Vector2();
  function golpe(ev) {
    const r = canvas.getBoundingClientRect();
    puntero.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(puntero, camera);
    const h = ray.intersectObjects(objetivosClic, false)[0];
    return h ? h.object.userData.id : null;
  }
  function clic(ev) { alSeleccionar(golpe(ev)); }
  function flotar(ev) { canvas.style.cursor = golpe(ev) ? 'pointer' : 'grab'; }

  function ajustarTamano() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(ajustarTamano).observe(canvas);
  ajustarTamano();
  recolocar();

  // ---------- Bucle ----------
  let previo = performance.now();
  function animar(ahoraMs) {
    requestAnimationFrame(animar);
    const dt = Math.min((ahoraMs - previo) / 1000, 0.05); previo = ahoraMs;
    const t = ahoraMs / 1000;
    const mov = REDUCIDO ? 0 : 1;

    escritorios.forEach((e) => {
      e.g.position.lerp(e.destino, 1 - Math.pow(0.001, dt));
      const esc = e.g.scale.x + (1 - e.g.scale.x) * Math.min(1, dt * 5);
      e.g.scale.setScalar(esc);
      const s = e.s, st = s ? s.estado : 'inactivo';
      const trabajando = st === 'ejecutando';
      // Brazos que teclean
      e.brazoI.position.y = 1.2 + (trabajando ? Math.sin(t * 16 + e.fase) * 0.05 * mov : 0);
      e.brazoD.position.y = 1.2 + (trabajando ? Math.sin(t * 16 + e.fase + 1.7) * 0.05 * mov : 0);
      e.cabeza.position.y = 1.85 + (trabajando ? Math.sin(t * 4 + e.fase) * 0.02 * mov : 0);
      e.cabeza.rotation.y = st === 'pensando' ? Math.sin(t * 1.3 + e.fase) * 0.35 * mov : 0;
      // Halo al pensar
      const haloObj = st === 'pensando' ? 0.9 : 0;
      e.halo.material.opacity += (haloObj - e.halo.material.opacity) * Math.min(1, dt * 6);
      e.halo.rotation.z += dt * 2 * mov;
      // Anillo: parpadea si espera aprobación o hay error; pulso lento en guardia
      let op = 0.75;
      if (st === 'esperando' || st === 'error') op = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 6));
      else if (st === 'guardia') op = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2));
      else if (st === 'inactivo' || st === 'terminada') op = 0.35;
      e.anillo.material.opacity = REDUCIDO ? 0.8 : op;
      e.charco.material.opacity = trabajando ? 0.14 : 0.06;
      e.matPantalla.color.setScalar(st === 'inactivo' ? 0.7 : st === 'terminada' ? 0.4 : 1);
      // Sobre de órdenes pendientes
      if (e.sobre.visible) e.sobre.position.y = 2.6 + Math.sin(t * 3) * 0.08 * mov;
      // Drones de subagentes
      e.drones.forEach((d, i) => {
        const a = t * 1.2 * (mov || 0.0001) + (i / e.drones.length) * Math.PI * 2;
        d.position.set(Math.cos(a) * 0.9, Math.sin(t * 2 + i) * 0.1 * mov, Math.sin(a) * 0.9);
        d.rotation.y += dt * 2;
      });
    });

    cam.centro.lerp(cam.objetivo, 1 - Math.pow(0.02, dt));
    cam.dist += (cam.distDeseada - cam.dist) * Math.min(1, dt * 4);
    camera.position.set(
      cam.centro.x + cam.dist * Math.sin(cam.phi) * Math.sin(cam.theta),
      cam.centro.y + cam.dist * Math.cos(cam.phi),
      cam.centro.z + cam.dist * Math.sin(cam.phi) * Math.cos(cam.theta));
    camera.lookAt(cam.centro);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animar);

  return { actualizar, seleccionar };
}

// ---------- Texto ----------
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

function etiqueta(texto, opts) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false }));
  repintarEtiqueta(sp, texto, opts);
  return sp;
}

function repintarEtiqueta(sp, texto, opts = {}) {
  const tam = opts.tam || 34, pad = 22;
  const cv = document.createElement('canvas');
  let c = cv.getContext('2d');
  c.font = '600 ' + tam + 'px ' + MONO;
  cv.width = Math.max(64, Math.ceil(c.measureText(texto).width) + pad * 2);
  cv.height = Math.ceil(tam * 1.8);
  c = cv.getContext('2d');
  if (opts.fondo !== false) {
    c.fillStyle = opts.fondoColor || 'rgba(17,24,38,0.88)';
    const r = 14, w = cv.width, h = cv.height;
    c.beginPath(); c.moveTo(r, 0); c.arcTo(w, 0, w, h, r); c.arcTo(w, h, 0, h, r); c.arcTo(0, h, 0, 0, r); c.arcTo(0, 0, w, 0, r); c.fill();
  }
  c.font = '600 ' + tam + 'px ' + MONO;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = opts.color || '#e6ecf5';
  c.fillText(texto, cv.width / 2, cv.height / 2 + 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (sp.material.map) sp.material.map.dispose();
  sp.material.map = tex; sp.material.needsUpdate = true;
  const esc = opts.escala || 0.0078;
  sp.scale.set(cv.width * esc, cv.height * esc, 1);
}
