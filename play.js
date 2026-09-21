"use strict";

/* =========================================================
   Leilão — lado do JOGADOR (celular)
   =========================================================
   Cliente "burro": não conhece as regras. Só mostra o snapshot
   que o host transmite e manda lances; quem valida é o host.
   ========================================================= */

const CHAVE_TOKEN = "leilaoJogadorToken";
const CHAVE_NOME = "leilaoJogadorNome";
const CHAVE_CODIGO = "leilaoJogadorCodigo";
const CHAVE_SOM = "leilaoJogadorSom";
const CORES = ["#d4af37", "#22c55e", "#3b82f6", "#ec4899", "#f97316", "#a855f7"];
const TIMEOUT_LANCE_MS = 4000;

const APP = {
  token: null,
  nome: "",
  codigo: "",
  ws: null,
  conectado: false,
  querEntrar: false, // já pediu pra entrar (re-envia ao reconectar)
  aceito: false,
  tentativas: 0,
  timerReconexao: null,
  timerRetentarEntrada: null,
  estado: null, // último snapshot do host
  recebidoEm: 0,
  timerContador: null,
  lancePendente: null, // { ref, valor, timer }
  ultimoLiderId: null,
  ultimaRodada: null,
};

/* ---------- utilidades ---------- */
function $(id) {
  return document.getElementById(id);
}

