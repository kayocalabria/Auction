#!/bin/bash
# Dois cliques neste arquivo: sobe o servidor do Leilão e abre o jogo no navegador.
# Feche a janela do Terminal (ou Ctrl+C) para encerrar.

cd "$(dirname "$0")" || exit 1

# O Finder abre o Terminal com um PATH mínimo — inclui os lugares comuns do Node no Mac.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  for d in "$HOME"/.nvm/versions/node/*/bin; do export PATH="$d:$PATH"; done
fi
if [ -f "$HOME/.volta/bin/node" ]; then export PATH="$HOME/.volta/bin:$PATH"; fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  ❌ Node.js não encontrado."
  echo "     Instale em https://nodejs.org (versão LTS) e tente de novo."
  echo ""
  read -n 1 -s -r -p "  Pressione qualquer tecla para fechar..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  📦 Primeira vez: instalando dependências..."
  npm install --no-audit --no-fund || { read -n 1 -s -r -p "  Falhou. Pressione qualquer tecla..."; exit 1; }
fi

clear
node server/index.js --abrir
status=$?
if [ $status -ne 0 ]; then
  echo ""
  read -n 1 -s -r -p "  Pressione qualquer tecla para fechar..."
fi
exit $status
