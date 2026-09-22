"use strict";

/* =========================================================
   Servidor do Leilão — arquivos estáticos + relay de salas
   =========================================================
   O servidor NÃO conhece as regras do jogo. Ele só:
   - serve os arquivos do jogo (host em "/", celular em "/play");
   - cria salas com código de 4 caracteres;
   - repassa mensagens entre o host (tela principal) e os
     jogadores (celulares) da mesma sala;
   - guarda o último estado enviado pelo host, para entregar
     imediatamente a quem (re)conectar.

   O host é a autoridade: valida lances, roda o timer e decide
   quem entra na sala. Ver sala.js (host) e play.js (jogador).
   ========================================================= */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ABRIR_NAVEGADOR = process.argv.includes("--abrir");
const RAIZ = path.resolve(__dirname, "..");
const ALFABETO_CODIGO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem I, O, 0, 1 (ambíguos na TV)
const TAMANHO_CODIGO = 4;
const MAX_JOGADORES = 6;
const TTL_SALA_SEM_HOST_MS = 2 * 60 * 60 * 1000; // sala sem host some depois de 2h
const HEARTBEAT_MS = 30 * 1000;

/* ---------- arquivos estáticos ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const ROTAS = {
  "/": "index.html",
  "/index.html": "index.html",
  "/play": "play.html",
  "/play.html": "play.html",
};
const PASTAS_PUBLICAS = ["vendor", "icons"];

function servirEstatico(req, res) {
  const url = new URL(req.url, "http://localhost");
  let rel = ROTAS[url.pathname];
  if (!rel) {
    rel = url.pathname.replace(/^\/+/, "");
    // só arquivos da raiz do projeto e das pastas públicas (sem node_modules, sem "..")
    const pastaOk = PASTAS_PUBLICAS.some((p) => rel.startsWith(p + "/") && /^[a-zA-Z0-9_.-]+$/.test(rel.slice(p.length + 1)));
    if (!pastaOk && (!/^[a-zA-Z0-9_.-]+$/.test(rel) || rel.startsWith("."))) {
      res.writeHead(404);
      res.end("Não encontrado");
      return;
    }
  }
  const arquivo = path.join(RAIZ, rel);
  fs.readFile(arquivo, (err, dados) => {
    if (err) {
      res.writeHead(404);
      res.end("Não encontrado");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(arquivo)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(dados);
  });
}

/* ---------- salas ---------- */
// salas: Map<codigo, { codigo, hostToken, host: ws|null, hostSaiuEm, jogadores: Map<id, {id, nome, ws, aceito}>, ultimoEstado }>
const salas = new Map();

function gerarCodigo() {
  for (let tentativa = 0; tentativa < 100; tentativa++) {
    let codigo = "";
    for (let i = 0; i < TAMANHO_CODIGO; i++) {
      codigo += ALFABETO_CODIGO[crypto.randomInt(ALFABETO_CODIGO.length)];
    }
    if (!salas.has(codigo)) return codigo;
  }
  throw new Error("Não foi possível gerar um código de sala livre.");
}

function normalizarCodigo(codigo) {
  return String(codigo || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, TAMANHO_CODIGO);
}

function normalizarNome(nome) {
  return String(nome || "").replace(/\s+/g, " ").trim().slice(0, 24);
}

function enviar(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function enviarAosJogadores(sala, msg, filtro) {
  sala.jogadores.forEach((j) => {
    if (j.aceito && (!filtro || filtro(j))) enviar(j.ws, msg);
  });
}

function listaJogadores(sala) {
  return Array.from(sala.jogadores.values()).map((j) => ({
    id: j.id,
    nome: j.nome,
    aceito: j.aceito,
    conectado: !!(j.ws && j.ws.readyState === j.ws.OPEN),
  }));
}

function urlsDaRede() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((nome) => {
    (ifaces[nome] || []).forEach((info) => {
      if (info.family === "IPv4" && !info.internal) ips.push({ nome, ip: info.address });
    });
  });
  // en0 (Wi-Fi no Mac) primeiro, depois redes privadas comuns
  ips.sort((a, b) => {
    const peso = (x) => (x.nome === "en0" ? 0 : /^(192\.168|10\.)/.test(x.ip) ? 1 : 2);
    return peso(a) - peso(b);
  });
  return ips.map((x) => `http://${x.ip}:${PORT}`);
}

