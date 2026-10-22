import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteBackups, validateSettings, encryptArchive, command } from './backup.mjs';
import { decryptBackup } from '../backup/decrypt.mjs';

const settings = {
  enabled: true,
  host: 'nas.example.com',
  port: 2222,
  username: 'backup',
  remotePath: '/backups/lexloop',
  hostKey: 'ssh-ed25519 AAAABBBB',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----',
  passphrase: 'offline-recovery-passphrase',
};
function fixture(t, execute) {
  const root = mkdtempSync(join(tmpdir(), 'lexloop-backup-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const productionEnv = join(root, 'production.env');
  writeFileSync(
    productionEnv,
    `AI_CONFIG_ENCRYPTION_KEY=${'ab'.repeat(32)}\nPOSTGRES_USER=lexloop\nPOSTGRES_DB=lexloop\n`,
  );
  return {
    root,
    config: { productionEnv, backupsDir: join(root, 'backups') },
    create: () => new RemoteBackups({ productionEnv, backupsDir: join(root, 'backups') }, execute),
  };
}

test('validation prevents SFTP batch injection, flags and invalid settings', () => {
  assert.deepEqual(validateSettings(settings), settings);
  for (const override of [
    { remotePath: '/ok\nrm /other' },
    { remotePath: '/dir with spaces' },
    { host: '-oProxyCommand=bad' },
    { username: '-bad' },
    { hostKey: 'ssh-ed25519 AAA\nother' },
    { port: 0 },
    { enabled: 'yes' },
    { passphrase: 'short' },
  ]) {
    assert.throws(() => validateSettings({ ...settings, ...override }));
  }
});

test('credentials are encrypted at rest and omitted from status; blank credentials preserve values', (t) => {
  const f = fixture(t);
  const backups = f.create();
  backups.save(settings);
  const raw = readFileSync(backups.settingsFile).toString();
  assert.ok(!raw.includes(settings.privateKey));
  assert.ok(!raw.includes(settings.passphrase));
  assert.equal(statSync(backups.settingsFile).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(backups.status()).includes(settings.passphrase));
  assert.equal(backups.status().settings.privateKey, undefined);
  backups.save({ ...settings, privateKey: '', passphrase: '' });
  assert.equal(f.create().settings().privateKey, settings.privateKey);
});

test('archive roundtrip uses only the offline password; corruption and wrong passwords leave no output', async (t) => {
  const f = fixture(t);
  const source = join(f.root, 'source');
  const encrypted = join(f.root, 'encrypted');
  writeFileSync(source, 'database and production secrets'.repeat(100000));
  await encryptArchive(source, encrypted, settings.passphrase);
  await decryptBackup(encrypted, join(f.root, 'restored'), settings.passphrase);
  assert.deepEqual(readFileSync(source), readFileSync(join(f.root, 'restored')));
  await assert.rejects(decryptBackup(encrypted, join(f.root, 'wrong'), 'wrong-password'));
  assert.ok(!existsSync(join(f.root, 'wrong.partial')));
  const data = readFileSync(encrypted);
  data[40] ^= 1;
  writeFileSync(encrypted, data);
  await assert.rejects(decryptBackup(encrypted, join(f.root, 'tampered'), settings.passphrase));
  assert.ok(!existsSync(join(f.root, 'tampered')));
});

test('uploads an encrypted database+config archive with pinned host key and atomic remote rename', async (t) => {
  let uploaded;
  let temporaryFile;
  const calls = [];
  const f = fixture(t, async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === 'docker') {
      writeFileSync(opts.stdio[1], 'database-content');
      return;
    }
    if (file === 'sftp') {
      const local = opts.input.match(/^put (\S+)/)[1];
      temporaryFile = local;
      uploaded = readFileSync(local);
      assert.ok(opts.input.includes('.partial\nrename '));
      assert.ok(args.includes('-oStrictHostKeyChecking=yes'));
      assert.ok(
        readFileSync(
          args.find((a) => a.startsWith('-oUserKnownHostsFile=')).split('=')[1],
          'utf8',
        ).startsWith('[nas.example.com]:2222 ssh-ed25519'),
      );
      return;
    }
    return command(file, args, opts);
  });
  const backups = f.create();
  backups.save(settings);
  await backups.run(settings);
  assert.ok(backups.status().lastSuccessAt);
  assert.equal(backups.status().error, null);
  const encrypted = join(f.root, 'uploaded');
  writeFileSync(encrypted, uploaded);
  const archive = join(f.root, 'archive.tar.gz');
  await decryptBackup(encrypted, archive, settings.passphrase);
  await command('tar', ['-xzf', archive, '-C', f.root]);
  assert.equal(readFileSync(join(f.root, 'database.dump'), 'utf8'), 'database-content');
  assert.ok(
    readFileSync(join(f.root, 'production.env'), 'utf8').includes('AI_CONFIG_ENCRYPTION_KEY='),
  );
  assert.ok(!existsSync(temporaryFile));
});

