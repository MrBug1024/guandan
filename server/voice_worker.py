"""Persistent Mandarin synthesis worker; stdout is a JSON-lines protocol only."""
import asyncio
import base64
import json
import sys
import edge_tts


async def main():
    semaphore = asyncio.Semaphore(2)
    jobs = set()

    async def generate(request):
        try:
            async with semaphore:
                chunks = []
                voice = edge_tts.Communicate(request['text'], 'zh-CN-XiaoxiaoNeural', rate='-8%')
                async for chunk in voice.stream():
                    if chunk['type'] == 'audio':
                        chunks.append(chunk['data'])
                        print(json.dumps({'id': request['id'], 'chunk': base64.b64encode(chunk['data']).decode('ascii')}), flush=True)
                result = {'id': request['id'], 'audio': base64.b64encode(b''.join(chunks)).decode('ascii')}
        except Exception:
            result = {'id': request['id'], 'error': True}
        print(json.dumps(result), flush=True)

    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        try:
            request = json.loads(line)
            if not isinstance(request.get('text'), str) or len(request['text']) > 1000:
                continue
            task = asyncio.create_task(generate(request))
            jobs.add(task)
            task.add_done_callback(jobs.discard)
        except (ValueError, TypeError):
            continue
    for job in jobs:
        job.cancel()
    await asyncio.gather(*jobs, return_exceptions=True)


asyncio.run(main())
