#!/bin/bash
# Linux / qualquer Unix: ./iniciar.sh sobe o servidor e abre o jogo no navegador.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js não encontrado — instale em https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
node server/index.js --abrir
