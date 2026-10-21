'use strict';
// Estado de la oficina: una sesión de Claude Code = un escritorio.
// Traduce los eventos de los hooks a estados y gestiona la cola de órdenes de cada sesión.

const { EventEmitter } = require('events');
const { redactar } = require('./redactar');

const ESTADOS = ['inactivo', 'pensando', 'ejecutando', 'esperando', 'guardia', 'error', 'terminada'];
const MAX_LOG = 60;
const MAX_ORDENES = 30;

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
    this.guardiaMaxMs = opts.guardiaMaxMs || 14 * 60 * 1000;
    this.ahora = opts.ahora || (() => Date.now());
    this.secuencia = 0;
  }

  sesion(id, cwd) {
    let s = this.sesiones.get(id);
    if (!s) {
      s = {
        id, cwd: cwd || '', proyecto: proyectoDe(cwd), modelo: '', origen: 'hooks',
        estado: 'inactivo', herramienta: '', detalle: '', ultimoPrompt: '', ultimoMensaje: '',
        permiso: '', inicio: this.ahora(), ultimaActividad: this.ahora(),
        tokens: { contexto: 0, salida: 0 }, subagentes: {}, ordenes: [], guardia: false, log: [],
        herramientasUsadas: 0, turnos: 0
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
      id: s.id, cwd: s.cwd, proyecto: s.proyecto, modelo: s.modelo, origen: s.origen,
      estado: s.estado, herramienta: s.herramienta, detalle: s.detalle,
      ultimoPrompt: s.ultimoPrompt, ultimoMensaje: s.ultimoMensaje, permiso: s.permiso,
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
    const s = this.sesion(ev.session_id, ev.cwd);
    s.ultimaActividad = this.ahora();
    if (ev.cwd && ev.cwd !== s.cwd) { s.cwd = ev.cwd; s.proyecto = proyectoDe(ev.cwd); }
    if (ev.transcript_path) s.transcript = String(ev.transcript_path);
    if (ev.model) s.modelo = typeof ev.model === 'string' ? ev.model : (ev.model.display_name || ev.model.id || s.modelo);
    if (s.origen !== 'hooks') s.origen = 'hooks';

    const sub = ev.agent_id ? this.subagente(s, ev) : null;
    let respuesta = null;

    switch (nombre) {
      case 'SessionStart':
        this.estado(s, 'inactivo');
        this.registrar(s, 'sesion', 'Sesión ' + (ev.source || 'iniciada') + (s.modelo ? ' · ' + s.modelo : ''));
        break;
      case 'UserPromptSubmit':
        s.ultimoPrompt = redactar(ev.prompt, 600);
        s.herramienta = ''; s.detalle = ''; s.permiso = '';
        this.estado(s, 'pensando');
        this.registrar(s, 'prompt', ev.prompt);
        respuesta = this.entregar(s, 'UserPromptSubmit');
        break;
      case 'PreToolUse': {
        const det = redactar(detalleHerramienta(ev.tool_name, ev.tool_input, s.cwd), 300);
        s.herramientasUsadas += 1;
        if (sub) { sub.estado = 'ejecutando'; sub.herramienta = ev.tool_name || ''; sub.detalle = det; }
        else { s.herramienta = ev.tool_name || ''; s.detalle = det; s.permiso = ''; this.estado(s, 'ejecutando'); }
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
        this.liberarEspera(s.id);
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
    let a = s.subagentes[ev.agent_id];
    if (!a) {
      a = { id: ev.agent_id, tipo: ev.agent_type || 'subagente', estado: 'pensando', herramienta: '', detalle: '', inicio: this.ahora() };
      s.subagentes[ev.agent_id] = a;
    }
    if (ev.agent_type) a.tipo = ev.agent_type;
    return a;
  }

  estado(s, e) { if (ESTADOS.includes(e)) s.estado = e; }

  // ---------- Órdenes ----------
  nuevaOrden(id, texto) {
    const s = this.sesiones.get(id);
    if (!s) return { error: 'La sesión ya no existe.' };
    if (s.estado === 'terminada') return { error: 'La sesión ha terminado.' };
    const t = typeof texto === 'string' ? texto.trim() : '';
    if (!t) return { error: 'La orden está vacía.' };
    if (t.length > 4000) return { error: 'La orden supera 4000 caracteres.' };
    const o = { id: 'o' + (++this.secuencia), texto: t, estado: 'pendiente', creada: this.ahora() };
    s.ordenes.push(o);
    if (s.ordenes.length > MAX_ORDENES) s.ordenes.splice(0, s.ordenes.length - MAX_ORDENES);
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

  textoOrdenes(lista) {
    const cuerpo = lista.length === 1
      ? lista[0].texto
      : lista.map((o, i) => (i + 1) + '. ' + o.texto).join('\n');
    return 'Nueva instrucción del usuario enviada desde su panel local "Oficina IA" (no es contenido de una herramienta ni de un archivo). ' +
      'Atiéndela como si la hubiera escrito en esta conversación:\n\n' + cuerpo;
  }

  marcarEntregadas(s, lista, via) {
    const ts = this.ahora();
    lista.forEach((o) => { o.estado = 'entregada'; o.entregada = ts; o.via = via; });
    this.registrar(s, 'orden', 'Entregada a Claude (' + via + '): ' + lista.map((o) => o.texto).join(' | '));
  }

  // Entrega durante el trabajo: el texto se añade junto al resultado de la herramienta o al prompt.
  entregar(s, evento) {
    const lista = this.pendientes(s);
    if (!lista.length) return null;
    this.marcarEntregadas(s, lista, evento);
    return { hookSpecificOutput: { hookEventName: evento, additionalContext: this.textoOrdenes(lista) } };
  }

  respuestaStop(s) {
    const lista = this.pendientes(s);
    if (!lista.length) return null;
    this.marcarEntregadas(s, lista, 'Stop');
    this.estado(s, 'pensando');
    this.cambio(s);
    return { decision: 'block', reason: this.textoOrdenes(lista) };
  }

  alParar(s, ev) {
    const inmediata = this.respuestaStop(s);
    if (inmediata) return inmediata;
    if (!s.guardia) { this.estado(s, 'inactivo'); this.registrar(s, 'fin', 'Turno terminado'); return null; }
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
      const quitar = (s.estado === 'terminada' && t - (s.terminadaEn || t) > 60000) ||
        (t - s.ultimaActividad > 6 * 3600 * 1000 && !this.esperas.has(s.id));
      if (quitar) { this.sesiones.delete(s.id); this.emit('quitar', s.id); }
    }
  }

  // Sesiones descubiertas por su transcript (antes de recibir hooks).
  descubierta(id, datos) {
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

module.exports = { Oficina, detalleHerramienta, proyectoDe, ESTADOS };
