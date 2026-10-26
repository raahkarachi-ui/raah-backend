/** Error with an HTTP status and a stable machine-readable code. */
export function httpError(status, code, message = code) {
  return Object.assign(new Error(message), { status, code });
}
