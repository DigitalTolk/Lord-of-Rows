// Surfaces fatal startup errors on screen (no console in release webviews).
window.addEventListener('error', (e) => show(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => show(`Unhandled: ${String((e as PromiseRejectionEvent).reason?.stack ?? (e as PromiseRejectionEvent).reason)}`));
function show(msg: string) {
  const el = document.createElement('pre');
  el.setAttribute('role', 'alert');
  el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:40%;overflow:auto;margin:0;padding:8px;background:#b91c1c;color:#fff;font:12px monospace;z-index:99999;white-space:pre-wrap';
  el.textContent = msg;
  document.body.appendChild(el);
}
export {};
