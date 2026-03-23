/**
 * Rovo Dev Backend
 * Runs queries via `acli rovodev serve` HTTP/SSE API.
 *
 * Flow:
 *   1. Spawn `acli rovodev serve <port>` as a child process
 *   2. Wait for /healthcheck to respond
 *   3. POST /v3/set_chat_message with the prompt
 *   4. GET /v3/stream_chat — consume SSE events, accumulate text
 *   5. On `close` event, emit writeOutput() with accumulated text
 *   6. For follow-up IPC messages, repeat steps 3-5
 *   7. POST /shutdown on cleanup
 */

import { ChildProcess, spawn } from 'child_process';
import http from 'http';
import type { ContainerInput, BackendResult } from './backend-types.js';
import { writeOutput, log, shouldClose, drainIpcInput } from './shared.js';

const IPC_POLL_MS = 500;
const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 60_000;
const SERVE_PORT_BASE = 19800;

// Pick a port based on process PID to reduce collisions in parallel containers
function pickPort(): number {
  return SERVE_PORT_BASE + (process.pid % 200);
}

// --- HTTP helpers ---

function httpRequest(
  method: string,
  url: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : undefined,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sseStream(
  url: string,
  onEvent: (event: string, data: string) => void,
  onError: (err: Error) => void,
  onEnd: () => void,
): { abort: () => void } {
  const parsedUrl = new URL(url);
  let aborted = false;

  const req = http.request(
    {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    },
    (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        if (aborted) return;
        buffer += chunk.toString();

        // Parse SSE: events separated by double newline
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;
          let eventName = 'message';
          let eventData = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) {
              eventName = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6);
            } else if (line === 'data:') {
              eventData = '';
            }
          }
          onEvent(eventName, eventData);
        }
      });
      res.on('end', () => {
        if (!aborted) onEnd();
      });
      res.on('error', (err) => {
        if (!aborted) onError(err);
      });
    },
  );
  req.on('error', (err) => {
    if (!aborted) onError(err);
  });
  req.end();

  return {
    abort: () => {
      aborted = true;
      req.destroy();
    },
  };
}

// --- Rovo Dev serve lifecycle ---

let serverProc: ChildProcess | null = null;
let serverPort = 0;

function baseUrl(): string {
  return `http://127.0.0.1:${serverPort}`;
}

/**
 * Authenticate acli inside the container using token passed via env var.
 * Must be called before starting serve.
 */
