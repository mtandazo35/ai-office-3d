'use strict';
// Cliente del conector: el servicio del host que abre sesiones de Claude Code en tmux.
// Se llega a él por un socket local, en la carpeta ai-office montada en el contenedor.

const fs = require('fs');
const http = require('http');

function crearConector(socketPath, { forzado = false } = {}) {
  const disponible = () => forzado || fs.existsSync(socketPath);

  function pedir(metodo, ruta, cuerpo, ms = 70000) {
    return new Promise((resolve, reject) => {
      const datos = cuerpo === undefined ? null : JSON.stringify(cuerpo);
      const headers = datos ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(datos) } : {};
      const req = http.request({ socketPath, method: metodo, path: ruta, headers, timeout: ms }, (res) => {
        const trozos = [];
        res.on('data', (c) => trozos.push(c));
        res.on('error', reject);
        res.on('end', () => {
          let r;
          try { r = JSON.parse(Buffer.concat(trozos).toString('utf8') || '{}'); } catch { return reject(new Error('Respuesta inválida del conector')); }
          if (res.statusCode >= 400) return reject(new Error(r.error || 'Error del conector'));
          resolve(r);
        });
      });
      req.on('timeout', () => req.destroy(new Error('El conector tardó demasiado en responder')));
      req.on('error', reject);
      if (datos) req.write(datos);
      req.end();
    });
  }

  return { disponible, pedir };
}

module.exports = { crearConector };
