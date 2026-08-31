import io, os
ROOT = '/Users/namitraj/Desktop/sih_2026/src'
targets = {
  'getCards': [], 'persistCards': [], 'loadAll': [],
  'addChunks': [], 'removeBySource': [], 'stats': [],
}
for dirpath, dirs, files in os.walk(ROOT):
    for fn in files:
        if not (fn.endswith('.ts') and fn != 'vector-store.service.ts' and fn != 'content-cards.service.ts'):
            continue
        p = os.path.join(dirpath, fn)
        for i, l in enumerate(io.open(p, encoding='utf-8').read().splitlines(), 1):
            s = l.strip()
            for t in targets:
                if t in s and ('import' not in s[:10]):
                    targets[t].append(f'{p}:{i}: {s}')
for t, lst in targets.items():
    print('===', t, '(', len(lst), 'external refs )')
    for x in lst:
        print(' ', x)