"""Integration checks for end-of-round countdown, pause and automatic next deal."""
import json
import os
import time
from http.cookiejar import CookieJar
from urllib.request import Request, build_opener, HTTPCookieProcessor

opener = build_opener(HTTPCookieProcessor(CookieJar()))

def api(path, body=None, method=None):
    req = Request('http://127.0.0.1:' + os.environ.get('ARENA_TEST_PORT','3001') + '/api/' + path,
                  data=json.dumps(body).encode() if body is not None else None,
                  headers={'Content-Type': 'application/json'}, method=method)
    with opener.open(req, timeout=60) as response:
        return json.load(response)

api('auth/login', {'username': 'ymtadmin', 'password': os.environ.get('ARENA_TEST_PASSWORD', 'ymthcx3344520')})
original = api('state')
assert all(a['provider'] == 'builtin' for a in original['agents'])

def imminent_finish():
    api('control', {'action': 'pause'})
    api('control', {'action': 'reset'})
    state = api('state')
    for _ in range(1000):
        if state['status'] == 'round-over':
            api('control', {'action':'reset'})
            state=api('state')
        remaining = [n for s,n in enumerate(state['counts']) if s not in state['finished']]
        if len(state['finished']) == 2 and min(remaining) == 1:
            return
        state = api('control', {'action': 'step'})
    raise AssertionError('Failed to prepare final play')

def wait_for(predicate, timeout):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        state = api('state')
        if predicate(state):
            return state
        time.sleep(.1)
    raise AssertionError('State transition timed out')

try:
    api('control', {'action': 'pause'})
    api('config', {'agents': original['agents'], 'delayMs': 300, 'autoNext': True}, 'PUT')
    imminent_finish()
    api('control', {'action': 'start'})
    end = wait_for(lambda s: s['status'] == 'round-over', 20)
    assert end['nextRoundAt'] is not None
    assert 9.4 < end['nextRoundAt'] / 1000 - time.time() <= 10.1
    api('control', {'action': 'pause'})
    time.sleep(10.3)
    paused = api('state')
    assert paused['round'] == 1 and paused['nextRoundAt'] is None
    imminent_finish()
    api('control', {'action': 'start'})
    end = wait_for(lambda s: s['status'] == 'round-over', 20)
    next_game = wait_for(lambda s: s['round'] == 2, 12)
    assert next_game['status'] == 'running'
    assert sum(next_game['counts']) == 108
    assert next_game['nextRoundAt'] is None
    assert next_game['tribute']
    print('Continuous integration passed: 10 second result, cancellable countdown, next deal and resume')
finally:
    api('control', {'action': 'pause'})
    api('config', {'agents': original['agents'], 'delayMs': original['delayMs'], 'autoNext': True}, 'PUT')
