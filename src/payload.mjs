// Read and parse the JSON snapshot the host TUI writes to stdin.
// The host may close stdin immediately (EOF with no data) — that is fine.

/**
 * Parse a payload string into an object. Returns null on any failure.
 * @param {string} str
 * @returns {object|null}
 */
export function parsePayload(str) {
  if (typeof str !== 'string' || str.trim() === '') return null;
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return null;
  } catch {
    return null;
  }
}

/**
 * Read stdin until EOF or timeout, then parse it as the payload JSON.
 * Never throws; returns null when no valid payload arrives.
 * @param {object} [opts]
 * @param {NodeJS.ReadStream} [opts.stdin]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object|null>}
 */
export function readPayload({ stdin = process.stdin, timeoutMs = 150 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(parsePayload(buf));
    };
    const timer = setTimeout(finish, timeoutMs);
    // If the timeout fires before EOF we resolve with whatever arrived.
    try {
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => { buf += chunk; });
      stdin.on('end', finish);
      stdin.on('error', finish);
      // stdin may already be ended (e.g. piped empty input)
      if (stdin.readableEnded) finish();
      else stdin.resume();
    } catch {
      finish();
    }
  });
}
