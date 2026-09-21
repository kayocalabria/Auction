"use strict";

/* =========================================================
   Modo sala — lado do HOST (tela principal / TV)
   =========================================================
   O host é a autoridade do jogo: o app.js continua rodando as
   regras (lances, timer, martelo). Este módulo só:
   - cria/retoma a sala no servidor (server/index.js);
   - mantém o roster (quem entrou pelo celular) e o mapeia para
     os jogadores da partida;
   - recebe lances dos celulares e passa para darLance();
   - transmite um snapshot do estado a cada mudança;
   - mostra o pop-up de "fulano deu um lance!" na TV.

   Depende das globais do app.js (ESTADO, darLance, timeCheio,
   jogadoresSelecionados, etc.). Carregar depois do app.js.
   ========================================================= */

const CHAVE_SALA = "leilaoSalaHost"; // { codigo, hostToken, roster: [{id, nome}] }
const POP_DURACAO_MS = 1500;
const POP_INTERVALO_MS = 180;
const CORES_JOGADORES = ["#d4af37", "#22c55e", "#3b82f6", "#ec4899", "#f97316", "#a855f7"];

const SALA = {
  ativa: false, // modo sala selecionado no setup (ou partida em andamento no modo sala)
  ws: null,
  conectado: false,
  servidorIndisponivel: false,
  codigo: null,
  hostToken: null,
  urls: [],
  roster: [], // [{ id: token do celular, nome }] em ordem de entrada
  conexoes: {}, // id -> true se o celular está conectado agora
  tentativasReconexao: 0,
  timerReconexao: null,
  transmissaoAgendada: false,
  filaPop: [],
  popAtivo: false,
  timerDicaEntrada: null, // mostra dicas de rede se ninguém entrar em 60s

  /* ---------- persistência ---------- */
  carregar() {
    try {
      const raw = localStorage.getItem(CHAVE_SALA);
      const dados = raw ? JSON.parse(raw) : null;
      if (dados && dados.codigo && dados.hostToken) {
        this.codigo = dados.codigo;
        this.hostToken = dados.hostToken;
        this.roster = Array.isArray(dados.roster) ? dados.roster.filter((r) => r && r.id && r.nome) : [];
      }
    } catch (e) {
      console.warn("Falha ao ler dados da sala.", e);
    }
  },

  salvar() {
    if (!this.codigo) {
      localStorage.removeItem(CHAVE_SALA);
      return;
    }
    localStorage.setItem(CHAVE_SALA, JSON.stringify({ codigo: this.codigo, hostToken: this.hostToken, roster: this.roster }));
  },

  /* ---------- liga/desliga o modo ---------- */
  ativar() {
    if (this.ativa) return;
    this.ativa = true;
    elId("jogadores-local").classList.add("hidden");
    elId("jogadores-sala").classList.remove("hidden");
    this.sincronizarJogadores();
    this.renderPainel();
    this.conectar();
  },

  desativar() {
    if (!this.ativa) return;
    this.transmitirEstado(); // celulares voltam pra tela de espera (fase "setup")
    this.ativa = false;
    this.fecharConexao();
    elId("jogadores-local").classList.remove("hidden");
    elId("jogadores-sala").classList.add("hidden");
    jogadoresSelecionados = JOGADORES_SALVOS.slice(0, MAX_JOGADORES);
    atualizarAposMudancaJogadores();
    this.renderBadge();
  },

  /* ---------- conexão com o servidor ---------- */
  urlWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  },

  conectar() {
    if (!this.ativa) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (location.protocol === "file:") {
      this.servidorIndisponivel = true;
      this.renderPainel();
      return;
    }
    clearTimeout(this.timerReconexao);
    this.servidorIndisponivel = false;
    this.renderPainel();

    let ws;
    try {
      ws = new WebSocket(this.urlWs());
    } catch (e) {
      this.servidorIndisponivel = true;
      this.renderPainel();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.conectado = true;
      this.tentativasReconexao = 0;
      this.servidorIndisponivel = false;
      // retoma a sala anterior (recarregou a página) — ou espera o clique em "Criar sala"
      if (this.codigo) {
        // com hostToken: retoma a mesma sala; sem (servidor reiniciou): recria com o mesmo código
        this.enviar({ t: "host:criar", codigo: this.codigo, hostToken: this.hostToken });
      }
      this.renderPainel();
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      this.tratarMensagem(msg);
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const estavaConectado = this.conectado;
      this.conectado = false;
      this.conexoes = {};
      if (!this.ativa) return;
      if (!estavaConectado && this.tentativasReconexao === 0) {
        // nem chegou a abrir: provavelmente o servidor não está rodando
        this.servidorIndisponivel = true;
        this.renderPainel();
        return;
      }
      this.tentativasReconexao += 1;
      const espera = Math.min(5000, 1000 * this.tentativasReconexao);
      this.timerReconexao = setTimeout(() => this.conectar(), espera);
      this.renderPainel();
      this.renderPlacarSeNecessario();
    });

    ws.addEventListener("error", () => {
      /* o close cuida da reconexão */
    });
  },

  fecharConexao() {
    clearTimeout(this.timerReconexao);
    this.timerReconexao = null;
    this.tentativasReconexao = 0;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.conectado = false;
    this.conexoes = {};
  },

  enviar(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  },

  criarSala() {
    if (!this.conectado) return;
    this.codigo = null;
    this.hostToken = null;
    this.roster = [];
    this.conexoes = {};
    this.enviar({ t: "host:criar" });
    elId("sala-criar").classList.add("hidden");
    elId("sala-conectando").classList.remove("hidden");
  },

  encerrarSala() {
    if (!confirm("Encerrar a sala? Todos os celulares serão desconectados.")) return;
    this.enviar({ t: "host:encerrar" });
    this.codigo = null;
    this.hostToken = null;
    this.roster = [];
    this.conexoes = {};
    this.salvar();
    this.sincronizarJogadores();
    this.renderPainel();
    this.renderBadge();
  },

  /* ---------- mensagens do servidor ---------- */
  tratarMensagem(msg) {
    switch (msg.t) {
      case "sala:criada":
        this.codigo = msg.codigo;
        this.hostToken = msg.hostToken;
        this.urls = msg.urls || [];
        this.agendarDicaEntrada();
        if (ESTADO && ESTADO.sala) {
          ESTADO.sala.codigo = msg.codigo;
          salvarEstado();
        }
        this.salvar();
        this.renderPainel();
        this.renderBadge();
        this.transmitirEstado();
        break;

      case "sala:jogadores": {
        const conexoes = {};
        (msg.jogadores || []).forEach((j) => {
          conexoes[j.id] = !!j.conectado;
        });
        this.conexoes = conexoes;
        this.renderRoster();
        this.renderPlacarSeNecessario();
        this.agendarTransmissao();
        break;
      }

      case "jogador:entrou":
        this.decidirEntrada(msg);
        break;

      case "jogador:saiu":
        this.conexoes[msg.id] = false;
        this.renderRoster();
        this.renderPlacarSeNecessario();
        this.agendarTransmissao();
        break;

      case "lance":
        this.receberLance(msg);
        break;

      case "sala:substituida":
        this.ativa = false;
        elId("sala-status").textContent = "Esta sala foi aberta em outra aba/tela. Recarregue a página para retomar aqui.";
        break;

      case "sala:encerrada":
        break;

      case "erro":
        console.warn("[sala] servidor:", msg.erro);
        break;
    }
  },

  // O host decide quem entra: reconexão de quem já estava, ou novato (só antes de começar).
  decidirEntrada(msg) {
    const { id, nome } = msg;
    const conhecido = this.roster.find((r) => r.id === id);
    const emSetup = !ESTADO;

    if (conhecido) {
      if (emSetup && nome && nome !== conhecido.nome) {
        const nomeEmUso = this.roster.some((r) => r.id !== id && r.nome.toLowerCase() === nome.toLowerCase());
        if (!nomeEmUso) conhecido.nome = nome;
      }
      this.conexoes[id] = true;
      this.salvar();
      this.enviar({ t: "host:aceitar", id, nome: conhecido.nome });
      this.sincronizarJogadores();
      this.mostrarStatus(`${conhecido.nome} voltou para a sala.`);
      this.transmitirEstado();
      return;
    }

    if (!emSetup) {
      this.enviar({ t: "host:recusar", id, motivo: "O leilão já começou — não dá para entrar agora." });
      return;
    }
    if (this.roster.length >= MAX_JOGADORES) {
      this.enviar({ t: "host:recusar", id, motivo: `A sala já tem ${MAX_JOGADORES} jogadores.` });
      return;
    }
    if (this.roster.some((r) => r.nome.toLowerCase() === String(nome).toLowerCase())) {
      this.enviar({ t: "host:recusar", id, motivo: "Já tem alguém com esse nome na sala. Escolha outro." });
      return;
    }

    this.roster.push({ id, nome });
    this.conexoes[id] = true;
    this.salvar();
    this.enviar({ t: "host:aceitar", id, nome });
    this.sincronizarJogadores();
    this.mostrarStatus(`${nome} entrou na sala!`);
    this.transmitirEstado();
  },

  removerJogador(id) {
    const r = this.roster.find((x) => x.id === id);
    if (!r) return;
    if (ESTADO) {
      alert("Não dá para remover jogadores com o leilão em andamento.");
      return;
    }
    this.enviar({ t: "host:remover", id });
    this.roster = this.roster.filter((x) => x.id !== id);
    delete this.conexoes[id];
    this.salvar();
    this.sincronizarJogadores();
    this.mostrarStatus(`${r.nome} foi removido da sala.`);
    this.transmitirEstado();
  },

  receberLance(msg) {
    const jogador = ESTADO ? ESTADO.jogadores.find((j) => j.salaId === msg.id) : null;
    let resultado;
    if (!jogador) {
      resultado = { ok: false, erro: "Você não está nesta partida." };
    } else {
      resultado = darLance(jogador.id, Number(msg.valor), { bloquearLider: true });
    }
    this.enviar({ t: "host:para", id: msg.id, msg: { t: "lance:resultado", ok: resultado.ok, erro: resultado.erro || null, valor: Number(msg.valor), ref: msg.ref } });
  },

  /* ---------- integração com o app.js ---------- */
  // Mantém a escalação do setup igual ao roster da sala.
  sincronizarJogadores() {
    if (!this.ativa) return;
    jogadoresSelecionados = this.roster.map((r) => r.nome);
    if (sorteioAtual && sorteioAtual.config) {
      sorteioAtual.config.nomes = jogadoresSelecionados.slice();
      sorteioAtual.config.numJogadores = jogadoresSelecionados.length;
    }
    atualizarAposMudancaJogadores();
    this.renderRoster();
  },

  // Chamado por iniciarLeilao(): grava no estado da partida o vínculo jogador <-> celular.
  anexarAoEstado(estado) {
    estado.sala = { codigo: this.codigo };
    estado.jogadores.forEach((j) => {
      const r = this.roster.find((x) => x.nome === j.nome);
      j.salaId = r ? r.id : null;
    });
    this.renderBadge();
  },

  jogadorConectado(jogadorIdInterno) {
    const j = ESTADO ? ESTADO.jogadores.find((x) => x.id === jogadorIdInterno) : null;
    return !!(j && j.salaId && this.conexoes[j.salaId]);
  },

  salaIdDe(jogadorIdInterno) {
    const j = jogadorIdInterno && ESTADO ? ESTADO.jogadores.find((x) => x.id === jogadorIdInterno) : null;
    return j ? j.salaId : null;
  },

  aoMudarEstado() {
    this.agendarTransmissao();
  },

  // Várias mudanças na mesma "rodada" do event loop viram uma transmissão só.
  agendarTransmissao() {
    if (this.transmissaoAgendada) return;
    this.transmissaoAgendada = true;
    setTimeout(() => {
      this.transmissaoAgendada = false;
      this.transmitirEstado();
    }, 0);
  },

  transmitirEstado() {
    if (!this.ativa || !this.conectado || !this.codigo) return;
    this.enviar({ t: "host:estado", estado: this.snapshot() });
  },

  snapshot() {
    const base = {
      codigo: this.codigo,
      fase: ESTADO ? ESTADO.fase : "setup",
      enviadoEm: Date.now(),
      jogadores: this.roster.map((r) => ({ id: r.id, nome: r.nome, conectado: !!this.conexoes[r.id] })),
    };
    if (!ESTADO) return base;

    const cfg = ESTADO.config;
    base.config = {
      tamanhoTime: cfg.tamanhoTime,
      regraTime: cfg.regraTime,
      incrementos: cfg.incrementos || INCREMENTOS_PADRAO,
      tempoContador: cfg.tempoContador,
      orcamentoInicial: cfg.orcamentoInicial,
      modoDecisao: cfg.modoDecisao,
    };
    base.jogadores = ESTADO.jogadores.map((j) => ({
      id: j.salaId,
      nome: j.nome,
      carteira: j.carteiraAtual,
      ultimoLance: j.ultimoLance,
      itens: j.itensArrematados.map((i) => ({ nome: i.item, valor: i.valor })),
      timeCheio: timeCheio(j),
      conectado: !!(j.salaId && this.conexoes[j.salaId]),
    }));

    if (ESTADO.fase === "leilao") {
      const lote = ESTADO.loteAtual;
      base.rodada = ESTADO.rodadaAtual + 1;
      base.total = ESTADO.filaItens.length;
      base.pausado = !!ESTADO.pausado;
      base.emRevelacao = emRevelacao;
      base.emMartelo = !!ESTADO.loteFechado;
      base.loteFechado = ESTADO.loteFechado || null;
      base.aguardandoDecisaoFim = !!ESTADO.aguardandoDecisaoFim;
      if (lote) {
        base.item = { nome: lote.item, icon: lote.temaIcon || "🔨", tema: lote.temaLabel || "" };
        base.lanceAtual = lote.lanceAtual;
        base.liderId = this.salaIdDe(lote.jogadorLiderId);
        base.tempoRestanteMs = lote.tempoRestanteMs;
        base.tempoTotalMs = cfg.tempoContador * 1000;
        base.lances = lote.lances.slice(-3).reverse().map((l) => {
          const j = ESTADO.jogadores.find((x) => x.id === l.jogadorId);
          return { nome: j ? j.nome : "?", valor: l.valor };
        });
      }
    }

    if (ESTADO.fase === "resultado" && typeof calcularResultado === "function") {
      const r = calcularResultado();
      base.resultado = {
        modoMetrica: !!r.modoMetrica,
        metricLabel: r.meta ? r.meta.metricLabel : null,
        melhorPontuacao: r.melhorPontuacao,
        ranking: r.ranking.map((x) => ({
          id: x.jogador.salaId,
          nome: x.jogador.nome,
          pontuacao: x.pontuacao,
          gasto: x.gasto,
          completo: x.completo,
          itens: x.jogador.itensArrematados.map((i) => ({ nome: i.item, valor: i.valor, metric: i.metric })),
        })),
      };
    }
    return base;
  },

  /* ---------- pop-up de lance na TV ---------- */
  aoLanceAceito(jogador, valor) {
    const idx = ESTADO ? ESTADO.jogadores.indexOf(jogador) : 0;
    this.filaPop.push({ nome: jogador.nome, valor, cor: CORES_JOGADORES[Math.max(0, idx) % CORES_JOGADORES.length] });
    this.processarFilaPop();
  },

  processarFilaPop() {
    if (this.popAtivo || !this.filaPop.length) return;
    const item = this.filaPop.shift();
    this.popAtivo = true;

    const overlay = elId("lance-overlay");
    const pop = elId("lance-pop");
    elId("lance-pop-nome").textContent = item.nome;
    elId("lance-pop-valor").textContent = fmtMoeda(item.valor);
    pop.style.setProperty("--cor-jogador", item.cor);
    overlay.classList.remove("hidden");
    pop.classList.remove("entrar", "sair");
    void pop.offsetWidth;
    pop.classList.add("entrar");
    this.tocarSomLance();

    const loteCard = elId("lote-card");
    loteCard.classList.remove("flash-lance");
    void loteCard.offsetWidth;
    loteCard.classList.add("flash-lance");

    // com fila cheia, encurta pra não atrasar o leilão
    const duracao = this.filaPop.length ? Math.max(700, POP_DURACAO_MS - 300 * this.filaPop.length) : POP_DURACAO_MS;
    setTimeout(() => {
      pop.classList.remove("entrar");
      pop.classList.add("sair");
      setTimeout(() => {
        overlay.classList.add("hidden");
        pop.classList.remove("sair");
        this.popAtivo = false;
        setTimeout(() => this.processarFilaPop(), POP_INTERVALO_MS);
      }, 220);
    }, duracao);
  },

  tocarSomLance() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const t = ctx.currentTime;
      [[880, 0], [1320, 0.09]].forEach(([freq, offset]) => {
        const osc = ctx.createOscillator();
        const ganho = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, t + offset);
        ganho.gain.setValueAtTime(0.0001, t + offset);
        ganho.gain.exponentialRampToValueAtTime(0.5, t + offset + 0.01);
        ganho.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.28);
        osc.connect(ganho).connect(ctx.destination);
        osc.start(t + offset);
        osc.stop(t + offset + 0.3);
      });
      setTimeout(() => ctx.close(), 800);
    } catch (e) {
      // sem áudio — segue sem som
    }
  },

  /* ---------- render ---------- */
  urlJogador() {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    const base = !local ? location.origin : this.urls[0] || location.origin;
    return `${base}/play`;
  },

  renderPainel() {
    if (!this.ativa) return;
    const semServidor = elId("sala-sem-servidor");
    const criar = elId("sala-criar");
    const conectando = elId("sala-conectando");
    const painel = elId("sala-painel");
    [semServidor, criar, conectando, painel].forEach((el) => el.classList.add("hidden"));

    if (this.servidorIndisponivel) {
      semServidor.classList.remove("hidden");
      return;
    }
    if (!this.conectado) {
      conectando.classList.remove("hidden");
      conectando.textContent = this.tentativasReconexao ? `Conexão com o servidor caiu — tentando de novo… (${this.tentativasReconexao})` : "Conectando ao servidor…";
      if (this.codigo) painel.classList.remove("hidden");
      return;
    }
    if (!this.codigo) {
      criar.classList.remove("hidden");
      return;
    }

    painel.classList.remove("hidden");
    elId("sala-codigo").textContent = this.codigo;
    const url = this.urlJogador();
    elId("sala-url").textContent = url.replace(/^https?:\/\//, "");
    this.renderQr(`${url}?sala=${this.codigo}`);
    this.renderRoster();
  },

  renderQr(texto) {
    const el = elId("sala-qr");
    if (typeof qrcode !== "function") {
      el.innerHTML = "";
      return;
    }
    try {
      const qr = qrcode(0, "M");
      qr.addData(texto);
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch (e) {
      el.innerHTML = "";
    }
  },

  // Se depois de 1 min ninguém entrou, provavelmente é rede: mostra o checklist.
  agendarDicaEntrada() {
    clearTimeout(this.timerDicaEntrada);
    elId("sala-dica-rede").classList.add("hidden");
    this.timerDicaEntrada = setTimeout(() => {
      if (this.ativa && this.codigo && !this.roster.length) elId("sala-dica-rede").classList.remove("hidden");
    }, 60 * 1000);
  },

  renderRoster() {
    if (!this.ativa) return;
    const el = elId("sala-roster");
    const contagem = elId("sala-contagem");
    contagem.textContent = `${this.roster.length}/${MAX_JOGADORES}`;
    if (this.roster.length) {
      clearTimeout(this.timerDicaEntrada);
      elId("sala-dica-rede").classList.add("hidden");
    }
    if (!this.roster.length) {
      el.innerHTML = '<p class="hint">Ninguém entrou ainda. Assim que alguém digitar o código no celular, aparece aqui.</p>';
      return;
    }
    el.innerHTML = "";
    this.roster.forEach((r, i) => {
      const chip = document.createElement("div");
      const online = !!this.conexoes[r.id];
      chip.className = "sala-jogador" + (online ? " online" : " offline");
      chip.style.setProperty("--cor-jogador", CORES_JOGADORES[i % CORES_JOGADORES.length]);
      chip.innerHTML = `<span class="sala-jogador-ponto"></span><span class="sala-jogador-nome">${escapeHtml(r.nome)}</span>`;
      if (!ESTADO) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sala-jogador-remover";
        btn.textContent = "×";
        btn.title = `Remover ${r.nome} da sala`;
        btn.addEventListener("click", () => this.removerJogador(r.id));
        chip.appendChild(btn);
      }
      el.appendChild(chip);
    });
  },

  renderBadge() {
    const badge = elId("sala-badge");
    if (ESTADO && ESTADO.sala && ESTADO.sala.codigo) {
      badge.textContent = `📱 Sala ${ESTADO.sala.codigo}`;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  },

  renderPlacarSeNecessario() {
    if (ESTADO && ESTADO.fase === "leilao" && ESTADO.loteAtual && !ESTADO.aguardandoDecisaoFim) renderJogadoresLeilao();
  },

  mostrarStatus(texto) {
    const el = elId("sala-status");
    el.textContent = texto;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      if (el.textContent === texto) el.textContent = "";
    }, 4000);
  },
};

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  SALA.carregar();

  document.querySelectorAll('input[name="modo-jogo"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked && radio.value === "sala") SALA.ativar();
      else if (radio.checked) SALA.desativar();
    });
  });
  elId("btn-criar-sala").addEventListener("click", () => SALA.criarSala());
  elId("btn-encerrar-sala").addEventListener("click", () => SALA.encerrarSala());
  elId("btn-sala-tentar").addEventListener("click", () => SALA.conectar());

  // partida em andamento no modo sala, ou sala salva: retoma automaticamente
  const partidaEmSala = ESTADO && ESTADO.sala && ESTADO.sala.codigo;
  if (partidaEmSala && !SALA.codigo) SALA.codigo = ESTADO.sala.codigo;
  if (partidaEmSala || SALA.codigo) {
    const radio = document.querySelector('input[name="modo-jogo"][value="sala"]');
    if (radio) radio.checked = true;
    SALA.ativar();
    SALA.renderBadge();
  }
});
