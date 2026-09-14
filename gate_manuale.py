#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Gate manuale<=UI: ogni etichetta citata tra caporali << >> nel SYSTEM_STATIC di
# api/assistant.js deve esistere letteralmente in medidesk.html o cooperativa.html.
# Exit 1 se una citazione non trova riscontro nel markup: il manuale non puo'
# divergere dall'interfaccia. Si lancia dalla root del repo: python3 gate_manuale.py
import io, re, sys

src = io.open('api/assistant.js', encoding='utf-8').read()
m = re.search(r'const SYSTEM_STATIC = `(.*?)`;', src, re.S)
if not m:
    print('GATE MANUALE: FALLITO - SYSTEM_STATIC non trovato in api/assistant.js')
    sys.exit(1)
labels = re.findall(u'\u00ab([^\u00ab\u00bb]+)\u00bb', m.group(1))
if not labels:
    print('GATE MANUALE: FALLITO - nessuna etichetta citata tra caporali nel manuale')
    sys.exit(1)
ui = (io.open('medidesk.html', encoding='utf-8').read()
      + io.open('cooperativa.html', encoding='utf-8').read())
missing = sorted(set(l for l in labels if l not in ui and l != '+'))
if missing:
    print('GATE MANUALE: FALLITO - %d etichette citate assenti dalla UI:' % len(missing))
    for l in missing:
        print(u'  \u00ab%s\u00bb' % l)
    sys.exit(1)
print('GATE MANUALE: OK - %d citazioni, %d etichette uniche, tutte presenti nella UI'
      % (len(labels), len(set(labels))))
