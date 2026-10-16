import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createAccess } from '../server/access.js';
import { safeAgent } from '../server/public-state.js';

test('account password is hashed, secrets encrypted, public models omit credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guandan-access-'));
  try {
    const access = await createAccess(dir);
    const saved = await readFile(join(dir, 'admin.json'), 'utf8');
    assert.ok(!saved.includes('ymthcx3344520'));
    const config = { apiKey: 'test-secret', nested: { apiKey: 'tool-secret' } };
    const encrypted = access.encrypt(config);
    assert.ok(!JSON.stringify(encrypted).includes('test-secret'));
    assert.deepEqual(access.decrypt(encrypted), config);
    const reloaded = await createAccess(dir);
    assert.deepEqual(reloaded.decrypt(encrypted), config);
    assert.equal(reloaded.info.sharePath, access.info.sharePath);
    const safe = safeAgent({
      name: 'A',
      provider: 'openai',
      baseUrl: 'https://example.com/v1',
      model: 'test',
      keyEnv: '',
      apiKey: 'test-secret',
      personality: '',
      jev: { enabled: true, baseUrl: 'https://example.com/mcp', keyEnv: '', apiKey: 'tool-secret' },
    });
    assert.ok(!JSON.stringify(safe).includes('secret'));
    assert.equal(safe.keyConfigured, true);
    assert.equal(safe.jev?.keyConfigured, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'HTTP sessions protect administration, share access is read only, encrypted key rotation and restart work',
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guandan-http-'));
    await mkdir(join(dir, 'dist'));
    await mkdir(join(dir, 'data'));
    const portServer = createServer();
    await new Promise<void>((r) => portServer.listen(0, '127.0.0.1', r));
    const port = (portServer.address() as any).port;
    await new Promise<void>((r) => portServer.close(() => r()));
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
        resolve('server/index.ts'),
      ],
      {
        cwd: dir,
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let serverError = '';
    let serverOutput = '';
    child.stdout?.on('data', (chunk) => (serverOutput += chunk.toString()));
    child.stderr?.on('data', (chunk) => (serverError += chunk.toString()));
    let releaseDecision: (() => void) | undefined;
    const modelMock = createServer((req, res) => {
      assert.equal(req.url, '/v1/chat/completions');
      releaseDecision = () => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ choices: [{ message: { content: '{"choice":0,"reason":"test"}' } }] }),
        );
      };
    });
    await new Promise<void>((r) => modelMock.listen(0, '127.0.0.1', r));
    const modelPort = (modelMock.address() as any).port;
    let cookie = '';
    const request = (
      path: string,
      body?: unknown,
      authenticated = false,
      method = body ? 'POST' : 'GET',
    ) =>
      fetch(`http://127.0.0.1:${port}/api/${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(authenticated ? { Cookie: cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      let ready = false;
      for (let i = 0; i < 80; i++) {
        try {
          if ((await request('health')).ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        ready,
        `isolated server starts (exit ${child.exitCode})${serverOutput ? `:\n${serverOutput}` : ''}${serverError ? `:\n${serverError}` : ''}`,
      );
      assert.equal((await request('config')).status, 401);
      assert.equal((await request('state')).status, 401);
      assert.equal((await request('decisions')).status, 401);
      assert.equal(
        (await request('study', { title: 'unauthorized', question: 'x', hypothesis: 'x', measure: 'x' }, false, 'PUT')).status,
        401,
      );
      assert.equal(
        (await request('auth/login', { username: 'ymtadmin', password: 'wrong' })).status,
        401,
      );
      const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://192.168.1.23:5173',
        },
        body: JSON.stringify({
          username: 'ymtadmin',
          password: 'ymthcx3344520',
        }),
      });
      assert.equal(login.status, 200);
      cookie = login.headers.get('set-cookie')!.split(';')[0];
      assert.match(login.headers.get('set-cookie')!, /HttpOnly/i);
      const share = (await login.json()).sharePath.split('/').at(-1);
      assert.equal((await request(`state?share=${share}`)).status, 200);
      const study = {
        title: '团队意图读取',
        question: '队友领出后，本席如何处置控制牌？',
        hypothesis: '牌数与公开行动可能改变让牌选择。',
        measure: '统计队友先领出后的让牌和继续出牌次数。',
      };
      const savedStudy = await request('study', study, true, 'PUT');
      assert.equal(savedStudy.status, 200);
      assert.deepEqual((await savedStudy.json()).study, study);
      assert.deepEqual((await (await request('config', undefined, true)).json()).study, study);
      assert.deepEqual((await (await request(`state?share=${share}`)).json()).study, study);
      assert.equal((await request('replays')).status, 401);
      const archived = await (await request('replay', undefined, true)).json();
      archived.game.history = [
        {
          seq: 1,
          seat: 0,
          text: '单张 9',
          move: { id: 'sample', kind: 'single', cards: [], strength: 9, label: '单张 9' },
          source: '内置策略',
          elapsedMs: 1250,
          time: new Date().toISOString(),
          after: { last: null, lastSeat: 0, round: archived.game.round },
        },
      ];
      const archiveFile = archived.game.id + '-' + archived.game.round + '.json';
      await writeFile(join(dir, 'data/replays', archiveFile), JSON.stringify(archived));
      const replayIndex = await (await request('replays', undefined, true)).json();
      assert.equal(replayIndex.length, 1);
      assert.equal(replayIndex[0].decisionCount, 1);
      assert.equal(replayIndex[0].medianLatencyMs, 1250);
      assert.equal(replayIndex[0].agents[0].name, archived.agents[0].name);
      assert.equal(JSON.stringify(replayIndex).includes('hands'), false);
      assert.equal((await request('replays/' + archiveFile, undefined, true)).status, 200);
      const selected = await (await request(`state?share=${share}&seat=2`)).json();
      assert.equal(selected.viewpointSeat, 2);
      assert.equal(selected.visibleHand.length, 27);
      assert.equal(selected.hands, undefined);
      assert.equal((await request(`state?share=${share}&seat=4`)).status, 400);
      assert.equal((await request(`events?share=${share}&seat=-1`)).status, 400);
      const stream = await request(`events?share=${share}&seat=3`);
      const reader = stream.body!.getReader();
      const event = new TextDecoder().decode((await reader.read()).value);
      assert.equal(JSON.parse(event.split('data: ')[1].trim()).viewpointSeat, 3);
      await reader.cancel();
      const third = await (
        await request(
          'control',
          { action: 'presentation', presentation: { cameraMode: 'third' } },
          true,
        )
      ).json();
      assert.equal(third.presentation.cameraMode, 'third');
      assert.equal(
        (
          await request(
            'control',
            { action: 'presentation', presentation: { cameraMode: 'invalid' } },
            true,
          )
        ).status,
        400,
      );
      assert.equal((await request(`control?share=${share}`, { action: 'restart' })).status, 401);
      assert.equal((await request(`inspect?share=${share}`)).status, 401);
      const nonMatchingOrigin = await fetch(`http://127.0.0.1:${port}/api/control`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'presentation', presentation: { cameraMode: 'third' } }),
      });
      assert.equal(nonMatchingOrigin.status, 200);
      const config = await (await request('config', undefined, true)).json();
      config.agents[0].apiKey = 'test-secret-only';
      assert.equal((await request('config', config, true, 'PUT')).status, 200);
      assert.ok(
        !(await readFile(join(dir, 'data/agents.json'), 'utf8')).includes('test-secret-only'),
      );
      let masked = await (await request('config', undefined, true)).json();
      assert.equal(masked.agents[0].keyConfigured, true);
      assert.equal(masked.agents[0].apiKey, undefined);
      assert.ok(
        !JSON.stringify(await (await request(`state?share=${share}`)).json()).includes(
          'test-secret-only',
        ),
      );
      assert.equal((await request('config', masked, true, 'PUT')).status, 200);
      masked = await (await request('config', undefined, true)).json();
      assert.equal(masked.agents[0].keyConfigured, true);
      masked.agents[0].deleteKey = true;
      assert.equal((await request('config', masked, true, 'PUT')).status, 200);
      assert.equal(
        (await (await request('config', undefined, true)).json()).agents[0].keyConfigured,
        false,
      );
      const stepped = await (await request('control', { action: 'step' }, true)).json();
      assert.equal(stepped.history.at(-1).decision.method, 'heuristic');
      const decisionLog = await (await request('decisions', undefined, true)).json();
      assert.equal(decisionLog.entries.at(-1).decision.method, 'heuristic');
      assert.equal(decisionLog.entries.at(-1).decision.candidateSource, 'legal-action-set');
      assert.ok(decisionLog.entries.at(-1).decision.candidateCount > 0);
      const publicStep = await (await request(`state?share=${share}`)).json();
      assert.equal(publicStep.history.at(-1).decision.candidates, undefined);
      const previous = await (await request('state', undefined, true)).json();
      const restarted = await (await request('control', { action: 'restart' }, true)).json();
      assert.notEqual(previous.id, restarted.id);
      assert.equal(restarted.status, 'running');
      assert.equal(restarted.round, 1);
      assert.deepEqual(restarted.counts, [27, 27, 27, 27]);
      assert.equal((await request('study', study, true, 'PUT')).status, 400);
      await request('control', { action: 'pause' }, true);
      const heldConfig = await (await request('config', undefined, true)).json();
      heldConfig.agents[0] = {
        ...heldConfig.agents[0],
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        model: 'test-model',
        apiKey: 'test-decision-key',
        keyEnv: '',
      };
      heldConfig.delayMs = 300;
      assert.equal((await request('config', heldConfig, true, 'PUT')).status, 200);
      const oldMatch = await (await request('control', { action: 'restart' }, true)).json();
      for (let i = 0; i < 80 && !releaseDecision; i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(releaseDecision, 'an old model request is in flight');
      const fresh = await (await request('control', { action: 'restart' }, true)).json();
      assert.notEqual(fresh.id, oldMatch.id);
      assert.equal(fresh.history.length, 0);
      await request('control', { action: 'pause' }, true);
      releaseDecision!();
      await new Promise((r) => setTimeout(r, 150));
      const afterOldDecision = await (await request('state', undefined, true)).json();
      assert.equal(afterOldDecision.id, fresh.id);
      assert.equal(
        afterOldDecision.history.length,
        0,
        'old decision cannot mutate restarted match',
      );
      await request('auth/logout', {}, true);
      assert.equal((await request('config', undefined, true)).status, 401);
      assert.equal((await request(`state?share=${share}`)).status, 200);
    } finally {
      releaseDecision?.();
      child.kill();
      modelMock.closeAllConnections();
      await new Promise<void>((r) => modelMock.close(() => r()));
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((r) => child.once('exit', r));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
