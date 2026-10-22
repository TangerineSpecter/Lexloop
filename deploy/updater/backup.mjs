import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

export function validateSettings(input, previous = {}) {
  const value = {
    ...input,
    privateKey: input.privateKey || previous.privateKey,
    passphrase: input.passphrase || previous.passphrase,
  };
  if (
    typeof value.enabled !== 'boolean' ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    typeof value.host !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(value.host) ||
    typeof value.username !== 'string' ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(value.username) ||
    typeof value.remotePath !== 'string' ||
    !/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/?)*$/.test(value.remotePath) ||
    value.remotePath.length > 500 ||
    typeof value.hostKey !== 'string' ||
    !/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,3}$/.test(value.hostKey) ||
    value.hostKey.length > 4096 ||
    typeof value.privateKey !== 'string' ||
    value.privateKey.length > 16384 ||
    !value.privateKey.includes('PRIVATE KEY-----') ||
    typeof value.passphrase !== 'string' ||
    value.passphrase.length < 16 ||
    value.passphrase.length > 1024
  ) {
    throw new Error(
      '请检查 SFTP 地址、端口、用户名、绝对目录、主机公钥、SSH 私钥和至少 16 位的备份解密口令',
    );
  }
  return Object.fromEntries(
    [
      'enabled',
      'host',
      'port',
      'username',
      'remotePath',
      'hostKey',
      'privateKey',
      'passphrase',
    ].map((key) => [key, value[key]]),
  );
}

function encrypt(data, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function decrypt(data, key) {
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
}

// Archive format: LXBACK01 | salt(16) | iv(12) | ciphertext | GCM tag(16).
export async function encryptArchive(source, target, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
  const output = createWriteStream(target, { mode: 0o600 });
  output.write(Buffer.concat([Buffer.from('LXBACK01'), salt, iv]));
  await pipeline(createReadStream(source), cipher, output, { end: false });
  await new Promise((resolve, reject) => {
    output.once('error', reject);
    output.end(cipher.getAuthTag(), resolve);
  });
}

export function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      ...options,
      timeout: options.timeout ?? 30 * 60_000,
    });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error('备份命令执行失败'))));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}

