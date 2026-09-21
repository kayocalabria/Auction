# 🔨 Leilão — Monte seu time

Jogo de leilão de itens (jogos, filmes, séries, atletas, álbuns…) para 2 a 6
pessoas. Os itens são sorteados e revelados um a um; cada um dá lances com o
orçamento que tem e monta o melhor time. No fim, a nota de cada item (Metacritic,
IMDb…) é revelada e o time com a maior soma vence.

**Jogar agora (modo local, qualquer aparelho):** https://kayocalabria.github.io/Auction/

## Dois modos de jogo

| | Local | Sala (celulares) |
|---|---|---|
| Como funciona | Todo mundo dá lance numa tela só | Cada um dá lance pelo próprio celular; a tela principal vai para a TV |
| Precisa instalar? | Não — abre no navegador, funciona offline | Sim — o servidor roda no computador da sala |
| Onde | Link acima, ou `index.html` | `Iniciar Leilão.command` / `npm start` |

O jogo é um PWA: no celular ou no computador, use "Adicionar à tela de início" /
"Instalar app" no navegador e ele vira um app com ícone, sem barra de endereço.

## Modo sala — como jogar em casa

1. **Mac:** dois cliques em **`Iniciar Leilão.command`**.
   **Windows:** dois cliques em **`Iniciar Leilao.bat`**.
   **Linux:** `./iniciar.sh`.
   (Na primeira vez ele instala as dependências sozinho. Precisa do
   [Node.js](https://nodejs.org) instalado.)
2. O navegador abre em `http://localhost:3000`. Escolha **Modo de jogo → Sala** e
   clique em **Criar sala**. Espelhe essa tela na TV (AirPlay, cabo, Chromecast…).
3. Cada pessoa aponta a câmera do celular para o **QR code** (ou abre o endereço
   `http://192.168.x.x:3000/play` que aparece na tela) e digita o **código de 4
   letras** + o nome.
4. Configure temas e regras, sorteie e inicie. A cada lance dado no celular a TV
   mostra um pop-up com o nome e o valor.

Todos precisam estar no **mesmo Wi-Fi**. Se o Mac perguntar se o `node` pode
aceitar conexões, permita. Redes de hotel/empresa isolam os aparelhos entre si —
nesse caso use o hotspot de um celular e conecte o computador nele.

Recarregou a página principal? A sala volta sozinha. Celular bloqueou a tela ou
caiu o Wi-Fi? Ele volta para a partida sozinho.

### Atalho no Dock (Mac)

Na pasta do jogo existe `Leilão.app` (gerado localmente, não vai para o Git).
Arraste para o Dock: um clique abre o Terminal, sobe o servidor e abre o jogo.
Se você baixou o projeto e o app não existe, use o `.command` — ou recrie o app
com:

```bash
osacompile -o "Leilão.app" -e 'set pasta to POSIX path of ((path to me as text) & "::")' -e 'tell application "Terminal" to do script quoted form of (pasta & "Iniciar Leilão.command")'
```

> Baixou o projeto pelo navegador e o `.command` não abre? Clique com o botão
> direito → **Abrir** (só na primeira vez), ou rode `chmod +x "Iniciar Leilão.command"`.

### Linha de comando

```bash
npm install
npm start          # servidor em http://localhost:3000
npm run abrir      # idem, e já abre o navegador
```

### Docker (qualquer sistema)

```bash
docker build -t leilao .
docker run -p 3000:3000 leilao
```

### Online (fora da rede local)

O mesmo servidor roda em qualquer host Node (Render, Railway, Fly.io…): basta
publicar o repositório e apontar para `node server/index.js`; ele respeita a
variável `PORT`. Aí o host e os celulares acessam a URL pública — sem precisar
estar na mesma rede.

## Como funciona por dentro

| Arquivo | O quê |
|---|---|
| `index.html` / `app.js` / `style.css` | Tela principal (host): regras do jogo, timer, martelo, resultado |
| `sala.js` | Modo sala no host: lobby, roster, transmissão de estado, pop-up de lance |
| `play.html` / `play.js` / `play.css` | Tela do celular |
| `server/index.js` | Servidor: arquivos estáticos + relay WebSocket das salas |
| `data.js` | Banco de itens padrão (notas embutidas, nada é buscado em runtime) |
| `sw.js` / `manifest.webmanifest` | PWA: instalável e funciona offline (modo local) |

O **host é a autoridade**: valida cada lance e roda o timer. O servidor só cria
salas (código de 4 caracteres) e repassa mensagens. Os celulares só mostram o
último estado recebido — por isso a lógica do jogo existe num lugar só.

## Licença

MIT. O gerador de QR code em `vendor/qrcode.js` é de Kazuhiko Arase (MIT).
