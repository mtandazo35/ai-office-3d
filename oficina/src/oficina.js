'use strict';
// Estado de la oficina: una sesión de Claude Code = un escritorio.
// Traduce los eventos de los hooks a estados y gestiona la cola de órdenes de cada sesión.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { redactar } = require('./redactar');

const ESTADOS = ['inactivo', 'pensando', 'ejecutando', 'esperando', 'guardia', 'error', 'sin_senal', 'terminada'];
const MAX_LOG = 60;
const MAX_ORDENES = 30;
const MAX_LOTE = 9000;                  // additionalContext admite 10.000 caracteres; se deja margen para el encabezado
const MAX_CONTINUACIONES = 8;           // Claude Code ignora el block de Stop a partir de ahí
const SIN_SENAL_MS = 10 * 60 * 1000;
const SUBAGENTE_SIN_EVENTOS_MS = 15 * 60 * 1000; // sin SubagentStop (corte, Esc): se retira solo
const MAX_SUBAGENTES_TERMINADOS = 200;
const SIN_SENAL_ESPERANDO_MS = 2 * 3600 * 1000; // pedir permiso puede durar: el dueño quizá no está
const CERRADAS_MS = 25 * 60 * 1000;     // más que la ventana de 20 min de Transcripts.explorar()
const MAX_NOMBRE = 24;
const MAX_ROL = 30;
const MAX_PERFILES_GUARDADOS = 200;
const GENEROS = ['', 'femenino', 'masculino', 'no_binario'];
const NOMBRES_AGENTES = ['Nico', 'Lía', 'Teo', 'Vera', 'Bruno', 'Sara', 'Iker', 'Noa', 'Hugo', 'Alma', 'Dante', 'Luna', 'Marco', 'Inés', 'Leo', 'Julia', 'Omar', 'Clara', 'Tomás', 'Elsa', 'Gael', 'Nora', 'Raúl', 'Mía'];

// Con subagentes trabajando, el agente principal no está parado aunque haya acabado su turno.
const estadoVisto = (s) => (s.estado === 'inactivo' && Object.keys(s.subagentes).length ? 'coordinando' : s.estado);

const limpiarTexto = (t) => (typeof t === 'string' ? t.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '');

function hashTexto(t) {
  let h = 0;
  for (const c of String(t)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h;
}

function proyectoDe(cwd) {
  if (!cwd) return 'sin proyecto';
  const limpio = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  return limpio.split('/').pop() || limpio;
}

function relativo(cwd, archivo) {
  if (!archivo) return '';
  const a = String(archivo).replace(/\\/g, '/');
  const c = cwd ? String(cwd).replace(/\\/g, '/').replace(/\/+$/, '') + '/' : '';
  return c && a.startsWith(c) ? a.slice(c.length) : a;
}

// Resumen de una línea de lo que hace una herramienta, a partir de tool_input.
function detalleHerramienta(nombre, input, cwd) {
  const i = input && typeof input === 'object' ? input : {};
  const archivo = i.file_path || i.notebook_path || i.path;
  switch (nombre) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return relativo(cwd, archivo);
    case 'Bash':
      return '$ ' + String(i.command || '').split('\n')[0];
    case 'Grep':
      return '/' + (i.pattern || '') + '/' + (i.path ? ' en ' + relativo(cwd, i.path) : '');
    case 'Glob':
      return String(i.pattern || '');
    case 'WebFetch':
      return String(i.url || '');
    case 'WebSearch':
      return '«' + String(i.query || '') + '»';
    case 'Task': case 'Agent':
      return String(i.description || i.subagent_type || 'subagente');
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate':
      return 'actualiza la lista de tareas';
    default:
      if (String(nombre).startsWith('mcp__')) return String(nombre).split('__').slice(1).join(' › ');
      if (archivo) return relativo(cwd, archivo);
      if (i.description) return String(i.description);
      return Object.keys(i).slice(0, 4).join(', ');
  }
}

