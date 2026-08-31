import io
p = '/Users/namitraj/Desktop/sih_2026/src/services/content-cards.service.ts'
lines = io.open(p, encoding='utf8').read().splitlines()
for i, l in enumerate(lines):
    s = l.strip()
    for key in ['getCards', 'persistCards', 'loadAll', 'persist(', 'persistCards', 'retrieveTopicContext', 'import fs']:
        if key in s:
            print(i+1, ':', s)