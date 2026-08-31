import io, os
ROOT = '/Users/namitraj/Desktop/sih_2026/src'
# find all references to vector-store exports across src
for dirpath, dirs, files in os.walk(ROOT):
    for fn in files:
        if not fn.endswith('.ts'):
            continue
        p = os.path.join(dirpath, fn)
        lines = io.open(p, encoding='utf-8').read().splitlines()
        for i, l in enumerate(lines):
            s = l.strip()
            if 'vector-store' in s:
                print('[import|use]', p, i + 1, ':', s)
        # explicit caller scan in key files
keyfiles = {
  'content-cards': os.path.join(ROOT, 'services/content-cards.service.ts'),
  'rag': os.path.join(ROOT, 'services/rag.service.ts'),
  'ask.routes': os.path.join(ROOT, 'routes/ask.routes.ts'),
  'ingest.ctrl': os.path.join(ROOT, 'controllers/ingest.controller.ts'),
  'ask.controller': os.path.join(ROOT, 'controllers/ask.controller.ts') if os.path.exists(os.path.join(ROOT,'controllers/ask.controller.ts')) else '',
}
for name, p in keyfiles.items():
    if not p or not os.path.exists(p):
        continue
    print('----', name)
    lines = io.open(p, encoding='utf-8').read().splitlines()
    for i, l in enumerate(lines):
        s = l.strip()
        for t in ['vector-store', 'getDocsBySource', 'removeBySource', 'stats', '.search(', 'addChunks', 'search(', 'import {']:
            if t in s:
                print(f'{i+1}: {s}')