test('failed upload preserves previous success and exposes no command or credential details', async (t) => {
  const f = fixture(t, async (file, args, opts) => {
    if (file === 'docker') {
      writeFileSync(opts.stdio[1], 'dump');
      return;
    }
    if (file === 'sftp') throw new Error(settings.privateKey);
    return command(file, args, opts);
  });
  const backups = f.create();
  backups.save(settings);
  backups.state.lastSuccessAt = '2020-01-01T00:00:00Z';
  await backups.run(settings);
  assert.equal(backups.status().lastSuccessAt, '2020-01-01T00:00:00Z');
  assert.match(backups.status().error, /SFTP 上传失败/);
  assert.ok(!JSON.stringify(backups.status()).includes('PRIVATE KEY'));
});

test('scheduler retries after one hour, avoids concurrent jobs and marks interrupted tasks failed', async (t) => {
  const f = fixture(t);
  const backups = f.create();
  backups.save(settings);
  let count = 0;
  backups.start = () => {
    count++;
  };
  await backups.tick();
  assert.equal(count, 1);
  backups.state.lastAttemptAt = new Date().toISOString();
  await backups.tick();
  assert.equal(count, 1);
  backups.state.lastAttemptAt = new Date(Date.now() - 3600_001).toISOString();
  await backups.tick();
  assert.equal(count, 2);
  backups.state.running = true;
  backups.persist();
  assert.throws(() => backups.save(settings));
  await backups.tick();
  assert.equal(count, 2);
  const restarted = f.create();
  assert.equal(restarted.state.running, false);
  assert.match(restarted.state.error, /重启/);
  restarted.state.lastSuccessAt = new Date().toISOString();
  restarted.start = () => {
    count++;
  };
  await restarted.tick();
  assert.equal(count, 2);
});

test(
  'real SFTP upload verifies pinned host keys and supports remote-only recovery',
  { skip: !existsSync('/usr/sbin/sshd') || !existsSync('/usr/bin/ssh-keygen') },
  async (t) => {
    const { execFileSync, spawn } = await import('node:child_process');
    const { createServer, connect } = await import('node:net');
    const { userInfo } = await import('node:os');
    const { mkdirSync } = await import('node:fs');
    const { setTimeout: delay } = await import('node:timers/promises');
    const f = fixture(t, async (file, args, opts) => {
      if (file === 'docker') {
        writeFileSync(opts.stdio[1], 'remote-recoverable-database');
        return;
      }
      return command(file, args, opts);
    });
    const portServer = createServer();
    await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
    const port = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    for (const key of ['host', 'client'])
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(f.root, key)]);
    const destination = join(f.root, 'remote');
    mkdirSync(destination);
    const sshConfig = join(f.root, 'sshd_config');
    writeFileSync(
      sshConfig,
      `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(f.root, 'host')}\nPidFile ${join(f.root, 'sshd.pid')}\nAuthorizedKeysFile ${join(f.root, 'client.pub')}\nStrictModes no\nPasswordAuthentication no\nUsePAM no\nSubsystem sftp internal-sftp\n`,
    );
    const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', sshConfig], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let logs = '';
    sshd.stderr.on('data', (b) => (logs += b));
    t.after(() => sshd.kill());
    let ready = false;
    for (let i = 0; i < 50; i++) {
      ready = await new Promise((resolve) => {
        const socket = connect(port, '127.0.0.1');
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
      });
      if (ready || sshd.exitCode !== null) break;
      await delay(20);
    }
    assert.ok(ready, logs);
    const hostKey = readFileSync(join(f.root, 'host.pub'), 'utf8')
      .trim()
      .split(' ')
      .slice(0, 2)
      .join(' ');
    const configured = {
      ...settings,
      host: '127.0.0.1',
      port,
      username: userInfo().username,
      remotePath: destination,
      hostKey,
      privateKey: readFileSync(join(f.root, 'client'), 'utf8'),
    };
    const backups = f.create();
    backups.save(configured);
    await backups.run(configured);
    assert.equal(backups.state.error, null, logs);
    const remoteFile = join(destination, backups.state.lastFile);
    assert.ok(existsSync(remoteFile));
    // Original environment and stored credentials are no longer needed to decrypt the remote copy.
    rmSync(f.config.productionEnv);
    rmSync(backups.settingsFile);
    await decryptBackup(remoteFile, join(f.root, 'recovery.tar.gz'), settings.passphrase);
    await command('tar', ['-xzf', join(f.root, 'recovery.tar.gz'), '-C', f.root]);
    assert.equal(
      readFileSync(join(f.root, 'database.dump'), 'utf8'),
      'remote-recoverable-database',
    );
    assert.ok(
      readFileSync(join(f.root, 'production.env'), 'utf8').includes('AI_CONFIG_ENCRYPTION_KEY='),
    );
    await backups.run({
      ...configured,
      hostKey: readFileSync(join(f.root, 'client.pub'), 'utf8')
        .trim()
        .split(' ')
        .slice(0, 2)
        .join(' '),
    });
    assert.match(backups.state.error, /SFTP 上传失败/);
  },
);

