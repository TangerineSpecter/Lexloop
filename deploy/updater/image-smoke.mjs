#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const identity = randomUUID();
const image = `lexloop-updater-smoke:${identity}`;
const container = `lexloop-updater-smoke-${identity.slice(0, 12)}`;
const socket = '/tmp/lexloop-updater-smoke.sock';
const state = '/tmp/lexloop-updater-smoke/update-state.json';
const buildxConfig = mkdtempSync(join(tmpdir(), 'lexloop-updater-buildx-'));
const dockerEnvironment = { ...process.env };
dockerEnvironment.BUILDX_CONFIG = buildxConfig;
for (const name of [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
]) {
  delete dockerEnvironment[name];
}

function docker(args, { timeout = 30_000, allowFailure = false } = {}) {
  const result = spawnSync('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    cwd: root,
    env: dockerEnvironment,
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `docker ${args[0]} exited ${result.status ?? 'without a status'}:\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function nodeInContainer(source) {
  return docker(['exec', container, 'node', '--input-type=module', '-e', source], {
    timeout: 5_000,
    allowFailure: true,
  });
}

let imageBuilt = false;
let containerCreated = false;
let dockerAvailable = false;
try {
  docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 });
  dockerAvailable = true;
  // Remove these unique names even if build/run failed after partially creating resources.
  imageBuilt = true;
  const build = docker(['build', '--file', 'deploy/updater/Dockerfile', '--tag', image, '.'], {
    timeout: 10 * 60_000,
  });
  console.log(`Built production updater Dockerfile: ${image}`);
  if (build.stdout.trim()) console.log(build.stdout.trim().split('\n').slice(-4).join('\n'));

  containerCreated = true;
  docker([
    'run',
    '--detach',
    '--network=none',
    '--name',
    container,
    '--label',
    `lexloop.updater-image-smoke=${identity}`,
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=16m',
    '--env',
    `UPDATER_SOCKET=${socket}`,
    '--env',
    `UPDATER_STATE_FILE=${state}`,
    '--env',
    'BARE_REPOSITORY=/tmp/uninitialized-test-repository.git',
    image,
  ]);
  const mounts = JSON.parse(
    docker(['inspect', '--format', '{{json .Mounts}}', container]).stdout.trim(),
  );
  assert.deepEqual(mounts, [], 'smoke container must not mount host files or Docker socket');

  const socketProbe = `
    import { lstatSync } from 'node:fs';
    const socket = lstatSync(${JSON.stringify(socket)});
    if (!socket.isSocket() || (socket.mode & 0o777) !== 0o660) process.exit(1);
  `;
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (nodeInContainer(socketProbe).status === 0) {
      ready = true;
      break;
    }
    const running = docker(['inspect', '--format', '{{.State.Running}}', container]).stdout.trim();
    if (running !== 'true') {
      const logs = docker(['logs', container], { allowFailure: true });
      throw new Error(`updater exited before socket readiness:\n${logs.stdout}${logs.stderr}`);
    }
    await delay(200);
  }
  assert.ok(ready, 'updater Unix socket did not become ready');

  const healthProbe = `
    import { request } from 'node:http';
    const requestValue = request({ socketPath: ${JSON.stringify(socket)}, method: 'GET', path: '/status', timeout: 3000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const status = JSON.parse(body);
          if (response.statusCode !== 200 || status.updaterAvailable !== true || status.checkInProgress !== false) process.exitCode = 1;
        } catch { process.exitCode = 1; }
      });
    });
    requestValue.on('timeout', () => { requestValue.destroy(); process.exitCode = 1; });
    requestValue.on('error', () => { process.exitCode = 1; });
    requestValue.end();
  `;
  const health = nodeInContainer(healthProbe);
  assert.equal(health.status, 0, `GET /status over updater socket failed: ${health.stderr}`);

  const hostSocketProbe = docker([
    'exec',
    container,
    'node',
    '-e',
    "const fs=require('node:fs');process.exit(fs.existsSync('/var/run/docker.sock')?1:0)",
  ]);
  assert.equal(hostSocketProbe.status, 0, 'smoke image must not have access to host Docker socket');
  console.log(
    'Updater image started; Unix socket mode and GET /status passed with no network or host mounts.',
  );
} finally {
  if (dockerAvailable) {
    if (containerCreated) {
      try {
        docker(['rm', '--force', container], { allowFailure: true });
      } catch (error) {
        console.error(`Could not remove smoke container ${container}: ${error.message}`);
      }
    }
    if (imageBuilt) {
      try {
        docker(['image', 'rm', '--force', image], { allowFailure: true });
      } catch (error) {
        console.error(`Could not remove smoke image ${image}: ${error.message}`);
      }
    }
  }
  try {
    rmSync(buildxConfig, { recursive: true, force: true });
  } catch (error) {
    console.error(`Could not remove temporary Buildx config ${buildxConfig}: ${error.message}`);
  }
}
