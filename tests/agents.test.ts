import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { decide, jevAdvice, shortlist, observation } from '../server/agents.js';
import { legalMoves, newGame } from '../server/rules.js';
import type { AgentConfig } from '../shared/types.js';
test('OpenAI adapter sends only private self observation and validates choice', async () => {
  let captured: any;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    captured = { path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ choices: [{ message: { content: '{"choice":0,"reason":"保持配合"}' } }] }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  process.env.ARENA_TEST_KEY = 'dummy-local-test';
  try {
    const g = newGame(),
      moves = legalMoves(g.hands[0], 2, null);
    const config: AgentConfig = {
      name: '测试',
      provider: 'openai',
      model: 'mock',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      keyEnv: 'ARENA_TEST_KEY',
      personality: '配合',
    };
    const result = await decide(config, g, moves);
    assert.ok(moves.some((m) => m.id === result.move.id));
    assert.equal(captured.path, '/v1/chat/completions');
    assert.equal(captured.auth, 'Bearer dummy-local-test');
    const prompt = JSON.parse(captured.body.messages[1].content);
    assert.equal(prompt.hand.length, 27);
    assert.ok(!prompt.hands);
    assert.ok(prompt.candidates.length <= 41);
    assert.equal(result.reason, '保持配合');
  } finally {
    delete process.env.ARENA_TEST_KEY;
    server.close();
  }
});
test('JEV uses actual SDK Streamable HTTP handshake and choice result', async () => {
  let called = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(405).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    if (body.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    let result: any;
    if (body.method === 'initialize')
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'test-jev', version: '1' },
      };
    else if (body.method === 'tools/call') {
      called = true;
      assert.equal(body.params.name, 'jev_decide');
      assert.equal(req.headers.authorization, 'Bearer dummy-mcp-test');
      const opts = body.params.arguments.questions[0].options;
      assert.ok(opts.length >= 2);
      result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              model: 'jev-omni-bf16',
              results: [
                {
                  choice: opts[1],
                  probabilities: Object.fromEntries(
                    opts.map((o: string, i: number) => [o, i === 1 ? 1 : 0]),
                  ),
                  confidence: 1,
                },
              ],
            }),
          },
        ],
      };
    } else result = {};
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  process.env.ARENA_TEST_KEY = 'dummy-mcp-test';
  try {
    const g = newGame(),
      moves = legalMoves(g.hands[0], 2, null);
    const config: AgentConfig = {
      name: '测试',
      provider: 'openai',
      model: 'jev',
      baseUrl: `http://127.0.0.1:${address.port}/mcp`,
      keyEnv: 'ARENA_TEST_KEY',
      personality: '',
    };
    const candidates = shortlist(g, moves);
    const result = await jevAdvice(config, observation(g, candidates), candidates);
    assert.equal(called, true);
    assert.equal(result.choice, 1);
  } finally {
    delete process.env.ARENA_TEST_KEY;
    server.close();
  }
});
test('missing credential fails without issuing an external request', async () => {
  const g = newGame();
  await assert.rejects(
    () =>
      decide(
        {
          name: '测试',
          provider: 'openai',
          baseUrl: 'http://127.0.0.1:1/v1',
          model: 'mock',
          keyEnv: 'ARENA_MISSING_KEY',
          personality: '',
        },
        g,
        legalMoves(g.hands[0], 2, null),
      ),
    /环境变量/,
  );
});

test('player calls JEV as a tool but keeps ownership of final choice', async () => {
  let completions = 0,
    toolCalled = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.writeHead(405).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      completions++;
      if (completions === 1) {
        assert.equal(body.tools[0].function.name, 'jev_decide');
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'jev_decide', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
        );
      } else {
        const toolMessage = body.messages.find((m: any) => m.role === 'tool');
        assert.equal(JSON.parse(toolMessage.content).choice, 1);
        assert.equal(body.tool_choice, 'none');
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"choice":0,"reason":"我选择另一合法动作"}' } }],
          }),
        );
      }
    } else {
      if (body.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'jev', version: '1' },
            }
          : { content: [{ type: 'text', text: '{"results":[{"choice":1}]}' }] };
      if (body.method === 'tools/call') toolCalled = true;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ARENA_TOOL_TEST_KEY = 'dummy';
  try {
    const g = newGame(),
      moves = legalMoves(g.hands[0], 2, null);
    const result = await decide(
      {
        name: '选手',
        provider: 'openai',
        model: 'player-model',
        baseUrl: url + '/v1',
        keyEnv: 'ARENA_TOOL_TEST_KEY',
        personality: '',
        jev: { enabled: true, baseUrl: url + '/mcp', keyEnv: 'ARENA_TOOL_TEST_KEY' },
      },
      g,
      moves,
    );
    assert.ok(toolCalled);
    assert.equal(completions, 2);
    assert.equal(result.source, 'player-model');
    assert.equal(result.move.id, shortlist(g, moves)[0].id);
    assert.match(result.reason, /咨询 JEV/);
  } finally {
    delete process.env.ARENA_TOOL_TEST_KEY;
    server.close();
  }
});