function fmtMoeda(v) {
  return `R$ ${Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function gerarToken() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "j-" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

function vibrar(padrao) {
  try {
    if (navigator.vibrate) navigator.vibrate(padrao);
  } catch (e) {
    /* iOS não tem */
  }
}

/* ---------- som ----------
   O AudioContext só "destrava" depois de um toque do usuário; criamos no
   primeiro toque (Entrar / botão de lance) e reaproveitamos. */
const SOM = {
  ctx: null,
  ligado: localStorage.getItem(CHAVE_SOM) !== "off",
  destravar() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.ctx) this.ctx = new AudioCtx();
      if (this.ctx.state === "suspended") this.ctx.resume();
    } catch (e) {
      /* sem áudio */
    }
  },
  tocar(notas, tipo = "triangle", volume = 0.35) {
    if (!this.ligado || !this.ctx) return;
    try {
      const t0 = this.ctx.currentTime;
      notas.forEach(([freq, inicio, duracao]) => {
        const osc = this.ctx.createOscillator();
        const ganho = this.ctx.createGain();
        osc.type = tipo;
        osc.frequency.setValueAtTime(freq, t0 + inicio);
        ganho.gain.setValueAtTime(0.0001, t0 + inicio);
        ganho.gain.exponentialRampToValueAtTime(volume, t0 + inicio + 0.012);
        ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + inicio + duracao);
        osc.connect(ganho).connect(this.ctx.destination);
        osc.start(t0 + inicio);
        osc.stop(t0 + inicio + duracao + 0.02);
      });
    } catch (e) {
      /* sem áudio */
    }
  },
  aceito() {
    this.tocar([[880, 0, 0.12], [1320, 0.08, 0.18]]);
  },
  superado() {
    this.tocar([[520, 0, 0.14], [390, 0.13, 0.22]], "square", 0.22);
  },
  ganhou() {
    this.tocar([[660, 0, 0.12], [880, 0.12, 0.12], [1100, 0.24, 0.12], [1320, 0.36, 0.4]]);
  },
  erro() {
    this.tocar([[220, 0, 0.16]], "square", 0.18);
  },
  alternar() {
    this.ligado = !this.ligado;
    localStorage.setItem(CHAVE_SOM, this.ligado ? "on" : "off");
    if (this.ligado) {
      this.destravar();
      this.aceito();
    }
    renderBotaoSom();
  },
};

function renderBotaoSom() {
  const btn = $("btn-som");
  if (!btn) return;
  btn.textContent = SOM.ligado ? "🔔" : "🔕";
  btn.title = SOM.ligado ? "Som ligado — toque para silenciar" : "Som desligado — toque para ligar";
}

/* ---------- wake lock (tela não apaga durante o leilão) ----------
   Só existe em contexto seguro (https ou localhost). Na rede local em http
   não está disponível — aí a reconexão automática cobre o caso. */
const WAKE = {
  lock: null,
  async pedir() {
    try {
      if (!("wakeLock" in navigator) || this.lock) return;
      this.lock = await navigator.wakeLock.request("screen");
      this.lock.addEventListener("release", () => {
        this.lock = null;
      });
    } catch (e) {
      this.lock = null;
    }
  },
  soltar() {
    try {
      if (this.lock) this.lock.release();
    } catch (e) {
      /* ignora */
    }
    this.lock = null;
  },
};

function mostrarTela(nome) {
  document.body.dataset.tela = nome;
}

let toastTimer = null;
function toast(texto, tipo = "", duracaoMs = 1800) {
  const el = $("toast");
  el.textContent = texto;
  el.className = "toast " + tipo;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), duracaoMs);
}

function banner(texto, tipo = "") {
  const el = $("banner-conexao");
  if (!texto) {
    el.classList.add("hidden");
    return;
  }
  el.textContent = texto;
  el.className = "banner-conexao " + tipo;
}

/* ---------- conexão ---------- */
function urlWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function conectar() {
  if (APP.ws && (APP.ws.readyState === WebSocket.OPEN || APP.ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(APP.timerReconexao);
  let ws;
  try {
    ws = new WebSocket(urlWs());
  } catch (e) {
    banner("Não foi possível conectar. Verifique o Wi-Fi.");
    agendarReconexao();
    return;
  }
  APP.ws = ws;

  ws.addEventListener("open", () => {
    APP.conectado = true;
    APP.tentativas = 0;
    banner("");
    if (APP.querEntrar) enviarEntrada();
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    tratarMensagem(msg);
  });

  ws.addEventListener("close", () => {
    if (APP.ws !== ws) return;
    APP.ws = null;
    APP.conectado = false;
    if (APP.querEntrar) banner("Sem conexão — reconectando…");
    agendarReconexao();
  });

  ws.addEventListener("error", () => {
    /* close cuida */
  });
}

function agendarReconexao() {
  clearTimeout(APP.timerReconexao);
  APP.tentativas += 1;
  const espera = Math.min(5000, 700 * APP.tentativas);
  APP.timerReconexao = setTimeout(conectar, espera);
}

function enviar(msg) {
  if (APP.ws && APP.ws.readyState === WebSocket.OPEN) {
    APP.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function enviarEntrada() {
  clearTimeout(APP.timerRetentarEntrada);
  enviar({ t: "jogador:entrar", codigo: APP.codigo, nome: APP.nome, token: APP.token });
}

/* ---------- mensagens ---------- */
function tratarMensagem(msg) {
  switch (msg.t) {
    case "entrou:ok":
      APP.aceito = true;
      APP.nome = msg.nome || APP.nome;
      APP.codigo = msg.codigo || APP.codigo;
      localStorage.setItem(CHAVE_NOME, APP.nome);
      localStorage.setItem(CHAVE_CODIGO, APP.codigo);
      banner("");
      $("btn-entrar").disabled = false;
      $("espera-codigo").textContent = APP.codigo;
      if (!APP.estado) mostrarTela("espera");
      break;

    case "entrou:erro":
      APP.querEntrar = false;
      APP.aceito = false;
      $("btn-entrar").disabled = false;
      $("entrar-erro").textContent = msg.erro || "Não foi possível entrar.";
      mostrarTela("entrar");
      if (msg.codigoInvalido) $("input-codigo").focus();
      break;

    case "sala:sem-host":
      banner("A TV está desconectada — aguardando o host voltar…", "aviso");
      clearTimeout(APP.timerRetentarEntrada);
      APP.timerRetentarEntrada = setTimeout(enviarEntrada, 3000);
      break;

    case "host:online":
      banner("");
      if (APP.querEntrar) enviarEntrada();
      break;

    case "host:offline":
      banner("A TV está desconectada — aguardando o host voltar…", "aviso");
      break;

    case "removido":
      APP.querEntrar = false;
      APP.aceito = false;
      APP.estado = null;
      pararContador();
      banner("");
      $("entrar-erro").textContent = msg.motivo || "Você saiu da sala.";
      mostrarTela("entrar");
      break;

    case "estado":
      receberEstado(msg.estado);
      break;

    case "lance:resultado":
      receberResultadoLance(msg);
      break;

    case "erro":
      console.warn("[servidor]", msg.erro);
      break;
  }
}

/* ---------- estado ---------- */
function eu() {
  const e = APP.estado;
  return e && e.jogadores ? e.jogadores.find((j) => j.id === APP.token) : null;
}

function receberEstado(estado) {
  const anterior = APP.estado;
  APP.estado = estado;
  APP.recebidoEm = Date.now();

  if (estado.fase === "leilao") {
    detectarSuperado(anterior, estado);
    detectarArremate(anterior, estado);
    renderLeilao();
    mostrarTela("leilao");
    WAKE.pedir();
  } else if (estado.fase === "resultado") {
    pararContador();
    renderResultado(anterior);
    mostrarTela("resultado");
    WAKE.soltar();
  } else {
    pararContador();
    renderEspera();
    mostrarTela("espera");
    WAKE.soltar();
  }
}

function detectarSuperado(anterior, atual) {
  if (!anterior || anterior.fase !== "leilao") return;
  const mesmaRodada = anterior.rodada === atual.rodada;
  const euLiderava = anterior.liderId === APP.token;
  const outroLidera = atual.liderId && atual.liderId !== APP.token;
  if (mesmaRodada && euLiderava && outroLidera) {
    const lider = atual.jogadores.find((j) => j.id === atual.liderId);
    toast(`${lider ? lider.nome : "Alguém"} cobriu seu lance!`, "superado", 2200);
    vibrar([90, 50, 90]);
    SOM.superado();
    const bloco = $("lance-atual").parentElement;
    bloco.classList.add("superado");
    setTimeout(() => bloco.classList.remove("superado"), 1500);
  }
}

function detectarArremate(anterior, atual) {
  const comecouMartelo = atual.emMartelo && !(anterior && anterior.emMartelo && anterior.rodada === atual.rodada);
  if (!comecouMartelo || !atual.loteFechado) return;
  const me = eu();
  if (me && atual.loteFechado.vencedorNome === me.nome) {
    SOM.ganhou();
    vibrar([60, 40, 60, 40, 120]);
  }
}

/* ---------- render: espera ---------- */
function renderEspera() {
  const e = APP.estado;
  $("espera-codigo").textContent = (e && e.codigo) || APP.codigo;
  const lista = $("espera-lista");
  const jogadores = (e && e.jogadores) || [];
  if (!jogadores.length) {
    lista.innerHTML = '<li style="color:var(--texto-secundario)">Ninguém ainda…</li>';
    return;
  }
  lista.innerHTML = jogadores
    .map((j, i) => {
      const cls = (j.id === APP.token ? "eu" : "") + (j.conectado === false ? " offline" : "");
      return `<li class="${cls}"><span class="ponto" style="--cor:${CORES[i % CORES.length]}"></span>${escapeHtml(j.nome)}</li>`;
    })
    .join("");
}

/* ---------- render: leilão ---------- */
function renderLeilao() {
  const e = APP.estado;
  const me = eu();
  const cfg = e.config || {};
  const item = e.item || { nome: "—", icon: "🔨", tema: "" };

  $("topo-rodada").textContent = `Rodada ${e.rodada}/${e.total}`;
  $("topo-nome").textContent = me ? me.nome : APP.nome;
  $("topo-sala").textContent = `Sala ${e.codigo || APP.codigo}`;
  $("item-tema").textContent = `${item.icon || ""} ${item.tema || ""}`.trim();
  $("item-nome").textContent = item.nome;

  const lider = e.liderId ? e.jogadores.find((j) => j.id === e.liderId) : null;
  const souLider = !!(lider && lider.id === APP.token);
  const valorEl = $("lance-atual");
  const valorAnterior = valorEl.dataset.valor;
  valorEl.textContent = fmtMoeda(e.lanceAtual || 0);
  if (valorAnterior !== undefined && valorAnterior !== String(e.lanceAtual)) {
    valorEl.classList.remove("pulsar");
    void valorEl.offsetWidth;
    valorEl.classList.add("pulsar");
  }
  valorEl.dataset.valor = String(e.lanceAtual);
  const liderEl = $("lance-lider");
  liderEl.textContent = lider ? (souLider ? "Você está na frente 👑" : `${lider.nome} está na frente`) : "Nenhum lance ainda";
  liderEl.classList.toggle("eu", souLider);
  valorEl.parentElement.classList.toggle("lider", souLider);

  $("carteira").textContent = fmtMoeda(me ? me.carteira : 0);
  const qtdItens = me ? me.itens.length : 0;
  $("carteira-sub").textContent = cfg.regraTime === "min" ? `Time ${qtdItens} (mín. ${cfg.tamanhoTime})` : `Time ${qtdItens}/${cfg.tamanhoTime}`;
  $("meu-time").textContent = me && me.itens.length ? me.itens.map((i) => i.nome).join(" · ") : "nenhum item ainda";

  // por que não dá pra dar lance agora (se não der)
  let bloqueio = null;
  if (!me) bloqueio = "Você não está nesta partida.";
  else if (e.aguardandoDecisaoFim) bloqueio = "Todos os times estão completos — aguardando o host.";
  else if (e.emRevelacao) bloqueio = "Revelando o próximo item…";
  else if (e.emMartelo) bloqueio = "Lance fechado!";
  else if (e.pausado) bloqueio = "Leilão pausado pelo host.";
  else if (me.timeCheio) bloqueio = `Seu time está completo (${cfg.tamanhoTime}).`;
  else if (souLider) bloqueio = "Você está na frente 👑 — espere alguém cobrir.";

  const aviso = $("aviso");
  if (APP.lancePendente) {
    aviso.textContent = "Enviando lance…";
    aviso.className = "aviso";
  } else if (bloqueio) {
    aviso.textContent = bloqueio;
    aviso.className = "aviso" + (souLider && !e.emMartelo && !e.pausado && !e.emRevelacao ? " lider" : "");
  } else {
    aviso.textContent = "";
    aviso.className = "aviso";
  }

  const travado = !!bloqueio || !!APP.lancePendente || !APP.conectado;
  renderBotoes(e, me, travado);

  const input = $("input-lance-livre");
  input.min = (e.lanceAtual || 0) + 1;
  input.max = me ? me.carteira : 0;
  input.placeholder = `Outro valor (mín. ${(e.lanceAtual || 0) + 1})`;
  input.disabled = travado;
  $("btn-lance-livre").disabled = travado;

  renderOverlay(e, me);
  iniciarContador();
}

function renderBotoes(e, me, travado) {
  const cont = $("botoes-lance");
  const incrementos = (e.config && e.config.incrementos) || [1, 2, 5];
  const base = e.lanceAtual || 0;
  cont.innerHTML = incrementos
    .map((inc) => {
      const total = base + inc;
      const semSaldo = !me || total > me.carteira;
      return `<button type="button" class="btn-lance" data-valor="${total}" ${travado || semSaldo ? "disabled" : ""}>
        <span class="btn-lance-inc">+${inc}</span>
        <span class="btn-lance-total">${fmtMoeda(total)}</span>
      </button>`;
    })
    .join("");
  cont.querySelectorAll(".btn-lance").forEach((btn) => {
    btn.addEventListener("click", () => darLance(Number(btn.dataset.valor)));
  });
}

function renderOverlay(e, me) {
  const ov = $("overlay-estado");
  const icone = $("overlay-icone");
  const titulo = $("overlay-titulo");
  const sub = $("overlay-sub");
  ov.classList.remove("vendido-eu");
  icone.classList.remove("bater");

  if (e.emMartelo) {
    const f = e.loteFechado || {};
    const euGanhei = f.vencedorNome && me && f.vencedorNome === me.nome;
    icone.textContent = "🔨";
    void icone.offsetWidth;
    icone.classList.add("bater");
    if (f.vencedorNome) {
      titulo.textContent = euGanhei ? "É SEU!" : "VENDIDO!";
      sub.textContent = euGanhei ? `${e.item ? e.item.nome : ""} por ${fmtMoeda(f.valor)}` : `${f.vencedorNome} levou por ${fmtMoeda(f.valor)}`;
      if (euGanhei) ov.classList.add("vendido-eu");
    } else {
      titulo.textContent = "NÃO VENDIDO";
      sub.textContent = "Ninguém deu lance neste item.";
    }
    ov.classList.remove("hidden");
    return;
  }
  if (e.emRevelacao) {
    icone.textContent = e.item ? e.item.icon || "🎁" : "🎁";
    titulo.textContent = "Revelando…";
    sub.textContent = `Rodada ${e.rodada} de ${e.total} — olhe para a TV!`;
    ov.classList.remove("hidden");
    return;
  }
  if (e.aguardandoDecisaoFim) {
    icone.textContent = "🏆";
    titulo.textContent = "Times completos!";
    sub.textContent = "O host vai decidir se encerra agora ou continua.";
    ov.classList.remove("hidden");
    return;
  }
  if (e.pausado) {
    icone.textContent = "⏸";
    titulo.textContent = "Pausado";
    sub.textContent = "O host pausou o leilão. Já volta!";
    ov.classList.remove("hidden");
    return;
  }
  ov.classList.add("hidden");
}

/* ---------- contador (anima localmente a partir do último snapshot) ---------- */
function iniciarContador() {
  pararContador();
  renderContador();
  APP.timerContador = setInterval(renderContador, 100);
}

function pararContador() {
  if (APP.timerContador) {
    clearInterval(APP.timerContador);
    APP.timerContador = null;
  }
}

function renderContador() {
  const e = APP.estado;
  if (!e || e.fase !== "leilao") return;
  const total = e.tempoTotalMs || 1;
  let restante = e.tempoRestanteMs || 0;
  const parado = e.pausado || e.emRevelacao || e.emMartelo || e.aguardandoDecisaoFim;
  if (!parado) restante = Math.max(0, restante - (Date.now() - APP.recebidoEm));
  const pct = Math.max(0, Math.min(100, (restante / total) * 100));
  const barra = $("contador-preenchimento");
  barra.style.width = pct + "%";
  barra.classList.toggle("urgente", !parado && restante <= 3000);
  $("contador-numero").textContent = Math.ceil(restante / 1000) + "s";
  $("contador-preenchimento").parentElement.parentElement.classList.toggle("pausado", !!parado);
}

/* ---------- lances ---------- */
function darLance(valor) {
  if (!Number.isFinite(valor) || valor <= 0) return;
  if (APP.lancePendente) return;
  if (!APP.conectado) {
    toast("Sem conexão com o servidor.", "erro");
    return;
  }
  const ref = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const timer = setTimeout(() => {
    if (APP.lancePendente && APP.lancePendente.ref === ref) {
      APP.lancePendente = null;
      toast("A TV não respondeu. Tente de novo.", "erro");
      renderLeilao();
    }
  }, TIMEOUT_LANCE_MS);
  APP.lancePendente = { ref, valor, timer };
  SOM.destravar();
  vibrar(25);
  enviar({ t: "jogador:lance", valor, ref });
  renderLeilao();
}

function receberResultadoLance(msg) {
  const pendente = APP.lancePendente;
  if (pendente && (!msg.ref || msg.ref === pendente.ref)) {
    clearTimeout(pendente.timer);
    APP.lancePendente = null;
  }
  if (msg.ok) {
    toast(`✓ Lance de ${fmtMoeda(msg.valor)} enviado!`, "ok", 1400);
    vibrar(40);
    SOM.aceito();
    $("input-lance-livre").value = "";
  } else {
    toast(msg.erro || "Lance recusado.", "erro", 2200);
    vibrar([30, 30, 30]);
    SOM.erro();
  }
  if (APP.estado && APP.estado.fase === "leilao") renderLeilao();
}

/* ---------- render: resultado ---------- */
function renderResultado(anterior) {
  const e = APP.estado;
  const primeiraVez = !anterior || anterior.fase !== "resultado";
  const r = e.resultado;
  const me = eu();
  const titulo = $("resultado-titulo");
  const sub = $("resultado-sub");
  const icone = $("resultado-icone");
  const rankingEl = $("resultado-ranking");

  if (r && r.modoMetrica && r.ranking.length) {
    const melhor = r.melhorPontuacao;
    const campeoes = r.ranking.filter((x) => x.pontuacao !== null && x.pontuacao === melhor);
    const souCampeao = campeoes.some((x) => x.id === APP.token);
    icone.textContent = souCampeao ? "🏆" : "🏁";
    titulo.textContent = souCampeao ? "Você venceu!" : "Leilão encerrado!";
    sub.textContent = campeoes.length ? `Campeão: ${campeoes.map((x) => x.nome).join(" e ")} · ${r.metricLabel || "pontuação"}` : "";
    rankingEl.innerHTML =
      '<div class="card-titulo">Ranking</div><ol class="ranking">' +
      r.ranking
        .map((x, i) => {
          const cls = (x.id === APP.token ? "eu " : "") + (x.pontuacao !== null && x.pontuacao === melhor ? "campeao" : "");
          const pts = x.pontuacao === null ? "—" : x.pontuacao.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
          return `<li class="${cls}"><span class="pos">${i + 1}º</span><span class="nome">${escapeHtml(x.nome)}${x.completo ? "" : " <small>(incompleto)</small>"}</span><span class="pts">${pts}</span></li>`;
        })
        .join("") +
      "</ol>";
    rankingEl.classList.remove("hidden");
    if (souCampeao && primeiraVez) {
      vibrar([80, 60, 80, 60, 200]);
      SOM.ganhou();
    }
  } else {
    icone.textContent = "🏁";
    titulo.textContent = "Leilão encerrado!";
    sub.textContent = "Decisão manual — comparem os times na TV.";
    rankingEl.classList.add("hidden");
  }

  const lista = $("resultado-meu-time");
  const itens = me ? me.itens : [];
  lista.innerHTML = itens.length
    ? itens.map((i) => `<li><span>${escapeHtml(i.nome)}</span><strong>${fmtMoeda(i.valor)}</strong></li>`).join("")
    : '<li style="color:var(--texto-secundario)">Você não arrematou nenhum item.</li>';
}

/* ---------- entrar / sair ---------- */
function entrar(ev) {
  ev.preventDefault();
  const codigo = $("input-codigo").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nome = $("input-nome").value.replace(/\s+/g, " ").trim();
  const erro = $("entrar-erro");
  if (codigo.length !== 4) {
    erro.textContent = "O código tem 4 letras/números — está na TV.";
    $("input-codigo").focus();
    return;
  }
  if (!nome) {
    erro.textContent = "Digite seu nome.";
    $("input-nome").focus();
    return;
  }
  erro.textContent = "";
  SOM.destravar();
  APP.codigo = codigo;
  APP.nome = nome;
  APP.querEntrar = true;
  $("btn-entrar").disabled = true;
  localStorage.setItem(CHAVE_NOME, nome);
  localStorage.setItem(CHAVE_CODIGO, codigo);
  if (APP.conectado) enviarEntrada();
  else conectar();
  // se o servidor não responder, libera o botão
  setTimeout(() => {
    if (!APP.aceito) $("btn-entrar").disabled = false;
  }, 5000);
}

function sair() {
  APP.querEntrar = false;
  APP.aceito = false;
  APP.estado = null;
  pararContador();
  localStorage.removeItem(CHAVE_CODIGO);
  if (APP.ws) APP.ws.close();
  $("entrar-erro").textContent = "";
  mostrarTela("entrar");
  conectar();
}

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  APP.token = localStorage.getItem(CHAVE_TOKEN);
  if (!APP.token) {
    APP.token = gerarToken();
    localStorage.setItem(CHAVE_TOKEN, APP.token);
  }
  APP.nome = localStorage.getItem(CHAVE_NOME) || "";
  const params = new URLSearchParams(location.search);
  const codigoUrl = (params.get("sala") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  APP.codigo = codigoUrl || localStorage.getItem(CHAVE_CODIGO) || "";

  $("input-codigo").value = APP.codigo;
  $("input-nome").value = APP.nome;
  $("form-entrar").addEventListener("submit", entrar);
  $("btn-sair").addEventListener("click", sair);
  $("btn-som").addEventListener("click", () => SOM.alternar());
  renderBotaoSom();
  $("form-lance-livre").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = $("input-lance-livre");
    const v = parseInt(input.value, 10);
    const e = APP.estado;
    const me = eu();
    if (!Number.isFinite(v)) {
      toast("Digite um valor.", "erro");
      return;
    }
    // validação local só pra dar feedback rápido — o host valida de verdade
    if (e && v <= (e.lanceAtual || 0)) {
      toast(`Precisa ser maior que ${fmtMoeda(e.lanceAtual || 0)}.`, "erro");
      vibrar([30, 30, 30]);
      return;
    }
    if (me && v > me.carteira) {
      toast(`Sua carteira tem só ${fmtMoeda(me.carteira)}.`, "erro");
      vibrar([30, 30, 30]);
      return;
    }
    darLance(v);
    input.blur();
  });
  $("input-codigo").addEventListener("input", (ev) => {
    ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  });

  // volta direto pra sala se já tinha entrado antes (recarregou / bloqueou a tela)
  if (APP.codigo && APP.nome && (codigoUrl || localStorage.getItem(CHAVE_CODIGO))) {
    APP.querEntrar = true;
    $("btn-entrar").disabled = true;
    setTimeout(() => {
      if (!APP.aceito) $("btn-entrar").disabled = false;
    }, 5000);
  }
  if (!APP.codigo) $("input-codigo").focus();
  else if (!APP.nome) $("input-nome").focus();

  conectar();

  // ao voltar do segundo plano, garante conexão viva e contador certo
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (!APP.conectado) conectar();
      if (APP.estado && APP.estado.fase === "leilao") {
        renderContador();
        WAKE.pedir(); // o sistema solta o wake lock quando a aba vai pro fundo
      }
    }
  });
});
