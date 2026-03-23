import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import http from 'http';

// --- Mocks ---

// Mock shared module
const mockWriteOutput = vi.fn();
const mockLog = vi.fn();
const mockShouldClose = vi.fn(() => false);
const mockDrainIpcInput = vi.fn(() => [] as string[]);

vi.mock('./shared.js', () => ({
  writeOutput: (...args: unknown[]) => mockWriteOutput(...args),
  log: (...args: unknown[]) => mockLog(...args),
  shouldClose: () => mockShouldClose(),
  drainIpcInput: () => mockDrainIpcInput(),
}));

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// We need to intercept http.request calls
const mockHttpRequest = vi.fn();
vi.mock('http', async () => {
  const actual = await vi.importActual<typeof import('http')>('http');
  return {
    ...actual,
    default: {
      ...actual,
      request: (...args: unknown[]) => mockHttpRequest(...args),
    },
    request: (...args: unknown[]) => mockHttpRequest(...args),
  };
});

// --- Helpers ---

function createMockChildProcess(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

function createMockResponse(statusCode: number, body: string): PassThrough & { statusCode: number } {
  const res = new PassThrough() as PassThrough & { statusCode: number };
  res.statusCode = statusCode;
  // Push body data asynchronously
  process.nextTick(() => {
    res.push(body);
    res.push(null); // end stream
  });
  return res;
}

function createMockRequest(): EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  const req = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  req.write = vi.fn();
  req.end = vi.fn();
  req.destroy = vi.fn();
  return req;
}