function criarSala(codigoDesejado) {
  const codigo = codigoDesejado && !salas.has(codigoDesejado) ? codigoDesejado : gerarCodigo();
  const sala = {
    codigo,
    hostToken: crypto.randomBytes(12).toString("hex"),
    host: null,
    hostSaiuEm: null,
    jogadores: new Map(),
    ultimoEstado: null,
    criadaEm: Date.now(),
  };
  salas.set(codigo, sala);
  return sala;
}

function vincularHost(sala, ws) {
  if (sala.host && sala.host !== ws) {
    enviar(sala.host, { t: "sala:substituida" });
    sala.host.sala = null;
    sala.host.close();
  }
  sala.host = ws;
  sala.hostSaiuEm = null;
  ws.papel = "host";
  ws.sala = sala;
  enviar(ws, { t: "sala:criada", codigo: sala.codigo, hostToken: sala.hostToken, urls: urlsDaRede() });
  enviar(ws, { t: "sala:jogadores", jogadores: listaJogadores(sala) });
  enviarAosJogadores(sala, { t: "host:online" });
  // quem estava esperando o host voltar precisa ser reapresentado a ele
  sala.jogadores.forEach((j) => {
    if (j.ws && j.ws.readyState === j.ws.OPEN) {
      enviar(ws, { t: "jogador:entrou", id: j.id, nome: j.nome, jaAceito: j.aceito });
    }
  });
}

/* ---------- mensagens do host ---------- */
function tratarHost(ws, msg) {
  if (msg.t === "host:criar") {
    const desejado = normalizarCodigo(msg.codigo);
    const existente = desejado ? salas.get(desejado) : null;
    if (existente && msg.hostToken && existente.hostToken === msg.hostToken) {
      vincularHost(existente, ws); // host voltou (recarregou a página)
      return;
    }
    vincularHost(criarSala(desejado), ws);
    return;
  }

  const sala = ws.sala;
  if (!sala || ws.papel !== "host") {
    enviar(ws, { t: "erro", erro: "Crie a sala antes." });
    return;
  }

  switch (msg.t) {
    case "host:aceitar": {
      const j = sala.jogadores.get(msg.id);
      if (!j) return;
      j.aceito = true;
      if (msg.nome) j.nome = normalizarNome(msg.nome) || j.nome;
      enviar(j.ws, { t: "entrou:ok", id: j.id, nome: j.nome, codigo: sala.codigo });
      if (sala.ultimoEstado) enviar(j.ws, sala.ultimoEstado);
      enviar(ws, { t: "sala:jogadores", jogadores: listaJogadores(sala) });
      break;
    }
    case "host:recusar": {
      const j = sala.jogadores.get(msg.id);
      if (!j) return;
      enviar(j.ws, { t: "entrou:erro", erro: msg.motivo || "O host não aceitou a entrada." });
      sala.jogadores.delete(j.id);
      if (j.ws) {
        j.ws.sala = null;
        j.ws.close();
      }
      enviar(ws, { t: "sala:jogadores", jogadores: listaJogadores(sala) });
      break;
    }
    case "host:remover": {
      const j = sala.jogadores.get(msg.id);
      if (!j) return;
      enviar(j.ws, { t: "removido", motivo: msg.motivo || "Você foi removido da sala pelo host." });
      sala.jogadores.delete(j.id);
      if (j.ws) {
        j.ws.sala = null;
        j.ws.close();
      }
      enviar(ws, { t: "sala:jogadores", jogadores: listaJogadores(sala) });
      break;
    }
    case "host:estado": {
      sala.ultimoEstado = { t: "estado", estado: msg.estado };
      enviarAosJogadores(sala, sala.ultimoEstado);
      break;
    }
    case "host:para": {
      const j = sala.jogadores.get(msg.id);
      if (j) enviar(j.ws, msg.msg);
      break;
    }
    case "host:todos": {
      enviarAosJogadores(sala, msg.msg);
      break;
    }
    case "host:encerrar": {
      enviarAosJogadores(sala, { t: "removido", motivo: "O host encerrou a sala." });
      sala.jogadores.forEach((j) => j.ws && j.ws.close());
      salas.delete(sala.codigo);
      ws.sala = null;
      ws.papel = null;
      enviar(ws, { t: "sala:encerrada" });
      break;
    }
    default:
      enviar(ws, { t: "erro", erro: `Mensagem desconhecida: ${msg.t}` });
  }
}