test('a failed start persistence releases the lock and can retry after storage recovers', async (t) => {
  const { mkdirSync } = await import('node:fs');
  const f = fixture(t);
  const backups = f.create();
  backups.save(settings);
  mkdirSync(`${backups.statusFile}.tmp`);
  let started = 0;
  backups.run = async () => {
    started++;
    backups.state.running = false;
  };
  assert.throws(() => backups.start(), /状态保存失败/);
  assert.equal(backups.state.running, false);
  assert.match(backups.status().error, /磁盘空间/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 0);
  rmSync(`${backups.statusFile}.tmp`, { recursive: true });
  assert.equal(backups.start().running, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1);
});

test('failed final status persistence does not reject the task or keep it locked', async (t) => {
  const { mkdirSync } = await import('node:fs');
  const f = fixture(t, async () => {
    throw new Error('database unavailable');
  });
  const backups = f.create();
  backups.save(settings);
  backups.state.running = true;
  mkdirSync(`${backups.statusFile}.tmp`);
  await assert.doesNotReject(backups.run(settings));
  assert.equal(backups.state.running, false);
  assert.match(backups.status().error, /创建数据库/);
  assert.match(backups.status().error, /状态保存失败/);
  rmSync(`${backups.statusFile}.tmp`, { recursive: true });
  assert.doesNotThrow(() => backups.save(settings));
});

test('restart with an interrupted task tolerates unwritable status storage', async (t) => {
  const { mkdirSync } = await import('node:fs');
  const f = fixture(t);
  const backups = f.create();
  backups.save(settings);
  backups.state.running = true;
  backups.persist();
  mkdirSync(`${backups.statusFile}.tmp`);
  const restarted = f.create();
  assert.equal(restarted.state.running, false);
  assert.match(restarted.status().error, /重启/);
  assert.match(restarted.status().error, /状态保存失败/);
});

test('corrupt configuration remains visible and requires explicit full replacement', (t) => {
  const f = fixture(t);
  const backups = f.create();
  backups.save(settings);
  writeFileSync(backups.settingsFile, 'corrupt config');
  const broken = readFileSync(backups.settingsFile);
  const status = backups.status();
  assert.equal(status.available, true);
  assert.equal(status.settings, null);
  assert.match(status.configurationError, /无法解密/);
  assert.throws(() => backups.save(settings), /确认替换/);
  assert.throws(() => backups.save({ ...settings, privateKey: '', resetConfig: true }));
  assert.throws(() => backups.save({ ...settings, passphrase: '', resetConfig: true }));
  assert.deepEqual(readFileSync(backups.settingsFile), broken);
  const recovered = backups.save({ ...settings, resetConfig: true });
  assert.equal(recovered.configurationError, null);
  assert.equal(recovered.settings.host, settings.host);
  assert.equal(backups.settings().resetConfig, undefined);
});

test('configuration can be replaced after production encryption key rotation', (t) => {
  const f = fixture(t);
  const backups = f.create();
  backups.save(settings);
  writeFileSync(
    f.config.productionEnv,
    `AI_CONFIG_ENCRYPTION_KEY=${'cd'.repeat(32)}\nPOSTGRES_USER=lexloop\nPOSTGRES_DB=lexloop\n`,
  );
  assert.match(backups.status().configurationError, /无法解密/);
  backups.save({ ...settings, resetConfig: true });
  assert.equal(f.create().settings().passphrase, settings.passphrase);
});

test('an unexpected asynchronous task rejection is handled and releases the lock', async (t) => {
  const f = fixture(t);
  const backups = f.create();
  backups.save(settings);
  backups.run = async () => {
    throw new Error('unexpected failure');
  };
  backups.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backups.state.running, false);
  assert.match(backups.status().error, /意外中断/);
  assert.equal(f.create().state.running, false);
});
