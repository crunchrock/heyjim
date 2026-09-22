#!/bin/bash
# Screenshot the real app at iPhone size (390x844): build/test/ui/shot.sh <name> "<query>"  ->  build/test/ui/out/<name>.png
# query: reset=1 (fresh state) lat=..&lng=.. (fake GPS) theme=dark tpl=<template id> do=block&i=<n> | do=tab&t=map|places|me |
#        do=list&t=<block type> | do=act&name=<A action> (dataset = the query) | do=add | do=dev | do=zone&z=<zone> | do=pid&id=<poi id> | scroll=<px> (page) ss=<px> (sheet)
# Needs Chrome. Run `node build/test/ui/mk.mjs` after each build first. Screenshots use a 390px iframe because headless
# Chrome won't make a window narrower than ~500px.
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="$HERE/out"; mkdir -p "$OUT"
PORT="${PORT:-8787}"; export PORT
curl -s -o /dev/null http://localhost:$PORT/_w.html || { (node "$HERE/serve.mjs" >/dev/null 2>&1 &); sleep 1; }
CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$OUT/prof_$1_$RANDOM" --window-size=390,844 \
  --virtual-time-budget=12000 --screenshot="$OUT/$1.png" "http://localhost:$PORT/_w.html?$2" >/dev/null 2>&1
echo "$OUT/$1.png"
