'use strict';
// Lectura de los transcripts JSONL de Claude Code (montados en solo lectura).
// Sirven para: tokens de cada sesión y descubrir sesiones activas antes de que lleguen hooks.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

class Transcripts {
  constructor(oficina, opts = {}) {
    this.oficina = oficina;
    this.raiz = opts.raiz || '/claude';                 // montaje de ~/.claude
    this.proyectos = path.join(this.raiz, 'projects');
    this.ventanaMs = opts.ventanaMs || 20 * 60 * 1000;  // sesiones modificadas en los últimos 20 min
    this.lectores = new Map();                          // ruta -> { offset, resto, mensajes: Map(id -> salida), contexto, modelo }
    this.pendientes = new Map();                        // id sesión -> timer (antirrebote)
  }

  // Convierte la ruta del host que manda el hook (p. ej. /home/x/.claude/projects/a/b.jsonl
  // o C:\Users\x\.claude\projects\a\b.jsonl) a la ruta dentro del contenedor.
  rutaLocal(rutaHost) {
    if (!rutaHost) return null;
    const p = String(rutaHost).replace(/\\/g, '/');
    let local;
    if (p.startsWith(this.proyectos + '/')) local = path.posix.normalize(p);
    else {
      const i = p.indexOf('/.claude/projects/');
      if (i < 0) return null;
      local = path.posix.normalize(path.posix.join(this.raiz, p.slice(i + '/.claude/'.length)));
    }
    if (!local.startsWith(this.proyectos + '/') || !local.endsWith('.jsonl')) return null;
    return local;
  }

  programar(sesion, ms = 1500) {
    if (!sesion.transcript) return;
    clearTimeout(this.pendientes.get(sesion.id));
    this.pendientes.set(sesion.id, setTimeout(() => {
      this.pendientes.delete(sesion.id);
      this.leer(sesion.id, this.rutaLocal(sesion.transcript)).catch(() => {});
    }, ms));
  }

  async leer(id, ruta) {
    if (!ruta) return;
    let st;
    try { st = await fsp.stat(ruta); } catch { return; }
    let l = this.lectores.get(ruta);
    if (!l || st.size < l.offset) {
      l = { offset: 0, resto: '', mensajes: new Map(), contexto: 0, modelo: '', cwd: '', ultimoPrompt: '' };
      this.lectores.set(ruta, l);
    }
    if (st.size === l.offset) return l;
    const fin = st.size;
    await new Promise((resolve, reject) => {
      const flujo = fs.createReadStream(ruta, { start: l.offset, end: fin - 1, encoding: 'utf8' });
      flujo.on('data', (trozo) => {
        const lineas = (l.resto + trozo).split('\n');
        l.resto = lineas.pop();
        for (const linea of lineas) this.linea(l, linea);
      });
      flujo.on('end', resolve);
      flujo.on('error', reject);
    });
    l.offset = fin;
    let salida = 0;
    for (const v of l.mensajes.values()) salida += v;
    this.oficina.tokens(id, { contexto: l.contexto, salida, modelo: l.modelo });
    return l;
  }

  linea(l, linea) {
    if (!linea || linea[0] !== '{') return;
    let o;
    try { o = JSON.parse(linea); } catch { return; }
    if (o.cwd) l.cwd = o.cwd;
    const m = o.message;
    if (o.type === 'assistant' && m && m.usage) {
      const u = m.usage;
      // Una misma respuesta se escribe en varias líneas con el mismo id: se cuenta una vez.
      if (m.id) l.mensajes.set(m.id, u.output_tokens || 0);
      if (!o.isSidechain) l.contexto = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (m.model && !String(m.model).startsWith('<')) l.modelo = m.model;
    } else if (o.type === 'user' && m && !o.isSidechain && typeof m.content === 'string' && !m.content.startsWith('<')) {
      l.ultimoPrompt = m.content;
    }
  }

  // Busca transcripts modificados recientemente y los registra como sesiones.
  async explorar() {
    let dirs;
    try { dirs = await fsp.readdir(this.proyectos, { withFileTypes: true }); } catch { return; }
    const limite = Date.now() - this.ventanaMs;
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.proyectos, d.name);
      let archivos;
      try { archivos = await fsp.readdir(dir); } catch { continue; }
      for (const a of archivos) {
        if (!a.endsWith('.jsonl')) continue;
        const ruta = path.join(dir, a);
        let st;
        try { st = await fsp.stat(ruta); } catch { continue; }
        if (st.mtimeMs < limite) continue;
        const id = a.slice(0, -6);
        const conocida = this.oficina.sesiones.get(id);
        if (conocida && conocida.origen === 'hooks') {
          if (!conocida.transcript) conocida.transcript = ruta;
          await this.leer(id, ruta).catch(() => {});
          continue;
        }
        const l = await this.leer(id, ruta).catch(() => null);
        if (!l || !l.cwd) continue;
        this.oficina.descubierta(id, { cwd: l.cwd, modelo: l.modelo, ultimoPrompt: l.ultimoPrompt, mtime: st.mtimeMs, transcript: ruta });
        this.oficina.tokens(id, { contexto: l.contexto, salida: [...l.mensajes.values()].reduce((x, y) => x + y, 0), modelo: l.modelo });
      }
    }
  }
}

module.exports = { Transcripts };