export class RemoteBackups {
  constructor(config, execute = command) {
    this.config = config;
    this.execute = execute;
    this.settingsFile = join(dirname(config.productionEnv), 'remote-backup.enc');
    this.statusFile = join(config.backupsDir, 'remote-status.json');
    this.workDir = join(config.backupsDir, '.remote-work');
    // Only this service owns this directory; remove plaintext left by an interrupted run.
    rmSync(this.workDir, { recursive: true, force: true });
    try {
      this.state = existsSync(this.statusFile)
        ? JSON.parse(readFileSync(this.statusFile, 'utf8'))
        : {};
    } catch {
      this.state = { error: '备份状态文件损坏，请重新执行备份并检查磁盘' };
    }
    if (this.state.running) {
      this.state.running = false;
      this.state.error = '备份服务重启，上一任务未完成，请重试';
      this.tryPersist();
    }
  }
  key() {
    const env = readFileSync(this.config.productionEnv, 'utf8');
    const key = env.match(/^AI_CONFIG_ENCRYPTION_KEY=([a-fA-F0-9]{64})\r?$/m)?.[1];
    if (!key) throw new Error('生产配置缺少有效的加密密钥');
    return Buffer.from(key, 'hex');
  }
  settings() {
    return existsSync(this.settingsFile)
      ? JSON.parse(decrypt(readFileSync(this.settingsFile), this.key()).toString())
      : null;
  }
  status() {
    let settings = null;
    let configurationError = null;
    try {
      settings = this.settings();
    } catch {
      configurationError =
        '远端备份配置无法解密。请重新填写全部配置并确认替换；旧备份仍需原解密口令。';
    }
    const { privateKey, passphrase, ...safe } = settings ?? {};
    return {
      available: true,
      configurationError,
      settings: settings
        ? { ...safe, hasPrivateKey: !!privateKey, hasPassphrase: !!passphrase }
        : null,
      ...this.state,
      stale:
        !!settings?.enabled &&
        (!this.state.lastSuccessAt ||
          Date.now() - Date.parse(this.state.lastSuccessAt) > 26 * 3600_000),
    };
  }
  save(input) {
    if (this.state.running) throw new Error('备份正在执行，请完成后再修改配置');
    let previous = {};
    if (input.resetConfig !== true) {
      try {
        previous = this.settings() ?? {};
      } catch {
        throw new Error('现有备份配置无法解密，请填写全部配置并确认替换');
      }
    }
    const settings = validateSettings(input, previous);
    mkdirSync(dirname(this.settingsFile), { recursive: true, mode: 0o700 });
    writeFileSync(
      `${this.settingsFile}.tmp`,
      encrypt(Buffer.from(JSON.stringify(settings)), this.key()),
      { mode: 0o600 },
    );
    renameSync(`${this.settingsFile}.tmp`, this.settingsFile);
    // A changed destination is not protected until a new upload succeeds.
    this.state = {
      ...this.state,
      lastSuccessAt: null,
      lastFile: null,
      error: null,
      lastAttemptAt: null,
    };
    this.tryPersist();
    return this.status();
  }
  tryPersist() {
    try {
      this.persist();
      return true;
    } catch {
      this.state.error = [this.state.error, '备份状态保存失败，请检查磁盘空间和目录权限']
        .filter(Boolean)
        .join('；');
      console.error('备份状态保存失败，请检查磁盘空间和目录权限');
      return false;
    }
  }
  persist() {
    mkdirSync(this.config.backupsDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${this.statusFile}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(`${this.statusFile}.tmp`, this.statusFile);
  }
  start() {
    if (this.state.running) throw new Error('已有备份任务正在执行');
    const settings = this.settings();
    if (!settings) throw new Error('请先保存远端备份配置');
    const previous = this.state;
    this.state = {
      ...previous,
      running: true,
      lastAttemptAt: new Date().toISOString(),
      error: null,
    };
    if (!this.tryPersist()) {
      const error = this.state.error;
      this.state = { ...previous, running: false, error };
      throw new Error(error);
    }
    setImmediate(() => {
      void this.run(settings).catch(() => {
        this.state.running = false;
        this.state.error = '备份任务意外中断，请检查服务日志后重试';
        this.tryPersist();
      });
    });
    return this.status();
  }
  async tick() {
    try {
      const settings = this.settings();
      if (!settings?.enabled || this.state.running) return;
      const sinceSuccess = this.state.lastSuccessAt
        ? Date.now() - Date.parse(this.state.lastSuccessAt)
        : Infinity;
      const sinceAttempt = this.state.lastAttemptAt
        ? Date.now() - Date.parse(this.state.lastAttemptAt)
        : Infinity;
      if (sinceSuccess >= 24 * 3600_000 && sinceAttempt >= 3600_000) this.start();
    } catch {
      console.error('远端备份调度失败，请检查生产配置和备份状态');
    }
  }
  async run(settings) {
    let temporary;
    let stage = '创建数据库和配置备份失败';
    try {
      mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
      temporary = mkdtempSync(join(this.workDir, 'run-'));
      const env = readFileSync(this.config.productionEnv, 'utf8');
      const envValue = (name) => env.match(new RegExp(`^${name}=([a-zA-Z0-9_]+)\\r?$`, 'm'))?.[1];
      const user = envValue('POSTGRES_USER');
      const db = envValue('POSTGRES_DB');
      if (!user || !db) throw new Error('数据库配置无效');
      const dump = join(temporary, 'database.dump');
      const output = openSync(dump, 'w', 0o600);
      try {
        await this.execute(
          'docker',
          ['exec', 'lexloop-postgres', 'pg_dump', '-U', user, '-d', db, '-Fc'],
          { stdio: ['pipe', output, 'ignore'] },
        );
      } finally {
        closeSync(output);
      }
      writeFileSync(join(temporary, 'production.env'), env, { mode: 0o600 });
      writeFileSync(
        join(temporary, 'manifest.json'),
        JSON.stringify({
          format: 1,
          createdAt: this.state.lastAttemptAt,
          version: env.match(/^APP_VERSION=(.+)$/m)?.[1],
          sha: env.match(/^APP_COMMIT_SHA=(.+)$/m)?.[1],
          includes: ['database.dump', 'production.env'],
          excludes: ['Redis queues', 'MinIO objects'],
        }),
        { mode: 0o600 },
      );
      const archive = join(temporary, 'backup.tar.gz');
      await this.execute('tar', [
        '-czf',
        archive,
        '-C',
        temporary,
        'database.dump',
        'production.env',
        'manifest.json',
      ]);
      const file = `lexloop-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.lxbackup`;
      const encrypted = join(temporary, file);
      await encryptArchive(archive, encrypted, settings.passphrase);
      writeFileSync(join(temporary, 'identity'), settings.privateKey.trim() + '\n', {
        mode: 0o600,
      });
      const host = settings.port === 22 ? settings.host : `[${settings.host}]:${settings.port}`;
      writeFileSync(join(temporary, 'known_hosts'), `${host} ${settings.hostKey}\n`, {
        mode: 0o600,
      });
      stage = 'SFTP 上传失败，请检查网络、主机公钥、未加密的 SSH 私钥和远端目录写入权限';
      const remote = `${settings.remotePath.replace(/\/$/, '')}/${file}`;
      await this.execute(
        'sftp',
        [
          '-F',
          '/dev/null',
          '-b',
          '-',
          '-P',
          String(settings.port),
          '-i',
          join(temporary, 'identity'),
          '-oBatchMode=yes',
          '-oIdentitiesOnly=yes',
          '-oIdentityAgent=none',
          '-oStrictHostKeyChecking=yes',
          '-oConnectTimeout=20',
          `-oUserKnownHostsFile=${join(temporary, 'known_hosts')}`,
          '-oGlobalKnownHostsFile=/dev/null',
          `${settings.username}@${settings.host}`,
        ],
        { input: `put ${encrypted} ${remote}.partial\nrename ${remote}.partial ${remote}\n` },
      );
      this.state.lastSuccessAt = new Date().toISOString();
      this.state.lastFile = file;
      this.state.error = null;
    } catch {
      this.state.error = stage;
    } finally {
      try {
        if (temporary) rmSync(temporary, { recursive: true, force: true });
      } catch {
        this.state.error = [this.state.error, '备份临时文件清理失败，请检查目录权限']
          .filter(Boolean)
          .join('；');
      } finally {
        this.state.running = false;
        this.tryPersist();
      }
    }
  }
}
