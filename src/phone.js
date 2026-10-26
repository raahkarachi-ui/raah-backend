/** 0300 1234567, 92300…, +92300… → +923001234567; null if not a PK mobile. */
export function normalizePkPhone(raw) {
  const d = String(raw ?? '').replace(/[\s\-()]/g, '');
  const m = d.match(/^(?:\+92|0092|92|0)?(3\d{9})$/);
  return m ? `+92${m[1]}` : null;
}