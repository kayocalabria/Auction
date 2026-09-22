#!/data/data/com.termux/files/usr/bin/bash
# Android, dentro do Termux: este celular vira host + servidor + jogador.
#
# 1. Instale o Termux pelo F-Droid (a versão da Play Store está descontinuada
#    e não recebe mais atualizações): https://f-droid.org/packages/com.termux/
# 2. Dentro do Termux:
#      pkg update && pkg install -y git
#      git clone https://github.com/kayocalabria/Auction
#      cd Auction
#      bash iniciar-termux.sh
#
# Depois da primeira vez, é só abrir o Termux e rodar "bash iniciar-termux.sh"
# de novo dentro da pasta.

cd "$(dirname "$0")" || exit 1

if [ -z "$PREFIX" ] || [[ "$PREFIX" != *com.termux* ]]; then
  echo ""
  echo "  Este script é para rodar DENTRO do Termux, no Android."
  echo "  No computador, use ./iniciar.sh, \"Iniciar Leilão.command\" (Mac) ou \"Iniciar Leilao.bat\" (Windows)."
  echo ""
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "📦 Instalando Node.js (primeira vez)…"
  pkg update -y && pkg install -y nodejs
fi

if [ ! -d node_modules ]; then
  echo "📦 Instalando dependências do jogo (primeira vez)…"
  npm install --no-audit --no-fund
  echo "   (se aparecerem avisos sobre 'bufferutil' ou 'utf-8-validate' falhando ao compilar, ignore —"
  echo "   são otimizações opcionais; o jogo funciona normalmente sem elas.)"
fi

# evita que o Android coloque a CPU para dormir enquanto o servidor roda
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  trap 'termux-wake-unlock >/dev/null 2>&1' EXIT
fi

echo ""
echo "  💡 Durante a partida: mantenha o Termux aberto e a tela deste celular ligada."
echo "     Em Ajustes → Apps → Termux → Bateria, marque \"Sem restrições\" para o"
echo "     Android não encerrar o Termux sozinho quando a tela apagar."
echo ""
echo "  💡 Sem Wi-Fi por perto? Ligue o ponto de acesso (hotspot) deste próprio"
echo "     celular e peça para os outros se conectarem nele."
echo ""

node server/index.js --abrir
