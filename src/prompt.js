import readline from 'node:readline';

/**
 * Prompt for a line of text on the given streams.
 * When `mask` is true, typed characters are not echoed to the terminal.
 *
 * @param {string} question
 * @param {{ mask?: boolean, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [options]
 * @returns {Promise<string>}
 */
export function askLine(question, options = {}) {
  const { mask = false, input = process.stdin, output = process.stdout } = options;

  if (!mask || !input.isTTY) {
    const rl = readline.createInterface({ input, output });
    return new Promise((resolve, reject) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      rl.once('SIGINT', () => {
        rl.close();
        reject(new Error('Prompt cancelled by user.'));
      });
    });
  }

  return new Promise((resolve, reject) => {
    output.write(question);
    let value = '';
    const wasRaw = Boolean(input.isRaw);

    const cleanup = () => {
      input.removeListener('data', onData);
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(wasRaw);
      }
      input.pause();
    };

    const onData = (chunk) => {
      const str = chunk.toString('utf8');
      for (const ch of str) {
        if (ch === '\u0003') {
          // Ctrl+C
          cleanup();
          output.write('\n');
          reject(new Error('Prompt cancelled by user.'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
          }
          continue;
        }
        value += ch;
      }
    };

    if (typeof input.setRawMode === 'function') {
      input.setRawMode(true);
    }
    input.resume();
    input.on('data', onData);
  });
}

/**
 * Obtain OpenVPN username and password from options, environment variables, or interactive prompt.
 *
 * @param {{ user?: string, pass?: string, env?: NodeJS.ProcessEnv, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [options]
 * @returns {Promise<{ username: string, password: string }>}
 */
export async function getCredentials(options = {}) {
  const env = options.env ?? process.env;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  let username = options.user ?? env.ROCURL_USER ?? '';
  let password = options.pass ?? env.ROCURL_PASS ?? '';

  if (!username) {
    username = (await askLine('OpenVPN Username: ', { mask: false, input, output })).trim();
  }
  if (!username) {
    throw new Error('OpenVPN username cannot be empty.');
  }

  if (!password) {
    password = await askLine('OpenVPN Password: ', { mask: true, input, output });
  }
  if (!password) {
    throw new Error('OpenVPN password cannot be empty.');
  }

  return { username, password };
}