/* ---------- mensagens do jogador ---------- */
function tratarJogador(ws, msg) {
  if (msg.t === "jogador:entrar") {
    const codigo = normalizarCodigo(msg.codigo);
    const nome = normalizarNome(msg.nome);
    const id = typeof msg.token === "string" && /^[a-z0-9-]{8,64}$/.test(msg.token) ? msg.token : null;
    const sala = salas.get(codigo);

    if (!sala) return enviar(ws, { t: "entrou:erro", erro: "Sala não encontrada. Confira o código na TV.", codigoInvalido: true });
    if (!nome) return enviar(ws, { t: "entrou:erro", erro: "Digite seu nome." });
    if (!id) return enviar(ws, { t: "entrou:erro", erro: "Identificação inválida. Recarregue a página." });

    // solta a sala anterior, se estava em outra
    if (ws.sala && ws.sala !== sala) desvincularJogador(ws);

    let j = sala.jogadores.get(id);
    if (j) {
      if (j.ws && j.ws !== ws && j.ws.readyState === j.ws.OPEN) {
        enviar(j.ws, { t: "removido", motivo: "Você entrou por outra aba/dispositivo." });
        j.ws.sala = null;
        j.ws.close();
      }
      j.ws = ws;
      j.nome = nome || j.nome;
    } else {
      if (sala.jogadores.size >= MAX_JOGADORES * 2) {
        // limite folgado: o host decide quem entra de fato (MAX_JOGADORES aceitos)
        return enviar(ws, { t: "entrou:erro", erro: "A sala está lotada." });
      }
      j = { id, nome, ws, aceito: false };
      sala.jogadores.set(id, j);
    }
    ws.papel = "jogador";
    ws.sala = sala;
    ws.jogadorId = id;

    if (!sala.host || sala.host.readyState !== sala.host.OPEN) {
      enviar(ws, { t: "sala:sem-host" });
      return;
    }
    enviar(sala.host, { t: "jogador:entrou", id, nome, jaAceito: j.aceito });
    enviar(sala.host, { t: "sala:jogadores", jogadores: listaJogadores(sala) });
    return;
  }

  const sala = ws.sala;
  if (!sala || ws.papel !== "jogador") {
    enviar(ws, { t: "erro", erro: "Entre em uma sala antes." });
    return;
  }
  const j = sala.jogadores.get(ws.jogadorId);
  if (!j || !j.aceito) {
    enviar(ws, { t: "erro", erro: "Aguardando o host aceitar sua entrada." });
    return;
  }

  switch (msg.t) {
    case "jogador:lance": {
      const valor = Number(msg.valor);
      if (!Number.isFinite(valor)) return;
      if (!sala.host) return enviar(ws, { t: "lance:resultado", ok: false, erro: "Host desconectado.", valor });
      enviar(sala.host, { t: "lance", id: j.id, valor, ref: msg.ref });
      break;
    }
    case "jogador:ping":
      enviar(ws, { t: "pong" });
      break;
    default:
      enviar(ws, { t: "erro", erro: `Mensagem desconhecida: ${msg.t}` });
  }
}

function desvincularJogador(ws) {
  const sala = ws.sala;
  if (!sala) return;
  const j = sala.jogadores.get(ws.jogadorId);
  if (j && j.ws === ws) {
    j.ws = null;
    if (!j.aceito) sala.jogadores.delete(j.id); // nunca entrou de fato: some da lista
    if (sala.host) {
      enviar(sala.host, { t: "jogador:saiu", id: j.id });
      enviar(sala.host, { t: "sala:jogadores", jogadores: listaJogadores(sala) });
    }
  }
  ws.sala = null;
}

