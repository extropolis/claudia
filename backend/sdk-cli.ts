/**
 * sdk-cli.ts — focused test CLI for the SDK task path.
 *
 * This is a sibling to test-cli.ts that exercises only the new SDK endpoints
 * (POST /api/sdk-tasks, /:id/continue, /:id/abort, /:id/permission). It
 * connects to the running backend via HTTP + WebSocket, drives an SDK task
 * end-to-end, and pretty-prints conversation events as they stream.
 *
 * Usage examples:
 *   npx tsx sdk-cli.ts run "what is 2+2"                  # one-shot prompt
 *   npx tsx sdk-cli.ts run "list files" --cwd /tmp        # set workspace
 *   npx tsx sdk-cli.ts run "edit foo.ts" --auto-approve   # auto-allow tools
 *   npx tsx sdk-cli.ts list                               # list active SDK tasks
 *   npx tsx sdk-cli.ts abort <taskId>                     # abort a task
 *   npx tsx sdk-cli.ts watch <taskId>                     # tail a running task
 *
 * Requires the backend to be running on port 4001 (Claudia's normal port —
 * NEVER touch port 4001 directly; use `./start.sh` once if not running).
 */
import WebSocket from 'ws';

const BACKEND = process.env.CLAUDIA_BACKEND || 'http://localhost:4001';
const WS_URL = BACKEND.replace(/^http/, 'ws');

type ConvEvent = {
  uuid: string;
  taskId: string;
  type: string;
  text?: string;
  tool?: { name: string; input: Record<string, unknown>; toolUseId: string };
  toolResult?: { toolUseId: string; output: string; isError?: boolean };
  meta?: Record<string, unknown>;
};

type WSMsg = { type: string; payload: any };

