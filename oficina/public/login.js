const form = document.getElementById('f-login');
const error = document.getElementById('error');
const boton = document.getElementById('entrar');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  error.textContent = '';
  boton.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
      credentials: 'same-origin'
    });
    if (r.ok) { location.replace('/'); return; }
    const d = await r.json().catch(() => ({}));
    error.textContent = d.esperaSeg ? `${d.error} (${Math.ceil(d.esperaSeg / 60)} min)` : (d.error || 'No se pudo entrar.');
  } catch {
    error.textContent = 'No hay conexión con la oficina.';
  } finally {
    boton.disabled = false;
  }
});