class Oficina extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sesiones = new Map();
    this.esperas = new Map();          // sessionId -> { resolver, timer }
    this.cerradas = new Map();         // sessionId -> cuándo se retiró tras terminar
    this.guardiaMaxMs = opts.guardiaMaxMs || 14 * 60 * 1000;
    this.ahora = opts.ahora || (() => Date.now());
    this.secuencia = 0;
    this.archivoPerfiles = opts.archivoPerfiles || null;
    this.perfiles = this.cargarPerfiles();
  }

  // ---------- Perfiles: nombre, rol y género ----------
  // Solo se guarda lo que el usuario ha editado; el nombre automático sale del id de la sesión.
  cargarPerfiles() {
    if (!this.archivoPerfiles) return new Map();
    try {
      const datos = JSON.parse(fs.readFileSync(this.archivoPerfiles, 'utf8'));
      return new Map(Object.entries(datos).filter(([, p]) => p && typeof p === 'object' && typeof p.nombre === 'string'));
    } catch { return new Map(); }
  }

  guardarPerfiles() {
    if (!this.archivoPerfiles) return;
    const tmp = this.archivoPerfiles + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.archivoPerfiles), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.perfiles), null, 2));
      fs.renameSync(tmp, this.archivoPerfiles);
    } catch (e) { console.error('No pude guardar los perfiles:', e.message); }
  }

  nombreEnUso(nombre, salvoId) {
    const buscado = nombre.toLocaleLowerCase('es');
    for (const s of this.sesiones.values()) if (s.id !== salvoId && s.nombre.toLocaleLowerCase('es') === buscado) return true;
    for (const [id, p] of this.perfiles) if (id !== salvoId && p.nombre.toLocaleLowerCase('es') === buscado) return true;
    for (const s of this.sesiones.values()) {
      for (const a of Object.values(s.subagentes)) if (a.id !== salvoId && a.nombre.toLocaleLowerCase('es') === buscado) return true;
    }
    return false;
  }

  // Siempre el mismo para una sesión, salvo que ya lo lleve otro agente.
  nombreAutomatico(id) {
    const n = NOMBRES_AGENTES.length, inicio = hashTexto(id) % n;
    for (let i = 0; i < n; i++) {
      const nombre = NOMBRES_AGENTES[(inicio + i) % n];
      if (!this.nombreEnUso(nombre, id)) return nombre;
    }
    for (let i = 2; ; i++) {
      const nombre = NOMBRES_AGENTES[inicio] + ' ' + i;
      if (!this.nombreEnUso(nombre, id)) return nombre;
    }
  }

  // Cambia los campos que vengan definidos. Sirve también para agentes guardados sin sesión activa.
  actualizarPerfil(id, cambios = {}) {
    const s = this.sesiones.get(id), previo = this.perfiles.get(id);
    if (!s && !previo) return { error: 'La sesión ya no existe.' };
    const base = s || previo;
    const nuevo = { nombre: base.nombre, rol: base.rol || '', genero: base.genero || '' };
    if (cambios.nombre !== undefined) {
      const nombre = limpiarTexto(cambios.nombre);
      if (!nombre) return { error: 'El nombre está vacío.' };
      if ([...nombre].length > MAX_NOMBRE) return { error: 'El nombre supera ' + MAX_NOMBRE + ' caracteres.' };
      if (this.nombreEnUso(nombre, id)) return { error: 'Ya hay otro agente con ese nombre.' };
      nuevo.nombre = nombre;
    }
    if (cambios.rol !== undefined) {
      const rol = limpiarTexto(cambios.rol);
      if ([...rol].length > MAX_ROL) return { error: 'El rol supera ' + MAX_ROL + ' caracteres.' };
      nuevo.rol = rol;
    }
    if (cambios.genero !== undefined) {
      if (!GENEROS.includes(cambios.genero)) return { error: 'Género no válido.' };
      nuevo.genero = cambios.genero;
    }
    this.perfiles.delete(id);
    this.perfiles.set(id, { ...nuevo, proyecto: base.proyecto || '', actualizado: this.ahora() });
    while (this.perfiles.size > MAX_PERFILES_GUARDADOS) this.perfiles.delete(this.perfiles.keys().next().value);
    this.guardarPerfiles();
    if (s) {
      if (s.nombre !== nuevo.nombre) this.registrar(s, 'sesion', 'Ahora se llama ' + nuevo.nombre + ' (antes ' + s.nombre + ')');
      if (s.rol !== nuevo.rol) this.registrar(s, 'sesion', nuevo.rol ? 'Rol: ' + nuevo.rol : 'Sin rol');
      Object.assign(s, nuevo);
      this.cambio(s);
    }
    this.emit('perfiles');
    return { ok: true };
  }

  renombrar(id, texto) {
    return this.actualizarPerfil(id, { nombre: typeof texto === 'string' ? texto : '' });
  }

  olvidarPerfil(id) {
    if (this.sesiones.has(id)) return { error: 'Este agente sigue activo; no se puede olvidar todavía.' };
    if (!this.perfiles.delete(id)) return { error: 'Ese agente ya no está guardado.' };
    this.guardarPerfiles();
    this.emit('perfiles');
    return { ok: true };
  }

  listaPerfiles() {
    const activos = [...this.sesiones.values()].map((s) => ({
      id: s.id, nombre: s.nombre, rol: s.rol, genero: s.genero, proyecto: s.proyecto, estado: estadoVisto(s), activo: true
    }));
    const guardados = [...this.perfiles].filter(([id]) => !this.sesiones.has(id)).map(([id, p]) => ({
      id, nombre: p.nombre, rol: p.rol || '', genero: p.genero || '', proyecto: p.proyecto || '', estado: '', activo: false, actualizado: p.actualizado
    }));
    return [...activos, ...guardados];
  }

  sesion(id, cwd) {
    let s = this.sesiones.get(id);
    if (!s) {
      const perfil = this.perfiles.get(id) || {};
      s = {
        id, nombre: perfil.nombre || this.nombreAutomatico(id), rol: perfil.rol || '', genero: perfil.genero || '', cwd: cwd || '', proyecto: proyectoDe(cwd), modelo: '', origen: 'hooks',
        estado: 'inactivo', herramienta: '', detalle: '', ultimoPrompt: '', ultimoMensaje: '',
        permiso: '', inicio: this.ahora(), ultimaActividad: this.ahora(),
        tokens: { contexto: 0, salida: 0 }, subagentes: {}, subagentesFin: new Set(), ordenes: [], guardia: false, log: [],
        herramientasUsadas: 0, turnos: 0, modoPermisos: '', continuaciones: 0
      };
      this.sesiones.set(id, s);
    }
    if (cwd && !s.cwd) { s.cwd = cwd; s.proyecto = proyectoDe(cwd); }
    return s;
  }

  registrar(s, tipo, texto) {
    const ev = { ts: this.ahora(), tipo, texto: redactar(texto, 400) };
    s.log.push(ev);
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
    this.emit('log', s.id, ev);
  }

  cambio(s) { this.emit('sesion', this.vista(s)); }

  // Copia segura para el navegador (sin timers ni promesas).
  vista(s) {
    return {
      id: s.id, nombre: s.nombre, rol: s.rol, genero: s.genero, cwd: s.cwd, proyecto: s.proyecto, modelo: s.modelo, origen: s.origen,
      estado: estadoVisto(s), herramienta: s.herramienta, detalle: s.detalle,
      ultimoPrompt: s.ultimoPrompt, ultimoMensaje: s.ultimoMensaje, permiso: s.permiso, modoPermisos: s.modoPermisos,
      inicio: s.inicio, ultimaActividad: s.ultimaActividad, tokens: { ...s.tokens },
      subagentes: Object.values(s.subagentes).map((a) => ({ ...a })),
      ordenes: s.ordenes.map((o) => ({ ...o })), guardia: s.guardia, herramientasUsadas: s.herramientasUsadas, turnos: s.turnos,
      esperandoOrden: this.esperas.has(s.id), log: s.log.slice(-MAX_LOG)
    };
  }

  instantanea() { return [...this.sesiones.values()].map((s) => this.vista(s)); }

  // ---------- Eventos de hooks ----------
  // Devuelve una promesa con el cuerpo JSON de respuesta para Claude Code (o null = respuesta vacía).
  procesar(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.session_id !== 'string' || !ev.session_id) return Promise.resolve(null);
    const nombre = String(ev.hook_event_name || '');
    this.cerradas.delete(ev.session_id); // un hook es la prueba de que se ha reanudado
    const s = this.sesion(ev.session_id, ev.cwd);
    s.ultimaActividad = this.ahora();
    // Hay señal otra vez: vuelve a lo que hacía y el evento sigue su curso normal.
    if (s.estado === 'sin_senal') this.estado(s, s.estadoPrevio || 'pensando');
    if (ev.cwd && ev.cwd !== s.cwd) { s.cwd = ev.cwd; s.proyecto = proyectoDe(ev.cwd); }
    if (ev.transcript_path) s.transcript = String(ev.transcript_path);
    if (ev.model) s.modelo = typeof ev.model === 'string' ? ev.model : (ev.model.display_name || ev.model.id || s.modelo);
    if (s.origen !== 'hooks') s.origen = 'hooks';
    // Solo el agente principal: un subagente puede tener su propio modo, y las órdenes van al principal.
    if (!ev.agent_id && limpiarTexto(ev.permission_mode)) s.modoPermisos = limpiarTexto(ev.permission_mode).slice(0, 40);

    const sub = ev.agent_id ? this.subagente(s, ev) : null;
    let respuesta = null;

    switch (nombre) {
      case 'SessionStart':
        this.estado(s, 'inactivo');
        this.registrar(s, 'sesion', 'Sesión ' + (ev.source || 'iniciada') + (s.modelo ? ' · ' + s.modelo : ''));
        break;
      case 'UserPromptSubmit':
        s.ultimoPrompt = redactar(ev.prompt, 600);
        s.herramienta = ''; s.detalle = ''; s.permiso = ''; s.continuaciones = 0;
        this.estado(s, 'pensando');
        this.registrar(s, 'prompt', ev.prompt);
        respuesta = this.entregar(s, 'UserPromptSubmit');
        break;
      case 'PreToolUse': {
        const det = redactar(detalleHerramienta(ev.tool_name, ev.tool_input, s.cwd), 300);
        s.herramientasUsadas += 1;
        if (sub) { sub.estado = 'ejecutando'; sub.herramienta = ev.tool_name || ''; sub.detalle = det; }
        else { s.herramienta = ev.tool_name || ''; s.detalle = det; s.permiso = ''; s.continuaciones = 0; this.estado(s, 'ejecutando'); }
        this.registrar(s, 'herramienta', (sub ? '[' + sub.tipo + '] ' : '') + (ev.tool_name || '') + ' · ' + det);
        break;
      }
      case 'PostToolUse':
        if (sub) { sub.estado = 'pensando'; }
        else {
          if (s.estado === 'esperando' || s.estado === 'ejecutando' || s.estado === 'error') this.estado(s, 'pensando');
          s.permiso = '';
          respuesta = this.entregar(s, 'PostToolUse');
        }
        break;
      case 'PostToolUseFailure': {
        const msg = ev.error || ev.tool_response || 'falló';
        if (sub) sub.estado = 'error'; else this.estado(s, 'error');
        this.registrar(s, 'error', (ev.tool_name || 'herramienta') + ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)));
        break;
      }
      case 'PermissionRequest':
        s.permiso = redactar((ev.tool_name || '') + ' · ' + detalleHerramienta(ev.tool_name, ev.tool_input, s.cwd), 300);
        this.estado(s, 'esperando');
        this.registrar(s, 'permiso', 'Pide permiso: ' + s.permiso);
        break;
      case 'Notification': {
        const tipo = String(ev.notification_type || '');
        const msg = String(ev.message || '');
        if (tipo === 'permission_prompt' || (!tipo && /permission|permiso/i.test(msg))) {
          if (!s.permiso) s.permiso = redactar(msg, 300);
          this.estado(s, 'esperando');
        } else if (tipo === 'idle_prompt') {
          if (s.estado !== 'guardia') this.estado(s, 'inactivo');
        }
        this.registrar(s, 'aviso', msg || tipo);
        break;
      }
      case 'SubagentStart':
        // subagente() ya lo creó
        this.registrar(s, 'subagente', 'Arranca subagente ' + (sub ? sub.tipo : ev.agent_type || ''));
        break;
      case 'SubagentStop':
        if (ev.agent_id && s.subagentes[ev.agent_id]) {
          this.registrar(s, 'subagente', 'Termina subagente ' + s.subagentes[ev.agent_id].tipo);
          delete s.subagentes[ev.agent_id];
        }
        if (ev.agent_id) {
          s.subagentesFin.add(ev.agent_id);
          if (s.subagentesFin.size > MAX_SUBAGENTES_TERMINADOS) s.subagentesFin.delete(s.subagentesFin.values().next().value);
        }
        break;
      case 'Stop':
        if (sub) break; // un Stop dentro de un subagente no cierra la sesión
        s.ultimoMensaje = redactar(ev.last_assistant_message, 800);
        s.turnos += 1;
        s.herramienta = ''; s.detalle = ''; s.permiso = '';
        respuesta = this.alParar(s, ev);
        break;
      case 'StopFailure':
        this.estado(s, 'error');
        this.registrar(s, 'error', ev.error || ev.reason || 'La respuesta terminó con error');
        break;
      case 'SessionEnd':
        s.subagentes = {};
        this.liberarEspera(s.id);
        // Al cerrar la sesión, lo que seguía en cola ya no se entregará.
        for (const o of this.pendientes(s)) o.estado = 'cancelada';
        this.estado(s, 'terminada');
        s.terminadaEn = this.ahora();
        this.registrar(s, 'sesion', 'Sesión terminada' + (ev.reason ? ' (' + ev.reason + ')' : ''));
        break;
      default:
        break;
    }
    this.cambio(s);
    this.emit('actividad', s);
    return respuesta instanceof Promise ? respuesta : Promise.resolve(respuesta);
  }

  subagente(s, ev) {
    if (ev.hook_event_name === 'SubagentStart') s.subagentesFin.delete(ev.agent_id);
    // Un evento que llega tarde no resucita a un subagente terminado, ni cuenta como del principal.
    if (s.subagentesFin.has(ev.agent_id)) return { id: ev.agent_id, tipo: ev.agent_type || 'subagente', estado: 'pensando', herramienta: '', detalle: '' };
    let a = s.subagentes[ev.agent_id];
    if (!a) {
      a = { id: ev.agent_id, nombre: this.nombreAutomatico(ev.agent_id), tipo: ev.agent_type || 'subagente', estado: 'pensando', herramienta: '', detalle: '', inicio: this.ahora() };
      s.subagentes[ev.agent_id] = a;
    }
    if (ev.agent_type) a.tipo = ev.agent_type;
    a.ultimaActividad = this.ahora();
    return a;
  }

  estado(s, e) { if (ESTADOS.includes(e)) s.estado = e; }

  // ---------- Órdenes ----------
  nuevaOrden(id, texto) {
    const s = this.sesiones.get(id);
    if (!s) return { error: 'La sesión ya no existe.' };
    if (s.estado === 'terminada') return { error: 'La sesión ha terminado: ya no recibe órdenes.' };
    // Sin hooks no hay por dónde entregarla: quedaría en cola para siempre.
    if (s.origen !== 'hooks') return { error: 'Esta sesión no está conectada a la oficina: no recibe órdenes.' };
    const t = typeof texto === 'string' ? texto.trim() : '';
    if (!t) return { error: 'La orden está vacía.' };
    if (t.length > 4000) return { error: 'La orden supera 4000 caracteres.' };
    if (this.pendientes(s).length >= MAX_ORDENES) return { error: 'Ya hay ' + MAX_ORDENES + ' órdenes pendientes en este agente.' };
    const o = { id: 'o' + (++this.secuencia), texto: t, estado: 'pendiente', creada: this.ahora() };
    s.ordenes.push(o);
    // Solo se olvida el historial: una orden pendiente nunca se descarta.
    while (s.ordenes.length > MAX_ORDENES) s.ordenes.splice(s.ordenes.findIndex((x) => x.estado !== 'pendiente'), 1);
    this.registrar(s, 'orden', 'Orden encolada: ' + t);
    // Si la sesión está en guardia esperando, se entrega ya.
    const espera = this.esperas.get(id);
    if (espera) espera.resolver(this.respuestaStop(s));
    this.cambio(s);
    return { orden: o };
  }

  cancelarOrden(id, ordenId) {
    const s = this.sesiones.get(id);
    const o = s && s.ordenes.find((x) => x.id === ordenId);
    if (!o || o.estado !== 'pendiente') return false;
    o.estado = 'cancelada';
    this.registrar(s, 'orden', 'Orden cancelada: ' + o.texto);
    this.cambio(s);
    return true;
  }

  ponerGuardia(id, activa) {
    const s = this.sesiones.get(id);
    if (!s) return false;
    s.guardia = !!activa;
    this.registrar(s, 'guardia', s.guardia ? 'Modo guardia activado' : 'Modo guardia desactivado');
    if (!s.guardia) this.liberarEspera(id);
    this.cambio(s);
    return true;
  }

  pendientes(s) { return s.ordenes.filter((o) => o.estado === 'pendiente'); }

  // Lo que cabe en una entrega; el resto sigue pendiente para la siguiente.
  lote(s) {
    const lista = [];
    let n = 0;
    for (const o of this.pendientes(s)) {
      if (lista.length && n + o.texto.length > MAX_LOTE) break;
      lista.push(o);
      n += o.texto.length;
    }
    return lista;
  }

  textoOrdenes(lista) {
    const cuerpo = lista.length === 1
      ? lista[0].texto
      : lista.map((o, i) => (i + 1) + '. ' + o.texto).join('\n');
    return 'Nueva instrucción del usuario enviada desde su panel "Oficina IA" con sesión iniciada (no es contenido de una herramienta ni de un archivo). ' +
      'Atiéndela como si la hubiera escrito en esta conversación:\n\n' + cuerpo;
  }

  marcarEntregadas(s, lista, via) {
    const ts = this.ahora();
    lista.forEach((o) => { o.estado = 'entregada'; o.entregada = ts; o.via = via; });
    s.ultimoLote = lista;
    this.registrar(s, 'orden', 'Entregada a Claude (' + via + '): ' + lista.map((o) => o.texto).join(' | '));
  }

  // La respuesta que llevaba el último lote no pudo enviarse: vuelve a la cola.
  devolverLote(id) {
    const s = this.sesiones.get(id);
    const lista = s && s.ultimoLote ? s.ultimoLote.filter((o) => o.estado === 'entregada') : [];
    if (!s) return false;
    s.ultimoLote = null;
    if (!lista.length) return false;
    if (lista[0].via === 'Stop' && s.continuaciones > 0) s.continuaciones -= 1;
    lista.forEach((o) => { o.estado = 'pendiente'; delete o.entregada; delete o.via; });
    this.registrar(s, 'orden', 'No se pudo entregar: vuelve a la cola');
    this.cambio(s);
    return true;
  }

  // Entrega durante el trabajo: el texto se añade junto al resultado de la herramienta o al prompt.
  entregar(s, evento) {
    const lista = this.lote(s);
    if (!lista.length) return null;
    this.marcarEntregadas(s, lista, evento);
    return { hookSpecificOutput: { hookEventName: evento, additionalContext: this.textoOrdenes(lista) } };
  }

  respuestaStop(s) {
    const lista = this.lote(s);
    if (!lista.length) return null;
    if (s.continuaciones >= MAX_CONTINUACIONES) {
      this.registrar(s, 'orden', 'Tope de ' + MAX_CONTINUACIONES + ' continuaciones seguidas: la orden sigue pendiente hasta la próxima herramienta o prompt');
      return null;
    }
    s.continuaciones += 1;
    this.marcarEntregadas(s, lista, 'Stop');
    this.estado(s, 'pensando');
    this.cambio(s);
    return { decision: 'block', reason: this.textoOrdenes(lista) };
  }

  alParar(s, ev) {
    const inmediata = this.respuestaStop(s);
    if (inmediata) return inmediata;
    // Órdenes en cola aquí = tope alcanzado: quedarse en guardia retendría a Claude sin poder entregarlas.
    if (!s.guardia || this.pendientes(s).length) { this.estado(s, 'inactivo'); this.registrar(s, 'fin', 'Turno terminado'); return null; }
    // Modo guardia: el hook queda abierto hasta que llegue una orden, se desactive la guardia o venza el plazo.
    this.liberarEspera(s.id);
    this.estado(s, 'guardia');
    this.registrar(s, 'guardia', 'Terminó el turno y espera órdenes desde la oficina');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.esperas.delete(s.id);
        if (s.estado === 'guardia') this.estado(s, 'inactivo');
        this.registrar(s, 'guardia', 'Plazo de guardia agotado; la sesión queda libre');
        this.cambio(s);
        resolve(null);
      }, this.guardiaMaxMs);
      this.esperas.set(s.id, {
        resolver: (r) => {
          clearTimeout(timer); this.esperas.delete(s.id);
          if (!r && s.estado === 'guardia') this.estado(s, 'inactivo');
          this.cambio(s); resolve(r);
        }
      });
    });
  }

  liberarEspera(id) {
    const e = this.esperas.get(id);
    if (e) e.resolver(null);
  }

  // Si Claude Code corta la petición (Esc, Ctrl+C, timeout), se libera la espera.
  conexionCerrada(id) { this.liberarEspera(id); }

  // ---------- Mantenimiento ----------
  limpiar() {
    const t = this.ahora();
    for (const s of this.sesiones.values()) {
      let retirados = 0;
      for (const a of Object.values(s.subagentes)) {
        if (t - (a.ultimaActividad || a.inicio) > SUBAGENTE_SIN_EVENTOS_MS) { delete s.subagentes[a.id]; retirados += 1; }
      }
      if (retirados) { this.registrar(s, 'subagente', 'Sin eventos de ' + retirados + ' subagente(s): se retiran'); this.cambio(s); }
      const quitar = (s.estado === 'terminada' && t - (s.terminadaEn || t) > 60000) ||
        (t - s.ultimaActividad > 6 * 3600 * 1000 && !this.esperas.has(s.id));
      if (quitar) {
        if (s.estado === 'terminada') this.cerradas.set(s.id, t);
        this.sesiones.delete(s.id);
        this.emit('quitar', s.id);
      } else if (((s.estado === 'ejecutando' || s.estado === 'pensando') && t - s.ultimaActividad > SIN_SENAL_MS) ||
        (s.estado === 'esperando' && t - s.ultimaActividad > SIN_SENAL_ESPERANDO_MS)) {
        // Tras Esc o un cierre brusco no llega ningún evento; un Bash largo también cae aquí y vuelve con su PostToolUse.
        s.estadoPrevio = s.estado;
        this.estado(s, 'sin_senal');
        this.registrar(s, 'aviso', 'Sin eventos desde hace ' + Math.round((t - s.ultimaActividad) / 60000) + ' min');
        this.cambio(s);
      }
    }
    for (const [id, cuando] of this.cerradas) if (t - cuando > CERRADAS_MS) this.cerradas.delete(id);
  }

  // Sesiones descubiertas por su transcript (antes de recibir hooks).
  descubierta(id, datos) {
    if (this.cerradas.has(id)) return; // si se reanuda de verdad, los hooks la vuelven a crear
    const nueva = !this.sesiones.has(id);
    const s = this.sesion(id, datos.cwd);
    if (nueva) {
      s.origen = 'transcript';
      s.ultimaActividad = datos.mtime || s.ultimaActividad;
      this.registrar(s, 'sesion', 'Detectada por su transcript (aún sin eventos de hooks)');
    }
    if (datos.transcript) s.transcript = datos.transcript;
    if (datos.modelo && !s.modelo) s.modelo = datos.modelo;
    if (datos.ultimoPrompt && !s.ultimoPrompt) s.ultimoPrompt = redactar(datos.ultimoPrompt, 600);
    this.cambio(s);
  }

  tokens(id, t) {
    const s = this.sesiones.get(id);
    if (!s) return;
    if (s.tokens.contexto === t.contexto && s.tokens.salida === t.salida && (!t.modelo || t.modelo === s.modelo)) return;
    s.tokens = { contexto: t.contexto, salida: t.salida };
    if (t.modelo) s.modelo = t.modelo;
    this.cambio(s);
  }
}

module.exports = { Oficina, detalleHerramienta, proyectoDe, ESTADOS, NOMBRES_AGENTES, GENEROS, MAX_NOMBRE, MAX_ROL };
