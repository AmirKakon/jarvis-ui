import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolGuard, runClaudeAgent } from './claude-agent.js';

const ROOT = '/home/iot/repos/jarvis-ui/jarvis-home';

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/home/iot/jarvis' });
const write = (file_path, cwd = ROOT) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd });
const decision = async (guard, input) => (await guard(input)).hookSpecificOutput?.permissionDecision || 'allow';

test('delegate guard blocks destructive commands', async () => {
  const guard = toolGuard();
  for (const cmd of [
    'rm -rf /', 'sudo rm -rf / --no-preserve-root', 'rm -rf ~', 'rm -rf $HOME/', 'cd /tmp && rm -rf /home/iot',
    'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda bs=1M', 'cat x > /dev/sda',
    'sudo reboot', 'ls && shutdown -h now', 'systemctl poweroff', ':(){ :|:& };:',
  ]) {
    assert.equal(await decision(guard, bash(cmd)), 'deny', cmd);
  }
});

test('delegate guard allows routine server work', async () => {
  const guard = toolGuard();
  for (const cmd of [
    'docker restart nginx', 'systemctl --user restart jarvis-ustreamer', 'rm -rf /tmp/build-cache',
    'grep -i reboot /var/log/syslog', 'df -h', 'git -C ~/repos/jarvis-ui pull', 'source ~/jarvis/.env && curl -s $HA_URL/api/',
  ]) {
    assert.equal(await decision(guard, bash(cmd)), 'allow', cmd);
  }
});

test('no agent may edit a .env file; examples are fine', async () => {
  const guard = toolGuard();
  assert.equal(await decision(guard, write('/home/iot/jarvis/.env')), 'deny');
  assert.equal(await decision(guard, write('.env.local', '/home/iot/jarvis')), 'deny');
  assert.equal(await decision(guard, write('/home/iot/jarvis/env.example')), 'allow');
  assert.equal(await decision(guard, write('/home/iot/jarvis/.env.example')), 'allow');
});

test('shell commands may read .env but not write it', async () => {
  const guard = toolGuard();
  for (const cmd of [
    "echo '# test' >> ~/jarvis/.env", 'echo X=1 > .env', 'printf x | tee -a /home/iot/jarvis/.env',
    "sed -i 's/A=1/A=2/' ~/jarvis/.env", 'cp /tmp/new ~/jarvis/.env', 'rm ~/jarvis/.env', 'mv .env.local /tmp/x && echo ok > .env.local',
  ]) {
    assert.equal(await decision(guard, bash(cmd)), 'deny', cmd);
  }
  for (const cmd of [
    'source ~/jarvis/.env && curl -s $HA_URL/api/', '. ~/jarvis/.env', 'grep HA_URL ~/jarvis/.env',
    'cp env.example /tmp/x', "sed -i 's/a/b/' ~/jarvis/env.example", 'echo ok > /tmp/log.txt', 'docker compose --env-file .env up -d',
  ]) {
    assert.equal(await decision(guard, bash(cmd)), 'allow', cmd);
  }
});

test('self-development edits stay under the repo checkout', async () => {
  const guard = toolGuard({ writeRoot: ROOT, editOnly: true });
  assert.equal(await decision(guard, write('telegram-bot/src/agents/foo.js')), 'allow');
  assert.equal(await decision(guard, write(`${ROOT}/scripts/x.sh`)), 'allow');
  assert.equal(await decision(guard, write('/home/iot/jarvis/scripts/x.sh')), 'deny');
  assert.equal(await decision(guard, write('../backend/main.py')), 'deny');
  assert.equal(await decision(guard, write(`${ROOT}-evil/x.js`)), 'deny');
  assert.equal(await decision(guard, { tool_name: 'Edit', tool_input: { file_path: '/etc/hosts' }, cwd: ROOT }), 'deny');
});

test('self-development may read git state but not change it or touch services', async () => {
  const guard = toolGuard({ writeRoot: ROOT, editOnly: true });
  assert.equal(await decision(guard, bash('git diff --stat')), 'allow');
  assert.equal(await decision(guard, bash('git status --porcelain')), 'allow');
  assert.equal(await decision(guard, bash('git commit -am "x"')), 'deny');
  assert.equal(await decision(guard, bash('git push origin main')), 'deny');
  assert.equal(await decision(guard, bash('systemctl --user restart jarvis-telegram-bot')), 'deny');
});

function fakeQuery(messages, seen) {
  return ({ prompt, options }) => {
    seen.push({ prompt, options });
    return (async function* () { for (const m of messages) yield m; })();
  };
}

test('runClaudeAgent returns the result text and passes the expected options', async () => {
  const seen = [];
  const guard = toolGuard();
  const res = await runClaudeAgent({
    prompt: 'check disk', model: 'claude-haiku-5-5', cwd: '/home/iot/jarvis', timeoutMs: 5_000, guard,
    queryFn: fakeQuery([{ type: 'system' }, { type: 'result', subtype: 'success', is_error: false, result: ' Disk is fine, Sir. ' }], seen),
  });

  assert.deepEqual(res, { ok: true, output: 'Disk is fine, Sir.', status: 'done' });
  const { options } = seen[0];
  assert.equal(options.model, 'claude-haiku-5-5');
  assert.equal(options.cwd, '/home/iot/jarvis');
  assert.equal(options.permissionMode, 'bypassPermissions');
  assert.ok(options.settingSources.includes('project'));
  assert.equal(options.hooks.PreToolUse[0].hooks[0], guard);
  assert.equal(options.hooks.PreToolUse[0].onFailure, 'block');
});

test('runClaudeAgent reports an error result as a failure', async () => {
  const res = await runClaudeAgent({
    prompt: 'x', model: 'm', cwd: '/', timeoutMs: 5_000,
    queryFn: fakeQuery([{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached max turns'] }], []),
  });
  assert.deepEqual(res, { ok: false, output: 'Reached max turns', status: 'failed' });
});

test('runClaudeAgent aborts on timeout', async () => {
  const queryFn = ({ options }) => (async function* () {
    await new Promise((_, reject) => options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  })();
  const res = await runClaudeAgent({ prompt: 'x', model: 'm', cwd: '/', timeoutMs: 20, queryFn });
  assert.equal(res.status, 'timeout');
  assert.equal(res.ok, false);
});

test('runClaudeAgent turns a thrown error into a failure, never a rejection', async () => {
  const queryFn = () => (async function* () { throw new Error('spawn failed'); })();
  const res = await runClaudeAgent({ prompt: 'x', model: 'm', cwd: '/', timeoutMs: 5_000, queryFn });
  assert.deepEqual(res, { ok: false, output: 'spawn failed', status: 'failed' });
});
