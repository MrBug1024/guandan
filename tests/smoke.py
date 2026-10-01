"""Run against npm run dev / npm start. Only uses builtin agents."""
import json
import os
from urllib.request import Request, urlopen
from pathlib import Path

BASE = 'http://127.0.0.1:' + os.environ.get('ARENA_TEST_PORT','3001') + '/api/'

def api(path, body=None, method=None):
    req = Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                  headers={'Content-Type': 'application/json'}, method=method)
    with urlopen(req, timeout=60) as response:
        return json.load(response)

api('control', {'action': 'pause'})
api('control', {'action': 'reset'})
state = api('state')
assert 'hands' not in state
assert state['viewpointSeat'] == 0 and len(state['visibleHand']) == 27
assert all(a['provider'] == 'builtin' for a in state['agents']), 'Smoke test expects builtin agents'
for _ in range(1000):
    state = api('control', {'action': 'step'})
    if state['status'] == 'round-over':
        break
assert state['status'] == 'round-over'
assert len(set(state['finished'])) == 4
assert all(e.get('source') != '本地兜底' for e in state['history'])
replay = api('replay')
assert len(replay['initial']['hands'][0]) == 27
assert replay['game']['history'][-1]['after']['status'] == 'round-over'
assert list(Path('data/replays').glob('*.json'))
state = api('control', {'action': 'next'})
assert state['round'] == 2 and state['counts'] == [27] * 4
assert state['tribute']
replay = api('replay')
assert replay['initial']['round'] == 2 and replay['game']['history'] == []
api('control', {'action': 'step'})
Path('tmp').mkdir(exist_ok=True)
Path('tmp/smoke-replay.json').write_text(json.dumps(api('replay'), ensure_ascii=False), encoding='utf-8')
print('HTTP smoke passed: full LangGraph round, public privacy, archive, tribute, exact replay frames')