async function authenticateAcli(): Promise<void> {
  const token = process.env.ROVODEV_API_TOKEN;
  const email = process.env.ROVODEV_EMAIL;

  if (!token || !email) {
    log('No ROVODEV_API_TOKEN or ROVODEV_EMAIL, skipping auth (may fail if not pre-authenticated)');
    return;
  }

  log(`Authenticating acli as ${email}`);

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('acli', ['rovodev', 'auth', 'login', '--email', email, '--token'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin.write(token);
    proc.stdin.end();

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.stdout.on('data', (data) => { log(`[acli-auth] ${data.toString().trim()}`); });

    proc.on('close', (code) => {
      if (code === 0) {
        log('acli authentication successful');
        resolve();
      } else {
        log(`acli authentication failed (code ${code}): ${stderr.trim()}`);
        reject(new Error(`acli auth failed: ${stderr.trim()}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`acli auth spawn error: ${err.message}`));
    });
  });
}

async function startServer(mcpServerPath: string, containerInput: ContainerInput): Promise<void> {
  serverPort = pickPort();
  log(`Starting acli rovodev serve on port ${serverPort}`);

  // Authenticate before starting serve
  await authenticateAcli();

  const args = [
    'rovodev', 'serve', String(serverPort),
    '--non-interactive',
    '--disable-session-token',
  ];

  // Agent mode: default gives full agent capabilities
  args.push('--agent-mode', 'default');

  // Site URL for billing if provided
  const siteUrl = process.env.ROVODEV_SITE_URL;
  if (siteUrl) {
    args.push('--site-url', siteUrl);
  }

  serverProc = spawn('acli', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: '/workspace/group',
    env: {
      ...process.env,
      // Provide MCP config for the NanoClaw IPC server
      NANOCLAW_MCP_SERVER_PATH: mcpServerPath,
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  });

  serverProc.stdout?.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line) log(`[rovodev-stdout] ${line}`);
    }
  });

  serverProc.stderr?.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line) log(`[rovodev-stderr] ${line}`);
    }
  });

  serverProc.on('error', (err) => {
    log(`Rovo Dev serve process error: ${err.message}`);
  });

  serverProc.on('close', (code) => {
    log(`Rovo Dev serve process exited with code ${code}`);
    serverProc = null;
  });

  // Wait for healthcheck
  await waitForHealthy();
  log('Rovo Dev serve is healthy');

  // Set model override via API if configured
  const model = process.env.ROVODEV_MODEL;
  if (model) {
    try {
      const resp = await httpRequest(
        'PUT',
        `${baseUrl()}/v3/agent-model`,
        JSON.stringify({ model }),
      );
      if (resp.status === 200) {
        log(`Model set to: ${model}`);
      } else {
        log(`Failed to set model to ${model}: ${resp.status} ${resp.body}`);
      }
    } catch (err) {
      log(`Failed to set model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function waitForHealthy(): Promise<void> {
  const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const resp = await httpRequest('GET', `${baseUrl()}/healthcheck`);
      if (resp.status === 200) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
  }
  throw new Error(`Rovo Dev serve failed to become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms`);
}

async function shutdownServer(): Promise<void> {
  if (!serverProc) return;
  try {
    await httpRequest('POST', `${baseUrl()}/shutdown`);
  } catch {
    // If HTTP shutdown fails, kill the process
    serverProc.kill('SIGTERM');
  }
  serverProc = null;
}

// --- Session management ---

async function restoreSession(sessionId: string): Promise<boolean> {
  try {
    const resp = await httpRequest('POST', `${baseUrl()}/v3/sessions/${sessionId}/restore`);
    return resp.status === 200;
  } catch (err) {
    log(`Failed to restore session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function getCurrentSessionId(): Promise<string | undefined> {
  try {
    const resp = await httpRequest('GET', `${baseUrl()}/v3/sessions/current_session`);
    if (resp.status === 200) {
      const data = JSON.parse(resp.body);
      return data.id;
    }
  } catch (err) {
    log(`Failed to get current session: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

// --- Query execution ---

/**
 * Send a message and stream the response via SSE.
 * Returns the accumulated text result.
 */
function streamQuery(prompt: string): Promise<string | null> {
  return new Promise(async (resolve, reject) => {
    // Step 1: Set the chat message
    try {
      const resp = await httpRequest(
        'POST',
        `${baseUrl()}/v3/set_chat_message`,
        JSON.stringify({ message: prompt }),
      );
      if (resp.status !== 200) {
        reject(new Error(`set_chat_message failed: ${resp.status} ${resp.body}`));
        return;
      }
    } catch (err) {
      reject(err);
      return;
    }

    // Step 2: Stream the response
    let accumulatedText = '';
    let hasText = false;

    const stream = sseStream(
      `${baseUrl()}/v3/stream_chat`,
      (event, data) => {
        try {
          switch (event) {
            case 'part_start': {
              const parsed = JSON.parse(data);
              if (parsed.part?.part_kind === 'text' && parsed.part?.content) {
                accumulatedText += parsed.part.content;
                hasText = true;
              }
              break;
            }
            case 'part_delta': {
              const parsed = JSON.parse(data);
              if (parsed.delta?.part_delta_kind === 'text' && parsed.delta?.content_delta) {
                accumulatedText += parsed.delta.content_delta;
                hasText = true;
              }
              break;
            }
            case 'tool-return': {
              const parsed = JSON.parse(data);
              log(`Tool return: ${parsed.tool_name} (${(parsed.content || '').length} chars)`);
              break;
            }
            case 'on_call_tools_start': {
              const parsed = JSON.parse(data);
              const toolNames = (parsed.parts || [])
                .map((p: { tool_name?: string }) => p.tool_name)
                .filter(Boolean);
              log(`Tools executing: ${toolNames.join(', ')}`);
              break;
            }
            case 'request-usage': {
              const parsed = JSON.parse(data);
              log(`Usage: input=${parsed.input_tokens || 0}, output=${parsed.output_tokens || 0}`);
              break;
            }
            case 'close': {
              resolve(hasText ? accumulatedText : null);
              break;
            }
            case 'user-prompt':
              // Echo of submitted message, ignore
              break;
            default:
              log(`Unknown SSE event: ${event}`);
          }
        } catch (err) {
          log(`Error parsing SSE event ${event}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      (err) => {
        reject(err);
      },
      () => {
        // Stream ended without close event
        resolve(hasText ? accumulatedText : null);
      },
    );

    // Cancel on close sentinel
    const checkClose = setInterval(() => {
      if (shouldClose()) {
        log('Close sentinel detected during Rovo Dev query, cancelling');
        stream.abort();
        httpRequest('POST', `${baseUrl()}/v3/cancel`).catch(() => {});
        clearInterval(checkClose);
        resolve(null);
      }
    }, IPC_POLL_MS);

    // Clean up interval when query completes
    const origResolve = resolve;
    resolve = (value) => {
      clearInterval(checkClose);
      origResolve(value);
    };
  });
}

/**
 * Run a single query via Rovo Dev serve API.
 */
export async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  _resumeAt?: string,
): Promise<BackendResult> {
  // Start the server if not running
  if (!serverProc) {
    await startServer(mcpServerPath, containerInput);
  }

  // Restore session if provided
  if (sessionId) {
    const restored = await restoreSession(sessionId);
    if (restored) {
      log(`Restored session: ${sessionId}`);
    } else {
      log(`Could not restore session ${sessionId}, starting fresh`);
    }
  }

  // Poll IPC for follow-up messages during query
  let ipcPolling = true;
  let closedDuringQuery = false;

  // Append any pending IPC messages to the initial prompt
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Run the query
  const result = await streamQuery(prompt);

  // Check if close was detected
  if (shouldClose()) {
    closedDuringQuery = true;
  }

  // Get session ID
  const newSessionId = await getCurrentSessionId();

  // Emit result
  if (result !== null || !closedDuringQuery) {
    writeOutput({
      status: 'success',
      result: result,
      newSessionId,
    });
  }

  ipcPolling = false;
  log(`Query done. closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, closedDuringQuery };
}

/**
 * Clean up: shut down the Rovo Dev serve process.
 */
export async function cleanup(): Promise<void> {
  await shutdownServer();
}
