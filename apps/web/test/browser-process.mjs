import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function spawnChromium(executable, args, options) {
  const subreaper = process.env.LAB_CHROMIUM_SUBREAPER;
  if (process.platform === 'linux' && subreaper)
    return spawn(subreaper, [executable, ...args], options);
  return spawn(executable, args, options);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return true;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    child.once('close', onClose);
    if (hasExited(child)) finish(true);
  });
}

async function requestBrowserClose(profileDirectory) {
  let port;
  try {
    port = Number(
      (await readFile(join(profileDirectory, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
    );
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) return false;
    const { webSocketDebuggerUrl } = await response.json();
    if (!webSocketDebuggerUrl) return false;

    const socket = new WebSocket(webSocketDebuggerUrl);
    socket.addEventListener('error', () => {}, { once: true });
    try {
      let connectTimer;
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', () => reject(new Error('CDP connection failed')), {
              once: true,
            });
          }),
          new Promise((_, reject) => {
            connectTimer = setTimeout(() => reject(new Error('CDP connection timed out')), 1_000);
          }),
        ]);
      } finally {
        clearTimeout(connectTimer);
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(), 1_000);
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        socket.addEventListener(
          'message',
          (event) => {
            try {
              if (JSON.parse(event.data).id === 1) finish();
            } catch {
              // Ignore unrelated or malformed DevTools messages.
            }
          },
          { once: false },
        );
        socket.addEventListener('close', finish, { once: true });
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      });
      return true;
    } finally {
      if (socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
    }
  } catch {
    return false;
  }
}

function signalOwnedProcessGroup(child, signal) {
  if (!child.pid || child.pid <= 1) return;
  try {
    if (
      process.platform === 'win32' ||
      (process.platform === 'linux' && process.env.LAB_CHROMIUM_SUBREAPER)
    )
      child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The Chromium process may already have exited.
  }
}

/** Gracefully close this test's isolated Chromium profile before terminating its process group. */
export async function closeChromium(child, profileDirectory) {
  if (!child?.pid || hasExited(child)) return;

  await requestBrowserClose(profileDirectory);
  if (await waitForExit(child, 5_000)) return;

  signalOwnedProcessGroup(child, 'SIGTERM');
  if (await waitForExit(child, process.env.LAB_CHROMIUM_SUBREAPER ? 3_500 : 1_500)) return;

  if (process.platform === 'linux' && process.env.LAB_CHROMIUM_SUBREAPER) {
    throw new Error(`Chromium subreaper process ${child.pid} did not reap its browser children.`);
  }

  signalOwnedProcessGroup(child, 'SIGKILL');
  if (await waitForExit(child, 1_500)) return;

  throw new Error(`Chromium test process ${child.pid ?? '(unknown)'} did not exit cleanly.`);
}
