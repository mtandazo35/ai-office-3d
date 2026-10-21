'use strict';
// Recorta y enmascara secretos en todo lo que se muestra en el panel.
// Las órdenes que el usuario envía NO pasan por aquí: llegan a Claude tal cual.

const PATRONES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g // JWT
];

// clave=valor / clave: valor / "clave": "valor"
const CLAVE_VALOR = /((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)["']?\s*[:=]\s*["']?)([^\s"',;&]{3,})/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const URL_CON_CREDENCIALES = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s/@]+)@/gi;

function redactar(texto, max = 2000) {
  if (texto === undefined || texto === null) return '';
  let s = typeof texto === 'string' ? texto : JSON.stringify(texto);
  if (s.length > max * 4) s = s.slice(0, max * 4); // no procesar megas de texto
  for (const re of PATRONES) s = s.replace(re, '***');
  s = s.replace(CLAVE_VALOR, '$1***');
  s = s.replace(BEARER, '$1 ***');
  s = s.replace(URL_CON_CREDENCIALES, '$1$2:***@');
  if (s.length > max) s = s.slice(0, max) + ' …';
  return s;
}

module.exports = { redactar };