/** Build an SSE chunk from event name and JSON data */
function sseChunk(event: string, data: unknown): string {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${dataStr}\n\n`;
}

const defaultContainerInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@chat',
  isMain: false,
  assistantName: 'TestBot',
};

// --- Tests ---

describe('rovodev-backend', () => {
  let requestCallIndex: number;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    requestCallIndex = 0;
    process.env.AGENT_BACKEND = 'rovodev';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.AGENT_BACKEND;
    delete process.env.ROVODEV_MODEL;
  });

  /**
   * Set up mockHttpRequest to handle a sequence of HTTP requests.
   * Each handler receives (options, callback) and should call callback(response).
   */
  function setupHttpSequence(
    handlers: Array<{
      match: (options: { path: string; method: string }) => boolean;
      handle: (req: ReturnType<typeof createMockRequest>) => void;
      response: { status: number; body?: string; sse?: string };
    }>,
  ) {
    mockHttpRequest.mockImplementation((options: unknown, callback?: (res: unknown) => void) => {
      const opts = options as { path: string; method: string; hostname: string; port: string };
      const req = createMockRequest();

      const handler = handlers.find((h) => h.match(opts));

      if (handler && callback) {
        const res = new PassThrough() as PassThrough & { statusCode: number };
        res.statusCode = handler.response.status;

        process.nextTick(() => {
          callback(res);
          const body = handler.response.sse || handler.response.body || '';
          if (body) {
            res.push(body);
          }
          if (!handler.response.sse) {
            res.push(null);
          } else {
            // For SSE, end after pushing
            process.nextTick(() => res.push(null));
          }
          handler.handle(req);
        });
      }

      req.end.mockImplementation(() => {
        if (!handler && callback) {
          // No matching handler — return 404
          const res = createMockResponse(404, 'Not found');
          process.nextTick(() => callback(res));
        }
      });

      return req;
    });
  }

  describe('SSE parsing', () => {
    it('accumulates text from part_start and part_delta events', async () => {
      const sseData =
        sseChunk('user-prompt', { content: 'Hello', part_kind: 'user-prompt' }) +
        sseChunk('part_start', { index: 0, part: { content: 'Hi ', part_kind: 'text' }, event_kind: 'part_start' }) +
        sseChunk('part_delta', { index: 0, delta: { content_delta: 'there!', part_delta_kind: 'text' }, event_kind: 'part_delta' }) +
        sseChunk('request-usage', { input_tokens: 10, output_tokens: 5 }) +
        sseChunk('close', '');

      const mockProc = createMockChildProcess();
      mockSpawn.mockReturnValue(mockProc);

      setupHttpSequence([
        {
          match: (o) => o.path === '/healthcheck',
          handle: () => {},
          response: { status: 200, body: 'OK' },
        },
        {
          match: (o) => o.path === '/v3/set_chat_message' && o.method === 'POST',
          handle: () => {},
          response: { status: 200, body: '{"response":"Chat message set"}' },
        },
        {
          match: (o) => o.path === '/v3/stream_chat',
          handle: () => {},
          response: { status: 200, sse: sseData },
        },
        {
          match: (o) => o.path === '/v3/sessions/current_session',
          handle: () => {},
          response: { status: 200, body: '{"id":"sess-123"}' },
        },
      ]);

      // Dynamically import after mocks are set up
      const { runQuery } = await import('./rovodev-backend.js');

      const result = await runQuery(
        'Hello',
        undefined,
        '/mock/mcp-server.js',
        defaultContainerInput,
        {},
      );

      // Should have written output with accumulated text
      expect(mockWriteOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          result: 'Hi there!',
          newSessionId: 'sess-123',
        }),
      );
      expect(result.newSessionId).toBe('sess-123');
    });

    it('handles tool calls without including tool args in text', async () => {
      const sseData =
        sseChunk('part_start', {
          index: 0,
          part: { tool_name: 'bash', args: null, tool_call_id: 'tc1', part_kind: 'tool-call' },
        }) +
        sseChunk('part_delta', {
          index: 0,
          delta: { args_delta: '{"command":"ls"}', tool_call_id: 'tc1', part_delta_kind: 'tool_call' },
        }) +
        sseChunk('on_call_tools_start', {
          parts: [{ tool_name: 'bash', args: '{"command":"ls"}', tool_call_id: 'tc1', part_kind: 'tool-call' }],
        }) +
        sseChunk('tool-return', { tool_name: 'bash', content: 'file1\nfile2', tool_call_id: 'tc1', part_kind: 'tool-return' }) +
        sseChunk('part_start', { index: 1, part: { content: 'Found 2 files.', part_kind: 'text' }, event_kind: 'part_start' }) +
        sseChunk('close', '');

      const mockProc = createMockChildProcess();
      mockSpawn.mockReturnValue(mockProc);

      setupHttpSequence([
        {
          match: (o) => o.path === '/healthcheck',
          handle: () => {},
          response: { status: 200, body: 'OK' },
        },
        {
          match: (o) => o.path === '/v3/set_chat_message',
          handle: () => {},
          response: { status: 200, body: '{"response":"Chat message set"}' },
        },
        {
          match: (o) => o.path === '/v3/stream_chat',
          handle: () => {},
          response: { status: 200, sse: sseData },
        },
        {
          match: (o) => o.path === '/v3/sessions/current_session',
          handle: () => {},
          response: { status: 200, body: '{"id":"sess-456"}' },
        },
      ]);

      const mod = await import('./rovodev-backend.js');
      await mod.runQuery('List files', undefined, '/mock/mcp.js', defaultContainerInput, {});

      // Text output should only contain the final text, not tool args
      expect(mockWriteOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          result: 'Found 2 files.',
        }),
      );
    });

    it('returns null result when close event arrives with no text', async () => {
      const sseData = sseChunk('close', '');

      const mockProc = createMockChildProcess();
      mockSpawn.mockReturnValue(mockProc);

      setupHttpSequence([
        {
          match: (o) => o.path === '/healthcheck',
          handle: () => {},
          response: { status: 200, body: 'OK' },
        },
        {
          match: (o) => o.path === '/v3/set_chat_message',
          handle: () => {},
          response: { status: 200, body: '{"response":"ok"}' },
        },
        {
          match: (o) => o.path === '/v3/stream_chat',
          handle: () => {},
          response: { status: 200, sse: sseData },
        },
        {
          match: (o) => o.path === '/v3/sessions/current_session',
          handle: () => {},
          response: { status: 200, body: '{"id":"sess-789"}' },
        },
      ]);

      const mod = await import('./rovodev-backend.js');
      await mod.runQuery('Hello', undefined, '/mock/mcp.js', defaultContainerInput, {});

      expect(mockWriteOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          result: null,
        }),
      );
    });
  });

  describe('session management', () => {
    it('restores session when sessionId is provided', async () => {
      const sseData =
        sseChunk('part_start', { index: 0, part: { content: 'Resumed.', part_kind: 'text' } }) +
        sseChunk('close', '');

      const mockProc = createMockChildProcess();
      mockSpawn.mockReturnValue(mockProc);

      let restoredSessionId: string | null = null;

      setupHttpSequence([
        {
          match: (o) => o.path === '/healthcheck',
          handle: () => {},
          response: { status: 200, body: 'OK' },
        },
        {
          match: (o) => o.path.startsWith('/v3/sessions/') && o.path.endsWith('/restore'),
          handle: () => {
            // Extract session ID from path
            const match = '/v3/sessions/old-sess-100/restore';
            restoredSessionId = 'old-sess-100';
          },
          response: { status: 200, body: '{}' },
        },
        {
          match: (o) => o.path === '/v3/set_chat_message',
          handle: () => {},
          response: { status: 200, body: '{"response":"ok"}' },
        },
        {
          match: (o) => o.path === '/v3/stream_chat',
          handle: () => {},
          response: { status: 200, sse: sseData },
        },
        {
          match: (o) => o.path === '/v3/sessions/current_session',
          handle: () => {},
          response: { status: 200, body: '{"id":"old-sess-100"}' },
        },
      ]);

      const mod = await import('./rovodev-backend.js');
      const result = await mod.runQuery(
        'Continue',
        'old-sess-100',
        '/mock/mcp.js',
        defaultContainerInput,
        {},
      );

      expect(result.newSessionId).toBe('old-sess-100');
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Restored session'));
    });
  });

  describe('error handling', () => {
    it('rejects when set_chat_message returns non-200', async () => {
      const mockProc = createMockChildProcess();
      mockSpawn.mockReturnValue(mockProc);

      setupHttpSequence([
        {
          match: (o) => o.path === '/healthcheck',
          handle: () => {},
          response: { status: 200, body: 'OK' },
        },
        {
          match: (o) => o.path === '/v3/set_chat_message',
          handle: () => {},
          response: { status: 500, body: '{"error":"Internal error"}' },
        },
      ]);

      const mod = await import('./rovodev-backend.js');
      await expect(
        mod.runQuery('Hello', undefined, '/mock/mcp.js', defaultContainerInput, {}),
      ).rejects.toThrow('set_chat_message failed');
    });
  });

  describe('cleanup', () => {
    it('sends shutdown request and cleans up', async () => {
      const sseData =
        sseChunk('part_start', { index: 0, part: { content: 'Done.', part_kind: 'text' } }) +
        sseChunk('close', '');

      const mockProc = createMockChildProcess();
      mockSpawn.mockReturnValue(mockProc);

      let shutdownCalled = false;

      setupHttpSequence([
        {
          match: (o) => o.path === '/healthcheck',
          handle: () => {},
          response: { status: 200, body: 'OK' },
        },
        {
          match: (o) => o.path === '/v3/set_chat_message',
          handle: () => {},
          response: { status: 200, body: '{"response":"ok"}' },
        },
        {
          match: (o) => o.path === '/v3/stream_chat',
          handle: () => {},
          response: { status: 200, sse: sseData },
        },
        {
          match: (o) => o.path === '/v3/sessions/current_session',
          handle: () => {},
          response: { status: 200, body: '{"id":"s1"}' },
        },
        {
          match: (o) => o.path === '/shutdown' && o.method === 'POST',
          handle: () => { shutdownCalled = true; },
          response: { status: 200, body: 'Shutting down' },
        },
      ]);

      const mod = await import('./rovodev-backend.js');
      await mod.runQuery('Done', undefined, '/mock/mcp.js', defaultContainerInput, {});
      await mod.cleanup();

      expect(shutdownCalled).toBe(true);
    });
  });

  describe('server startup', () => {
    it('spawns acli rovodev serve with correct args', async () => {
      const sseData =
        sseChunk('part_start', { index: 0, part: { content: 'OK', part_kind: 'text' } }) +
        sseChunk('close', '');

      const mockProc = createMockChildProcess();
      mockSpawn.mockReturnValue(mockProc);

      setupHttpSequence([
        {
          match: (o) => o.path === '/healthcheck',
          handle: () => {},
          response: { status: 200, body: 'OK' },
        },
        {
          match: (o) => o.path === '/v3/set_chat_message',
          handle: () => {},
          response: { status: 200, body: '{"response":"ok"}' },
        },
        {
          match: (o) => o.path === '/v3/stream_chat',
          handle: () => {},
          response: { status: 200, sse: sseData },
        },
        {
          match: (o) => o.path === '/v3/sessions/current_session',
          handle: () => {},
          response: { status: 200, body: '{"id":"s1"}' },
        },
      ]);

      const mod = await import('./rovodev-backend.js');
      await mod.runQuery('Test', undefined, '/mock/mcp.js', defaultContainerInput, {});

      expect(mockSpawn).toHaveBeenCalledWith(
        'acli',
        expect.arrayContaining([
          'rovodev', 'serve',
          expect.any(String), // port
          '--non-interactive',
          '--disable-session-token',
          '--agent-mode', 'default',
        ]),
        expect.objectContaining({
          cwd: '/workspace/group',
        }),
      );
    });

    it('uses --agent-mode default flag', async () => {
      const sseData =
        sseChunk('part_start', { index: 0, part: { content: 'OK', part_kind: 'text' } }) +
        sseChunk('close', '');

      const mockProc = createMockChildProcess();
      mockSpawn.mockReturnValue(mockProc);

      // Clean up previous server state so spawn is called again
      const mod = await import('./rovodev-backend.js');
      await mod.cleanup();

      setupHttpSequence([
        {
          match: (o) => o.path === '/healthcheck',
          handle: () => {},
          response: { status: 200, body: 'OK' },
        },
        {
          match: (o) => o.path === '/v3/set_chat_message',
          handle: () => {},
          response: { status: 200, body: '{"response":"ok"}' },
        },
        {
          match: (o) => o.path === '/v3/stream_chat',
          handle: () => {},
          response: { status: 200, sse: sseData },
        },
        {
          match: (o) => o.path === '/v3/sessions/current_session',
          handle: () => {},
          response: { status: 200, body: '{"id":"s1"}' },
        },
      ]);

      await mod.runQuery('Test', undefined, '/mock/mcp.js', defaultContainerInput, {});

      expect(mockSpawn).toHaveBeenCalledWith(
        'acli',
        expect.arrayContaining(['--agent-mode', 'default']),
        expect.any(Object),
      );
    });
  });

  describe('IPC integration', () => {
    it('appends pending IPC messages to the prompt', async () => {
      mockDrainIpcInput.mockReturnValueOnce(['Follow up message']);

      const sseData =
        sseChunk('part_start', { index: 0, part: { content: 'OK', part_kind: 'text' } }) +
        sseChunk('close', '');

      const mockProc = createMockChildProcess();
      mockSpawn.mockReturnValue(mockProc);

      let sentMessage = '';
      setupHttpSequence([
        {
          match: (o) => o.path === '/healthcheck',
          handle: () => {},
          response: { status: 200, body: 'OK' },
        },
        {
          match: (o) => o.path === '/v3/set_chat_message',
          handle: (req) => {
            // Capture what was written
            const writeCall = req.write.mock.calls[0];
            if (writeCall) sentMessage = writeCall[0] as string;
          },
          response: { status: 200, body: '{"response":"ok"}' },
        },
        {
          match: (o) => o.path === '/v3/stream_chat',
          handle: () => {},
          response: { status: 200, sse: sseData },
        },
        {
          match: (o) => o.path === '/v3/sessions/current_session',
          handle: () => {},
          response: { status: 200, body: '{"id":"s1"}' },
        },
      ]);

      const mod = await import('./rovodev-backend.js');
      await mod.runQuery('Initial', undefined, '/mock/mcp.js', defaultContainerInput, {});

      // The log should mention draining
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Draining 1 pending IPC'));
    });
  });
});
