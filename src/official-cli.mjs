import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const active = new Set();
const expectedModels = {
  'laguna-s': 'poolside/laguna-s-2.1',
  'deepseek-flash-starter': 'deepseek/deepseek-v4.1-flash-1017',
  'glm-5.3-flash-starter': 'z-ai/glm-5.3-flash',
  'minimax-m3.1-flash-starter': 'minimax/minimax-m3.1-flash',
};

function failure(message, code, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

// Runs the unmodified official CLI. Never recreates or forges a turn ticket.
export async function runOfficialCli({ session, model, message, threadId, signal }) {
  if (!expectedModels[model]) throw failure('这个桌面模型没有可用的 CLI 路由。', 'cli_model_unavailable', 400);
  if (!session?.access_token || !session.user?.id) throw failure('请重新导入 Cookie。', 'not_authenticated', 401);
  const key = createHash('sha256').update(session.user.id + ':' + threadId).digest('hex');
  if (active.has(key)) throw failure('这个对话仍在响应，请等本轮完成。', 'thread_busy', 409);
  active.add(key);
  let dir;
  try {
    const historyDir = path.join(root, 'data', 'cli-history');
    await mkdir(historyDir, { recursive: true, mode: 0o700 });
    const historyPath = path.join(historyDir, key + '.json');
    let history = [];
    try { history = JSON.parse(await readFile(historyPath, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw failure('无法读取此对话的 CLI 历史。', 'history_read_failed'); }
    const turns = [...history, { role: 'user', content: message }];
    const prompt = 'Answer the final user message. Do not use tools.\n' +
      (history.length ? 'Conversation (JSON):\n' + JSON.stringify(turns) : message);
    if (prompt.length > 64000) throw failure('当前 CLI 对话上下文过长，请新建对话。', 'context_too_long', 400);
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'perch-adapter-cli-')));
    const workspace = path.join(dir, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(dir, 'cli-auth-session.json'), JSON.stringify({
      version: 1, appUrl: 'https://app.perchai.app', accessToken: session.access_token,
      // The adapter alone refreshes the original Cookie; child processes cannot rotate it.
      refreshToken: null, expiresAt: session.expires_at, userId: session.user.id,
      updatedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    const cli = await realpath(require.resolve('perchai-cli/dist/perch.mjs'));
    const modules = await realpath(path.join(root, 'node_modules'));
    // Only pass the environment needed for the official client. Isolate its settings
    // and prevent it from reading user files or invoking local child-process tools.
    const env = { PATH: process.env.PATH, LANG: process.env.LANG || 'en_US.UTF-8',
      PERCH_HOME: dir, PERCH_CLI_AUTH_DIR: dir, PERCH_CLI_HISTORY: '0',
      PERCH_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' };
    for (const name of ['PERCH_CLI_STATE_DIR','PERCH_CLI_SETTINGS_DIR','PERCH_CLI_CONSENT_DIR',
      'PERCH_CLI_GRANTS_DIR','PERCH_CLI_SPLASH_DIR','PERCH_CLI_TELEMETRY_DIR','PERCH_BACKGROUND_TASK_DIR']) env[name] = dir;
    const args = ['--permission', '--allow-fs-read=' + modules, '--allow-fs-read=' + dir,
      '--allow-fs-write=' + dir, '--allow-addons', cli, 'run', prompt,
      '--json', '--no-local-tools', '--permission', 'plan', '--mode', 'ask',
      '--model', model, '--thread', 'adapter-' + key, '--cwd', workspace];
    signal?.throwIfAborted();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: workspace, env, stdio: ['ignore','pipe','pipe'] });
      let stdout = '', bytes = 0, stopError = null, killTimer;
      const stop = error => {
        if (stopError) return;
        stopError = error;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      };
      const abort = () => stop(signal.reason || new DOMException('Stopped', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop(failure('官方 CLI 响应超时。', 'cli_timeout', 504)), 180000);
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 24 * 1024 * 1024) stop(failure('官方 CLI 输出超过限制。', 'cli_output_limit'));
        else stdout += chunk;
      });
      child.stderr.resume(); // Do not leak context or credentials into logs.
      const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', code => {
        cleanup();
        if (stopError) return reject(stopError);
        let data;
        try { data = JSON.parse(stdout); }
        catch { return reject(failure('官方 CLI 未返回有效结果（退出码 ' + code + '）。', 'cli_invalid_response')); }
        if (!data.ok || code !== 0) {
          const safe = String(data.error || '官方 CLI 调用失败。').replaceAll(session.access_token, '[redacted]');
          return reject(failure(safe, 'cli_upstream_error'));
        }
        resolve(data);
      });
    });
    const context = result.contextSnapshot || {};
    if (context.modelId !== expectedModels[model] || !context.lastApiUsage) {
      throw failure('CLI 没有返回与所选模型匹配的调用记录，本轮不视为成功。', 'model_identity_unverified');
    }
    const text = String(result.assistantText || '');
    if (!text) throw failure('官方 CLI 返回空内容。', 'cli_empty_response');
    await writeFile(historyPath, JSON.stringify([...turns, { role: 'assistant', content: text }]), { mode: 0o600 });
    return { text, model: context.modelId, modelLabel: context.modelLabel || model,
      provider: context.provider, usage: context.turnApiUsage || context.lastApiUsage,
      durationMs: result.durationMs, runId: result.runId, transport: 'official-cli',
      // This is the official client's reported call identity, not provider attestation.
      identityEvidence: 'cli-context-and-api-usage' };
  } finally {
    active.delete(key);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
