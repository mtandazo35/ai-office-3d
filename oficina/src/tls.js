'use strict';
// HTTPS del panel.
//   TLS=auto      certificado autofirmado para TLS_HOSTS (IP del VPS, dominio…), guardado en /datos/tls
//   TLS=archivos  usa TLS_CERT y TLS_KEY (p. ej. de Let's Encrypt)
//   TLS=0         HTTP plano (solo local, o detrás de un proxy con HTTPS como Nginx Proxy Manager)

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

function hostsDe(texto) {
  const lista = String(texto || '').split(',').map((h) => h.trim()).filter(Boolean);
  return [...new Set(['localhost', '127.0.0.1', ...lista])].sort();
}

async function generar(hosts) {
  const selfsigned = require('selfsigned');
  const altNames = hosts.map((h) => (net.isIP(h) ? { type: 7, ip: h } : { type: 2, value: h }));
  const cn = hosts.find((h) => h !== 'localhost' && h !== '127.0.0.1') || 'localhost';
  const desde = new Date(Date.now() - 60 * 1000);
  const hasta = new Date(desde); hasta.setDate(hasta.getDate() + 825);
  const pems = await selfsigned.generate([{ name: 'commonName', value: cn }, { name: 'organizationName', value: 'Oficina IA (autofirmado)' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate: desde, notAfterDate: hasta,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ]
  });
  return { cert: pems.cert, key: pems.private };
}

function huella(certPem) {
  try { return new crypto.X509Certificate(certPem).fingerprint256; } catch { return '?'; }
}

async function credenciales({ modo, hostsTexto, dir, certPath, keyPath, log }) {
  if (modo === '0' || modo === 'no' || modo === 'off') return null;
  if (modo === 'archivos') {
    if (!certPath || !keyPath) throw new Error('TLS=archivos necesita TLS_CERT y TLS_KEY');
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), origen: certPath };
  }
  // auto: reutiliza el certificado guardado si cubre los mismos hosts y no está por caducar.
  const hosts = hostsDe(hostsTexto);
  const fCert = path.join(dir, 'cert.pem'), fKey = path.join(dir, 'key.pem'), fMeta = path.join(dir, 'hosts.json');
  try {
    const meta = JSON.parse(fs.readFileSync(fMeta, 'utf8'));
    const cert = fs.readFileSync(fCert, 'utf8');
    const x = new crypto.X509Certificate(cert);
    if (JSON.stringify(meta.hosts) === JSON.stringify(hosts) && new Date(x.validTo).getTime() - Date.now() > 30 * 86400 * 1000) {
      log(`HTTPS con certificado autofirmado (${hosts.join(', ')}). SHA-256: ${x.fingerprint256}`);
      return { cert, key: fs.readFileSync(fKey, 'utf8'), origen: fCert };
    }
  } catch { /* no hay certificado válido guardado */ }
  const { cert, key } = await generar(hosts);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(fKey, key, { mode: 0o600 });
    fs.writeFileSync(fCert, cert, { mode: 0o644 });
    fs.writeFileSync(fMeta, JSON.stringify({ hosts }));
  } catch (e) {
    log(`Aviso: no pude guardar el certificado en ${dir} (${e.message}); se generará otro en cada arranque.`);
  }
  log(`HTTPS con certificado autofirmado NUEVO (${hosts.join(', ')}). SHA-256: ${huella(cert)}`);
  log('El navegador avisará de que no es de confianza: comprueba que la huella coincide y acéptalo una vez.');
  return { cert, key, origen: fCert };
}

module.exports = { credenciales, hostsDe };
