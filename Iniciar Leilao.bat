@echo off
REM Dois cliques neste arquivo: sobe o servidor do Leilao e abre o jogo no navegador.
REM Feche esta janela (ou Ctrl+C) para encerrar.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js nao encontrado. Instale em https://nodejs.org ^(versao LTS^) e tente de novo.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   Primeira vez: instalando dependencias...
  call npm install --no-audit --no-fund
)

node server\index.js --abrir
pause