interface RunOptions {
  prompt: string;
  cwd: string;
  autoApprove: boolean;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  systemPrompt?: string;
  resumeSessionId?: string;
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${BACKEND}${path}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

function fmtEvent(ev: ConvEvent): string {
  switch (ev.type) {
    case 'session_meta':
      return `🆔 session ${ev.meta?.model ?? ''} cwd=${ev.meta?.cwd ?? ''}`;
    case 'assistant_message':
      return `🤖 ${ev.text ?? ''}`;
    case 'thinking':
      return `💭 ${(ev.text ?? '').slice(0, 200)}${(ev.text ?? '').length > 200 ? '…' : ''}`;
    case 'tool_call': {
      const inputStr = JSON.stringify(ev.tool?.input ?? {}).slice(0, 200);
      return `🔧 ${ev.tool?.name}(${inputStr}${inputStr.length === 200 ? '…' : ''})`;
    }
    case 'tool_result': {
      const out = (ev.toolResult?.output ?? '').slice(0, 300);
      const truncMark = (ev.toolResult?.output?.length ?? 0) > 300 ? '…' : '';
      const errMark = ev.toolResult?.isError ? '❌ ' : '↩️ ';
      return `${errMark}${out}${truncMark}`;
    }
    case 'user_message':
      return `🧑 ${ev.text ?? ''}`;
    case 'system':
      return `ℹ️  ${ev.text ?? ''}`;
    case 'summary':
      return `📋 ${ev.text ?? ''}`;
    default:
      return `[${ev.type}] ${ev.text ?? JSON.stringify(ev.meta ?? {})}`;
  }
}

async function cmdRun(opts: RunOptions): Promise<void> {
  console.log(`▶ creating SDK task in ${opts.cwd}`);
  const { task } = await http<{ task: { id: string } }>('POST', '/api/sdk-tasks', {
    workspaceId: opts.cwd,
    cwd: opts.cwd,
    prompt: opts.prompt,
    permissionMode: opts.permissionMode,
    systemPrompt: opts.systemPrompt,
    resumeSessionId: opts.resumeSessionId,
  });
  console.log(`▶ task created: ${task.id}`);

  await tailTask(task.id, opts.autoApprove);
}

async function cmdContinue(taskId: string, prompt: string, autoApprove: boolean): Promise<void> {
  console.log(`▶ continuing task ${taskId}`);
  await http('POST', `/api/sdk-tasks/${encodeURIComponent(taskId)}/continue`, { prompt });
  await tailTask(taskId, autoApprove);
}

async function cmdAbort(taskId: string): Promise<void> {
  console.log(`▶ aborting ${taskId}`);
  await http('POST', `/api/sdk-tasks/${encodeURIComponent(taskId)}/abort`);
  console.log(`✓ aborted`);
}

async function cmdList(): Promise<void> {
  const { tasks } = await http<{ tasks: Array<{ id: string; state: string; prompt: string; sessionId: string | null }> }>('GET', '/api/sdk-tasks');
  if (tasks.length === 0) {
    console.log('(no active SDK tasks)');
    return;
  }
  for (const t of tasks) {
    console.log(`${t.id}  [${t.state}]  session=${t.sessionId ?? '—'}  ${t.prompt.slice(0, 60)}`);
  }
}

async function cmdWatch(taskId: string, autoApprove: boolean): Promise<void> {
  // Initial snapshot
  const snap = await http<{
    task: { id: string; state: string };
    events: ConvEvent[];
    pendingPermissions: Array<{ requestId: string; toolName: string; input: Record<string, unknown> }>;
  }>('GET', `/api/sdk-tasks/${encodeURIComponent(taskId)}/snapshot`);
  for (const ev of snap.events) console.log(fmtEvent(ev));
  await tailTask(taskId, autoApprove);
}

async function tailTask(taskId: string, autoApprove: boolean): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}/`);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve();
    };

    process.once('SIGINT', () => {
      console.log('\n⏸  SIGINT — aborting task');
      void http('POST', `/api/sdk-tasks/${encodeURIComponent(taskId)}/abort`).catch(() => {
        // ignore
      });
      setTimeout(finish, 500);
    });

    ws.on('open', () => {
      // Server sends `init` first; we just wait for events for our task.
    });

    ws.on('message', async (data) => {
      let msg: WSMsg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'task:conversation:event' && msg.payload?.taskId === taskId) {
        console.log(fmtEvent(msg.payload.event));
      } else if (msg.type === 'task:conversation:restore' && msg.payload?.taskId === taskId) {
        for (const ev of msg.payload.events ?? []) console.log(fmtEvent(ev));
      } else if (msg.type === 'task:stateChanged' && msg.payload?.task?.id === taskId) {
        console.log(`◆ state → ${msg.payload.task.state}`);
        if (msg.payload.task.state === 'idle' || msg.payload.task.state === 'exited' || msg.payload.task.state === 'interrupted') {
          // Run complete or aborted — wrap up shortly to let any trailing events arrive.
          setTimeout(finish, 250);
        }
      } else if (msg.type === 'sdk:permission:request' && msg.payload?.taskId === taskId) {
        const { requestId, toolName, input } = msg.payload;
        const inputStr = JSON.stringify(input).slice(0, 200);
        console.log(`🔐 permission requested: ${toolName}(${inputStr})`);
        if (autoApprove) {
          console.log(`   → auto-approving`);
          await http('POST', `/api/sdk-tasks/${encodeURIComponent(taskId)}/permission/${requestId}`, {
            allow: true,
          }).catch((e) => console.error(`   approval failed: ${e.message}`));
        } else {
          console.log(`   (denied — pass --auto-approve to allow)`);
          await http('POST', `/api/sdk-tasks/${encodeURIComponent(taskId)}/permission/${requestId}`, {
            allow: false,
            message: 'sdk-cli denied by default',
          }).catch((e) => console.error(`   denial failed: ${e.message}`));
        }
      } else if (msg.type === 'sdk:task:complete' && msg.payload?.taskId === taskId) {
        const r = msg.payload.result ?? {};
        console.log(`✅ complete · turns=${r.numTurns} cost=$${(r.totalCostUsd ?? 0).toFixed(4)} err=${r.isError}`);
        setTimeout(finish, 200);
      } else if (msg.type === 'task:stopped' && msg.payload?.taskId === taskId) {
        console.log(`⏹  stopped: ${msg.payload.reason ?? 'unknown'}`);
        setTimeout(finish, 200);
      } else if (msg.type === 'error' && msg.payload?.taskId === taskId) {
        console.error(`❌ error: ${msg.payload.message}`);
        setTimeout(finish, 200);
      }
    });

    ws.on('error', (err) => {
      console.error(`WS error: ${err.message}`);
      finish();
    });

    ws.on('close', () => {
      finish();
    });
  });
}

function help(): void {
  console.log(
    [
      'sdk-cli — drive Claudia SDK tasks end-to-end',
      '',
      'Commands:',
      '  run "<prompt>" [opts]                Create + watch an SDK task',
      '  continue <taskId> "<prompt>" [opts]  Send a follow-up turn',
      '  abort <taskId>                       Abort a running task',
      '  list                                 List active SDK tasks',
      '  watch <taskId> [opts]                Tail an existing task',
      '',
      'Options for run/continue/watch:',
      '  --cwd <path>             Working directory (default: $PWD)',
      '  --auto-approve           Auto-allow every permission request',
      '  --permission-mode <m>    default | acceptEdits | bypassPermissions | plan',
      '  --system-prompt <s>      Custom system prompt addendum',
      '  --resume <sessionId>     Resume an existing Claude Code session',
      '',
      'Env:',
      '  CLAUDIA_BACKEND          Override backend URL (default http://localhost:4001)',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    help();
    return;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  // Pull --flag values out of the tail.
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }

  const cwd = (typeof flags.cwd === 'string' ? flags.cwd : null) ?? process.cwd();
  const autoApprove = flags['auto-approve'] === true;
  const permissionMode = (flags['permission-mode'] as RunOptions['permissionMode']) ?? 'default';

  switch (cmd) {
    case 'run': {
      const prompt = positional[0];
      if (!prompt) {
        console.error('usage: sdk-cli run "<prompt>" [opts]');
        process.exit(2);
      }
      await cmdRun({
        prompt,
        cwd,
        autoApprove,
        permissionMode,
        systemPrompt: typeof flags['system-prompt'] === 'string' ? (flags['system-prompt'] as string) : undefined,
        resumeSessionId: typeof flags.resume === 'string' ? (flags.resume as string) : undefined,
      });
      break;
    }
    case 'continue': {
      const [taskId, prompt] = positional;
      if (!taskId || !prompt) {
        console.error('usage: sdk-cli continue <taskId> "<prompt>" [opts]');
        process.exit(2);
      }
      await cmdContinue(taskId, prompt, autoApprove);
      break;
    }
    case 'abort': {
      const [taskId] = positional;
      if (!taskId) {
        console.error('usage: sdk-cli abort <taskId>');
        process.exit(2);
      }
      await cmdAbort(taskId);
      break;
    }
    case 'list':
      await cmdList();
      break;
    case 'watch': {
      const [taskId] = positional;
      if (!taskId) {
        console.error('usage: sdk-cli watch <taskId> [opts]');
        process.exit(2);
      }
      await cmdWatch(taskId, autoApprove);
      break;
    }
    default:
      help();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error('sdk-cli failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
