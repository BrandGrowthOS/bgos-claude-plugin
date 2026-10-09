# excerpt.py <transcript.jsonl> [since-iso] : one line per user/assistant event.
import json, sys, re
since = sys.argv[2] if len(sys.argv) > 2 else ''
for line in open(sys.argv[1]):
    try: e = json.loads(line)
    except Exception: continue
    ts = e.get('timestamp', '')
    if ts < since or e.get('type') not in ('user', 'assistant'): continue
    msg = e.get('message', {}); c = msg.get('content')
    t = ts[11:23]
    if isinstance(c, str):
        c = re.sub(r'/(private|Users)/\S+', '<path>', c)
        print(f"{t} {e['type']} | {c[:330]!s}".replace('\n', ' ')); continue
    for b in c or []:
        k = b.get('type')
        if k == 'text': print(f"{t} {e['type']} text | {b['text'][:300]}".replace('\n', ' '))
        elif k == 'tool_use':
            inp = b['input']
            if b['name'].endswith('reply'): inp = {'text': inp.get('text')}
            print(f"{t} {e['type']} tool_use | {b['name']} {json.dumps(inp)[:200]}")
        elif k == 'tool_result':
            r = b.get('content'); r = r if isinstance(r, str) else json.dumps(r)
            print(f"{t} {e['type']} tool_result | {re.sub(r'/(private|Users)/[^ \"]+', '<path>', r)[:160]}".replace('\n', ' '))
