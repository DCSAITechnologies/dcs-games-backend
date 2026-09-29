#!/usr/bin/env python3
"""Build DCS_GAMES_ROUTE_MATRIX.csv + summary from crawler JSON.
usage: matrix.py <anon.json> <tester.json> <baseline-anon.json> <out.csv>"""
import json, sys, csv, collections, re

anon, tester, base, out = [json.load(open(f)) for f in sys.argv[1:4]] + [sys.argv[4]]
def by_route(R):
    d = collections.defaultdict(list)
    for r in R: d[r['route']].append(r)
    return d
A, T, B = by_route(anon), by_route(tester), by_route(base)
SKIP_SEARCH = re.compile(r"input#pdSearch")  # icon overlapping the input's centre on a stub page is not a reach failure

def unreachable(rows):
    # The beta-lock overlay is a deliberate modal on production hosts: what it covers is gated, not unscrollable.
    return [u for r in rows if not r.get('betaLock') for u in r.get('unreachable', []) if not SKIP_SEARCH.search(u)]
def api_errs(rows, anon_mode):
    out = collections.Counter()
    for r in rows:
        for a in r.get('api', []):
            s = str(a['s'])
            if s in ('200', 'STUB200', '204', '202', 'BLOCKED_WRITE'): continue
            if anon_mode and s in ('401', '403'): continue          # signed out: expected
            out[f"{a['p']} {s}"] += 1
    return out

rows, green, broken = [], [], []
for route in sorted(set(A) | set(T)):
    a, t, b = A.get(route, []), T.get(route, []), B.get(route, [])
    allr = a + t
    nav_err = [r['navError'] for r in allr if r.get('navError')]
    statuses = sorted(set(r.get('status') for r in a if r.get('status') is not None))
    intended404 = route == '/404'
    loads = not nav_err and all((s or 0) < 400 for s in statuses) or intended404
    red = sorted(set(r['finalPath'] for r in a if r.get('redirected')))
    gated_anon = any(r.get('gated') for r in a)
    login_redirect = any('/login' in (r.get('finalPath') or '') for r in a if r.get('redirected')) and route not in ('/login',)
    auth = 'login redirect' if login_redirect else ('internal-tester gate' if gated_anon else 'no')
    un = unreachable(allr)
    scroll_ok = not un
    hdr = any(r.get('hasAnyHeader') or r.get('gated') for r in t) or any(r.get('hasAnyHeader') for r in a)
    side = any(r.get('hasSidebar') for r in allr) or route.startswith('/studio')
    hov = max([r.get('hOverflow', 0) for r in allr] or [0])
    responsive = hov <= 0
    apiA, apiT = api_errs(a, True), api_errs(t, False)
    apie = apiA + apiT
    js = sorted(set(e for r in allr for e in r.get('jsErrors', [])))
    dead = max([r.get('deadLinks', 0) for r in a] or [0])
    ph = []
    if any(r.get('sampleBanner') for r in allr): ph.append('sample-data banner')
    soon = max([r.get('soonBlocks', 0) for r in allr] or [0])
    if soon: ph.append(f'{soon} SOON block(s)')
    txt = sorted(set(x for r in allr for x in r.get('placeholderText', [])))
    if txt: ph.append('text: ' + '/'.join(txt))
    notes = []
    bu = unreachable(b)
    if bu and scroll_ok: notes.append(f'FIXED: {len(bu)} unreachable element-checks before (baseline)')
    if un: notes.append('unreachable: ' + un[0][:90])
    if any(r.get('betaLock') for r in a): notes.append('beta-lock overlay on production host')
    if intended404: notes.append('intended 404 page')
    ok = loads and scroll_ok and responsive and not js and not [k for k in apie if not k.endswith(' NETERR')]
    (green if ok else broken).append(route)
    rows.append({
        'ROUTE': route, 'LOADS': 'yes' if loads else 'NO (' + ';'.join(map(str, statuses + nav_err))[:60] + ')',
        'AUTH_REQUIRED': auth, 'REDIRECT_BEHAVIOR': ' | '.join(red) or 'none',
        'SCROLL_WORKS': 'yes' if scroll_ok else f'NO ({len(un)})', 'HEADER': 'yes' if hdr else 'no',
        'SIDEBAR': 'yes' if side else 'no', 'RESPONSIVE': 'yes' if responsive else f'NO (+{hov}px)',
        'API_ERRORS': '; '.join(f'{k} x{v}' for k, v in apie.most_common(4)) or 'none',
        'JS_ERRORS': '; '.join(js)[:160] or 'none', 'BROKEN_CONTROLS': f'{dead} dead link(s)' if dead else 'none',
        'PLACEHOLDERS': '; '.join(ph) or 'none', 'NOTES': '; '.join(notes) or '',
        'STATUS': 'GREEN' if ok else 'BROKEN',
    })

with open(out, 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print(json.dumps({'routes': len(rows), 'green': len(green), 'broken': len(broken), 'broken_routes': broken,
                  'js_error_routes': [r['ROUTE'] for r in rows if r['JS_ERRORS'] != 'none'],
                  'scroll_fail': [r['ROUTE'] for r in rows if r['SCROLL_WORKS'] != 'yes'],
                  'api_err_routes': {r['ROUTE']: r['API_ERRORS'] for r in rows if r['API_ERRORS'] != 'none'},
                  'dead_link_routes': sum(1 for r in rows if r['BROKEN_CONTROLS'] != 'none'),
                  'sample_routes': sum(1 for r in rows if 'sample' in r['PLACEHOLDERS'])}, indent=1))