function desvincularHost(ws) {
  const sala = ws.sala;
  if (!sala || sala.host !== ws) return;
  sala.host = null;
  sala.hostSaiuEm = Date.now();
  enviarAosJogadores(sala, { t: "host:offline" });
  ws.sala = null;
}

/* ---------- servidor ---------- */
const servidor = http.createServer(servirEstatico);
const wss = new WebSocketServer({ server: servidor, path: "/ws" });
wss.on("error", () => {
  /* o erro real (ex.: porta ocupada) é tratado no servidor http abaixo */
});

wss.on("connection", (ws) => {
  ws.papel = null;
  ws.sala = null;
  ws.jogadorId = null;
  ws.vivo = true;

  ws.on("pong", () => {
    ws.vivo = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (e) {
      return enviar(ws, { t: "erro", erro: "JSON inválido." });
    }
    if (!msg || typeof msg.t !== "string") return;
    if (msg.t.startsWith("host:")) tratarHost(ws, msg);
    else if (msg.t.startsWith("jogador:")) tratarJogador(ws, msg);
    else enviar(ws, { t: "erro", erro: `Mensagem desconhecida: ${msg.t}` });
  });

  ws.on("close", () => {
    if (ws.papel === "host") desvincularHost(ws);
    else if (ws.papel === "jogador") desvincularJogador(ws);
  });

  ws.on("error", () => {
    /* o close cuida da limpeza */
  });
});

// detecta conexões mortas (celular bloqueado, Wi-Fi caiu) e expira salas abandonadas
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.vivo) return ws.terminate();
    ws.vivo = false;
    ws.ping();
  });
  const agora = Date.now();
  salas.forEach((sala, codigo) => {
    if (!sala.host && sala.hostSaiuEm && agora - sala.hostSaiuEm > TTL_SALA_SEM_HOST_MS) {
      sala.jogadores.forEach((j) => j.ws && j.ws.close());
      salas.delete(codigo);
    }
  });
}, HEARTBEAT_MS);

servidor.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("");
    console.error(`  ❌ A porta ${PORT} já está em uso — provavelmente o Leilão já está rodando em outra janela.`);
    console.error(`     Abra http://localhost:${PORT} ou feche a outra janela e tente de novo.`);
    console.error("");
    process.exit(1);
  }
  throw err;
});

servidor.listen(PORT, "0.0.0.0", () => {
  const urls = urlsDaRede();
  console.log("");
  console.log("  🔨 Leilão — servidor no ar");
  console.log("");
  console.log(`  Tela principal (host):  http://localhost:${PORT}`);
  if (urls.length) {
    console.log(`  Celulares (mesma rede): ${urls[0]}/play`);
    urls.slice(1).forEach((u) => console.log(`                          ${u}/play`));
  } else {
    console.log("  (nenhuma rede local detectada — conecte-se ao Wi-Fi)");
  }
  console.log("");
  console.log("  Ctrl+C para encerrar.");
  console.log("");
  if (ABRIR_NAVEGADOR) abrirNavegador(`http://localhost:${PORT}`);
});

// abre a tela principal no navegador padrão (usado pelos atalhos de um clique)
function emTermux() {
  return !!(process.env.PREFIX && process.env.PREFIX.includes("com.termux"));
}

function abrirNavegador(url) {
  // Termux (Android) não tem "open"/"xdg-open" — usa o comando do Termux:API,
  // que só existe se o pacote termux-api (e o app companheiro) estiver instalado.
  const cmd = emTermux()
    ? ["termux-open-url", [url]]
    : process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    const proc = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true });
    // sem esse listener, um comando ausente (ex.: termux-open-url sem o Termux:API)
    // derruba o processo inteiro com um erro não tratado
    proc.on("error", () => console.log(`  (não consegui abrir o navegador sozinho — abra ${url})`));
    proc.unref();
  } catch (e) {
    console.log(`  (não consegui abrir o navegador sozinho — abra ${url})`);
  }
}
