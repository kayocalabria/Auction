"use strict";

/* =========================================================
   Constantes / armazenamento
   ========================================================= */
const CHAVE_BANCO = "leilaoBancoTemas";
const CHAVE_BANCO_VERSAO = "leilaoBancoVersao";
const CHAVE_ESTADO = "leilaoEstadoJogo";
const CHAVE_JOGADORES = "leilaoJogadoresSalvos";
const CHAVE_HISTORICO = "leilaoHistoricoVencedores";
const TICK_MS = 100;
const DURACAO_MARTELO_MS = 2500;
const MARTELO_BATIDAS_S = [0.22, 0.7, 1.18]; // sincronizado com os keyframes de marteloBater
const MAX_JOGADORES = 6;

let BANCO = null; // { [temaKey]: { label, icon, metricLabel, metricMax, itens: [{nome, metric}] } }
let JOGADORES_SALVOS = []; // nomes persistidos entre partidas
let jogadoresSelecionados = []; // nomes escalados para a próxima partida, em ordem
let ESTADO = null; // estado da partida em andamento (ou null)
let sorteioAtual = null; // { config, itens } — prévia antes de "Iniciar Leilão"
let timerInterval = null;
let qtdItensEditadoManualmente = false;
let emRevelacao = false; // true enquanto a animação de revelação do item está rodando
let emMartelo = false; // true enquanto o martelo bate (lote fechado, aguardando próxima rodada)
let modoDecisaoManualEscolhido = false; // true só se o usuário clicou em "Manual" por vontade própria
const INCREMENTOS_PADRAO = [1, 2, 5];

/* =========================================================
   Utilidades
   ========================================================= */
function slugify(str) {
  return str
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "tema";
}

function chaveUnica(base, existentes) {
  let chave = base;
  let i = 2;
  while (existentes.includes(chave)) {
    chave = `${base}-${i}`;
    i += 1;
  }
  return chave;
}

function fmtMoeda(v) {
  const n = Number(v) || 0;
  return "R$ " + (Number.isInteger(n) ? n : n.toFixed(2));
}

function fmtMetric(metric, metricMax) {
  if (metric === null || metric === undefined) return "—";
  return metricMax === 10 ? metric.toFixed(1) : String(Math.round(metric));
}

function plural(n, singular, pluralForm) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function embaralhar(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function elId(id) {
  return document.getElementById(id);
}

/* =========================================================
   Banco de temas (persistente, separado do save da partida)
   ========================================================= */
function temaSemente(key) {
  const meta = TEMAS_META[key];
  return {
    label: meta.label,
    icon: meta.icon,
    metricLabel: meta.metricLabel,
    metricMax: meta.metricMax,
    itens: DADOS_PADRAO[key].map((i) => ({ nome: i.nome, metric: i.metric })),
  };
}

// O banco só é semeado do data.js uma vez; depois vive no localStorage (pra guardar
// itens que o jogador adicionou). Quando o data.js muda (DADOS_VERSAO sobe), mesclamos
// temas e itens novos no banco salvo em vez de recriá-lo, preservando os itens do jogador.
function migrarBanco(banco) {
  for (const key of Object.keys(DADOS_PADRAO)) {
    if (!banco[key]) {
      banco[key] = temaSemente(key);
      continue;
    }
    const meta = TEMAS_META[key];
    banco[key].label = meta.label;
    banco[key].icon = meta.icon;
    banco[key].metricLabel = meta.metricLabel;
    banco[key].metricMax = meta.metricMax;
    const porNome = new Map(banco[key].itens.map((i) => [i.nome.toLowerCase(), i]));
    for (const item of DADOS_PADRAO[key]) {
      const existente = porNome.get(item.nome.toLowerCase());
      if (existente) {
        existente.metric = item.metric;
      } else {
        banco[key].itens.push({ nome: item.nome, metric: item.metric });
      }
    }
  }
  return banco;
}

function carregarBanco() {
  let banco = null;
  try {
    const raw = localStorage.getItem(CHAVE_BANCO);
    if (raw) banco = JSON.parse(raw);
  } catch (e) {
    console.warn("Falha ao ler banco de temas, recriando semente.", e);
  }

  if (!banco) {
    banco = {};
    for (const key of Object.keys(DADOS_PADRAO)) banco[key] = temaSemente(key);
    salvarBanco(banco);
    return banco;
  }

  const versaoSalva = Number(localStorage.getItem(CHAVE_BANCO_VERSAO)) || 0;
  if (versaoSalva !== DADOS_VERSAO) {
    banco = migrarBanco(banco);
    salvarBanco(banco);
  }
  return banco;
}

function salvarBanco(banco) {
  localStorage.setItem(CHAVE_BANCO, JSON.stringify(banco));
  localStorage.setItem(CHAVE_BANCO_VERSAO, String(DADOS_VERSAO));
}

function ordemTemas() {
  const padrao = ["jogos", "atletas", "series", "filmes"];
  const chaves = Object.keys(BANCO);
  const extras = chaves.filter((k) => !padrao.includes(k)).sort();
  return padrao.filter((k) => chaves.includes(k)).concat(extras);
}

/* =========================================================
   Jogadores salvos (persistente)
   ========================================================= */
function carregarJogadoresSalvos() {
  try {
    const raw = localStorage.getItem(CHAVE_JOGADORES);
    const lista = raw ? JSON.parse(raw) : [];
    return Array.isArray(lista) ? lista.filter((n) => typeof n === "string" && n.trim()) : [];
  } catch (e) {
    console.warn("Falha ao ler jogadores salvos.", e);
    return [];
  }
}

function salvarJogadoresSalvos() {
  localStorage.setItem(CHAVE_JOGADORES, JSON.stringify(JOGADORES_SALVOS));
}

function setFeedbackJogadores(msg) {
  elId("jogadores-feedback").textContent = msg;
}

function renderJogadoresSalvos() {
  const container = elId("lista-jogadores-salvos");
  container.innerHTML = "";
  if (!JOGADORES_SALVOS.length) {
    const vazio = document.createElement("p");
    vazio.className = "hint";
    vazio.textContent = "Nenhum jogador salvo ainda. Adicione os nomes abaixo.";
    container.appendChild(vazio);
    return;
  }
  JOGADORES_SALVOS.forEach((nome) => {
    const idx = jogadoresSelecionados.indexOf(nome);
    const chip = document.createElement("div");
    chip.className = "jogador-chip" + (idx >= 0 ? " selecionado" : "");

    const btnNome = document.createElement("button");
    btnNome.type = "button";
    btnNome.className = "jogador-chip-nome";
    const ordem = document.createElement("span");
    ordem.className = "ordem";
    ordem.textContent = idx >= 0 ? String(idx + 1) : "";
    btnNome.appendChild(ordem);
    btnNome.appendChild(document.createTextNode(nome));
    btnNome.title = idx >= 0 ? "Tirar da partida" : "Escalar para a partida";
    btnNome.addEventListener("click", () => alternarJogador(nome));

    const btnRemover = document.createElement("button");
    btnRemover.type = "button";
    btnRemover.className = "jogador-chip-remover";
    btnRemover.textContent = "×";
    btnRemover.title = `Remover ${nome} dos jogadores salvos`;
    btnRemover.addEventListener("click", () => removerJogadorSalvo(nome));

    chip.appendChild(btnNome);
    chip.appendChild(btnRemover);
    container.appendChild(chip);
  });
}

function atualizarAposMudancaJogadores() {
  renderJogadoresSalvos();
  atualizarSugestaoQtdItens();
  renderResumoConfig();
}

function alternarJogador(nome) {
  const idx = jogadoresSelecionados.indexOf(nome);
  if (idx >= 0) {
    jogadoresSelecionados.splice(idx, 1);
  } else {
    if (jogadoresSelecionados.length >= MAX_JOGADORES) {
      setFeedbackJogadores(`Máximo de ${MAX_JOGADORES} jogadores por partida.`);
      return;
    }
    jogadoresSelecionados.push(nome);
  }
  setFeedbackJogadores("");
  atualizarAposMudancaJogadores();
}

function adicionarJogadorSalvo(ev) {
  ev.preventDefault();
  const input = elId("input-novo-jogador");
  const nome = input.value.trim();
  if (!nome) return;

  const existente = JOGADORES_SALVOS.find((n) => n.toLowerCase() === nome.toLowerCase());
  if (existente) {
    if (!jogadoresSelecionados.includes(existente) && jogadoresSelecionados.length < MAX_JOGADORES) {
      jogadoresSelecionados.push(existente);
    }
    setFeedbackJogadores(`"${existente}" já estava salvo — escalado para a partida.`);
  } else {
    JOGADORES_SALVOS.push(nome);
    salvarJogadoresSalvos();
    if (jogadoresSelecionados.length < MAX_JOGADORES) jogadoresSelecionados.push(nome);
    setFeedbackJogadores(`"${nome}" salvo e escalado.`);
  }
  input.value = "";
  atualizarAposMudancaJogadores();
}

function removerJogadorSalvo(nome) {
  JOGADORES_SALVOS = JOGADORES_SALVOS.filter((n) => n !== nome);
  jogadoresSelecionados = jogadoresSelecionados.filter((n) => n !== nome);
  salvarJogadoresSalvos();
  setFeedbackJogadores(`"${nome}" removido dos jogadores salvos.`);
  atualizarAposMudancaJogadores();
}

/* =========================================================
   Save/load da partida
   ========================================================= */
function carregarEstado() {
  try {
    const raw = localStorage.getItem(CHAVE_ESTADO);
    const estado = raw ? JSON.parse(raw) : null;
    return estado && estado.config && estado.config.tamanhoTime ? estado : null;
  } catch (e) {
    console.warn("Falha ao ler estado da partida.", e);
    return null;
  }
}

function salvarEstado() {
  if (ESTADO) localStorage.setItem(CHAVE_ESTADO, JSON.stringify(ESTADO));
  aoMudarEstado();
}

// Gancho do modo sala (sala.js): toda mudança relevante de estado é transmitida
// aos celulares. No modo local não faz nada.
function aoMudarEstado() {
  if (typeof SALA !== "undefined" && SALA.ativa) SALA.aoMudarEstado();
}

function modoSalaAtivo() {
  return typeof SALA !== "undefined" && SALA.ativa;
}

function limparEstado() {
  localStorage.removeItem(CHAVE_ESTADO);
  ESTADO = null;
}

/* =========================================================
   Tela de Setup — temas / regras / resumo
   ========================================================= */
function temasSelecionadosAtuais() {
  return Array.from(document.querySelectorAll(".tema-chip input:checked")).map((i) => i.value);
}

function renderTemas() {
  const container = elId("lista-temas");
  const selecionadosAntes = new Set(temasSelecionadosAtuais());
  container.innerHTML = "";
  const chaves = ordemTemas();
  chaves.forEach((key, idx) => {
    const tema = BANCO[key];
    const chip = document.createElement("label");
    chip.className = "tema-chip";
    const marcado = selecionadosAntes.size ? selecionadosAntes.has(key) : idx === 0;
    chip.innerHTML = `<input type="checkbox" value="${key}" ${marcado ? "checked" : ""}> ${tema.icon} ${escapeHtml(tema.label)} <small>(${tema.itens.length})</small>`;
    chip.querySelector("input").addEventListener("change", atualizarModoDecisaoDisponibilidade);
    container.appendChild(chip);
  });
  atualizarModoDecisaoDisponibilidade();
}

function temaTemMetricaCompleta(tema) {
  return tema.itens.length > 0 && tema.itens.every((i) => typeof i.metric === "number" && !Number.isNaN(i.metric));
}

function atualizarModoDecisaoDisponibilidade() {
  const selecionados = temasSelecionadosAtuais();
  const radioMetrica = document.querySelector('input[name="modo-decisao"][value="metrica"]');
  const radioManual = document.querySelector('input[name="modo-decisao"][value="manual"]');
  const info = elId("modo-decisao-info");

  if (selecionados.length === 1 && BANCO[selecionados[0]] && temaTemMetricaCompleta(BANCO[selecionados[0]])) {
    const tema = BANCO[selecionados[0]];
    radioMetrica.disabled = false;
    // automático é o padrão: só fica em manual se o usuário escolheu manual de propósito
    if (!modoDecisaoManualEscolhido && !radioMetrica.checked) {
      radioMetrica.checked = true;
      radioManual.checked = false;
    }
    info.textContent = `Métrica disponível: ${tema.metricLabel} (0–${tema.metricMax}). Fica escondida durante os lances e só é revelada no resultado.`;
  } else {
    radioMetrica.disabled = true;
    if (radioMetrica.checked) {
      radioMetrica.checked = false;
      radioManual.checked = true;
    }
    info.textContent =
      selecionados.length > 1
        ? "Modo automático só é possível com um único tema selecionado (temas diferentes usam métricas diferentes)."
        : "Modo automático fica disponível quando o tema escolhido tem métrica cadastrada em todos os itens.";
  }
}

function tamanhoTimeAtual() {
  return Math.max(1, parseInt(elId("input-tamanho-time").value, 10) || 4);
}

function regraTimeAtual() {
  return document.querySelector('input[name="regra-time"]:checked').value;
}

function atualizarInfoRegraTime() {
  const t = tamanhoTimeAtual();
  elId("regra-time-info").textContent =
    regraTimeAtual() === "max"
      ? `Ninguém arremata mais que ${plural(t, "item", "itens")} — quem completar o time para de dar lances.`
      : `Meta: cada jogador precisa arrematar ao menos ${plural(t, "item", "itens")} para o time contar como completo.`;
}

function atualizarSugestaoQtdItens() {
  const n = Math.max(2, jogadoresSelecionados.length);
  const t = tamanhoTimeAtual();
  const sugestao = t * n + 5;
  elId("sugestao-qtd-itens").textContent = `Sugestão: ${sugestao} itens (${t} por jogador + folga para passar). Edite se quiser.`;
  if (!qtdItensEditadoManualmente) {
    elId("input-qtd-itens").value = sugestao;
  }
}

function renderResumoConfig() {
  const temas = temasSelecionadosAtuais();
  const qtd = parseInt(elId("input-qtd-itens").value, 10) || 0;
  const orcamento = parseFloat(elId("input-orcamento").value) || 0;
  const t = tamanhoTimeAtual();
  const modo = document.querySelector('input[name="modo-decisao"]:checked').value;

  const linhas = [
    ["Jogadores", jogadoresSelecionados.length ? jogadoresSelecionados.join(", ") : "nenhum escalado"],
    ["Temas", temas.length ? temas.map((k) => `${BANCO[k].icon} ${BANCO[k].label}`).join(", ") : "nenhum"],
    ["Itens no leilão", String(qtd)],
    ["Orçamento", `${fmtMoeda(orcamento)} por jogador`],
    ["Time", `${regraTimeAtual() === "max" ? "máx." : "mín."} ${plural(t, "item", "itens")}`],
    ["Decisão", modo === "metrica" ? "automática (métrica)" : "manual"],
  ];
  elId("resumo-config").innerHTML = linhas
    .map(([k, v]) => `<li><span>${k}</span><strong>${escapeHtml(v)}</strong></li>`)
    .join("");
}

function mostrarErroSetup(msg) {
  elId("setup-erro").textContent = msg;
}

/* =========================================================
   Banco de itens — contagem, adicionar, remover
   ========================================================= */
function renderContagemTemas() {
  const container = elId("lista-contagem-temas");
  container.innerHTML = "";
  ordemTemas().forEach((key) => {
    const tema = BANCO[key];
    const wrapper = document.createElement("div");
    wrapper.className = "contagem-item";
    const detalhes = document.createElement("details");
    const resumo = document.createElement("summary");
    resumo.textContent = `${tema.icon} ${tema.label} — ${tema.itens.length} itens`;
    detalhes.appendChild(resumo);

    const filtro = document.createElement("input");
    filtro.type = "search";
    filtro.className = "filtro-itens";
    filtro.placeholder = "Filtrar nesse tema…";
    detalhes.appendChild(filtro);

    const linhas = [];
    tema.itens.forEach((item, idx) => {
      const linha = document.createElement("div");
      linha.className = "item-linha";

      const inputNome = document.createElement("input");
      inputNome.type = "text";
      inputNome.value = item.nome;
      inputNome.title = "Nome do item";

      const inputMetric = document.createElement("input");
      inputMetric.type = "number";
      inputMetric.step = "0.1";
      inputMetric.placeholder = "nota";
      inputMetric.value = typeof item.metric === "number" ? item.metric : "";
      inputMetric.title = tema.metricLabel;

      const salvar = () => {
        const nome = inputNome.value.trim();
        if (!nome) {
          inputNome.value = item.nome;
          return;
        }
        const n = parseFloat(inputMetric.value.replace(",", "."));
        item.nome = nome;
        item.metric = Number.isFinite(n) ? n : null;
        salvarBanco(BANCO);
        resumo.textContent = `${tema.icon} ${tema.label} — ${tema.itens.length} itens`;
      };
      inputNome.addEventListener("change", salvar);
      inputMetric.addEventListener("change", salvar);

      const btnRemover = document.createElement("button");
      btnRemover.type = "button";
      btnRemover.textContent = "×";
      btnRemover.title = "Remover item";
      btnRemover.addEventListener("click", () => removerItemBanco(key, idx));

      linha.append(inputNome, inputMetric, btnRemover);
      detalhes.appendChild(linha);
      linhas.push({ el: linha, nomeLower: item.nome.toLowerCase() });
    });

    filtro.addEventListener("input", () => {
      const termo = filtro.value.trim().toLowerCase();
      linhas.forEach(({ el, nomeLower }) => {
        el.classList.toggle("oculto-filtro", termo.length > 0 && !nomeLower.includes(termo));
      });
    });

    wrapper.appendChild(detalhes);
    container.appendChild(wrapper);
  });
}

function removerItemBanco(temaKey, idx) {
  BANCO[temaKey].itens.splice(idx, 1);
  salvarBanco(BANCO);
  renderContagemTemas();
  renderTemas();
  renderSelectTemaAdd();
}

function renderSelectTemaAdd() {
  const select = elId("select-tema-add");
  const atual = select.value;
  select.innerHTML = "";
  ordemTemas().forEach((key) => {
    const tema = BANCO[key];
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `${tema.icon} ${tema.label}`;
    select.appendChild(opt);
  });
  if (ordemTemas().includes(atual)) select.value = atual;
}

function parseItensTexto(texto) {
  return texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((linha) => {
      const partes = linha.split(";");
      const nome = partes[0].trim();
      let metric = null;
      if (partes.length > 1 && partes[1].trim() !== "") {
        const n = parseFloat(partes[1].trim().replace(",", "."));
        metric = Number.isFinite(n) ? n : null;
      }
      return { nome, metric };
    })
    .filter((i) => i.nome.length > 0);
}

function adicionarItensAoBanco(temaKey, novosItens) {
  const tema = BANCO[temaKey];
  const existentesLower = new Set(tema.itens.map((i) => i.nome.toLowerCase()));
  let adicionados = 0;
  let ignorados = 0;
  novosItens.forEach((item) => {
    if (existentesLower.has(item.nome.toLowerCase())) {
      ignorados += 1;
      return;
    }
    tema.itens.push(item);
    existentesLower.add(item.nome.toLowerCase());
    adicionados += 1;
  });
  salvarBanco(BANCO);
  return { adicionados, ignorados };
}

function lidarComSubmitAddItens(ev) {
  ev.preventDefault();
  const feedback = elId("add-itens-feedback");
  const criandoNovo = elId("check-novo-tema").checked;
  let temaKey;

  if (criandoNovo) {
    const nomeNovo = elId("input-novo-tema-nome").value.trim();
    if (!nomeNovo) {
      feedback.textContent = "Digite um nome para o novo tema.";
      return;
    }
    const base = slugify(nomeNovo);
    temaKey = Object.keys(BANCO).find((k) => BANCO[k].label.toLowerCase() === nomeNovo.toLowerCase());
    if (!temaKey) {
      temaKey = chaveUnica(base, Object.keys(BANCO));
      BANCO[temaKey] = { label: nomeNovo, icon: "⭐", metricLabel: "Nota (opcional)", metricMax: null, itens: [] };
    }
  } else {
    temaKey = elId("select-tema-add").value;
  }

  const processarTexto = (texto) => {
    const itens = parseItensTexto(texto);
    if (itens.length === 0) {
      feedback.textContent = "Nenhum item válido encontrado.";
      return;
    }
    const { adicionados, ignorados } = adicionarItensAoBanco(temaKey, itens);
    feedback.textContent = `${adicionados} item(ns) adicionado(s) a "${BANCO[temaKey].label}"` + (ignorados ? `, ${ignorados} ignorado(s) por já existir.` : ".");
    renderContagemTemas();
    renderTemas();
    renderSelectTemaAdd();
    elId("textarea-itens").value = "";
    elId("input-file-itens").value = "";
    elId("check-novo-tema").checked = false;
    elId("input-novo-tema-nome").value = "";
    elId("input-novo-tema-nome").hidden = true;
    elId("select-tema-add").hidden = false;
  };

  const arquivo = elId("input-file-itens").files[0];
  if (arquivo) {
    const reader = new FileReader();
    reader.onload = () => processarTexto(String(reader.result || ""));
    reader.onerror = () => {
      feedback.textContent = "Não foi possível ler o arquivo .txt.";
    };
    reader.readAsText(arquivo);
  } else {
    processarTexto(elId("textarea-itens").value);
  }
}

/* =========================================================
   Sorteio dos itens do leilão
   ========================================================= */
function lerConfigDoForm() {
  const nomes = jogadoresSelecionados.slice();
  const orcamentoInicial = Math.max(1, parseFloat(elId("input-orcamento").value) || 100);
  const tamanhoTime = tamanhoTimeAtual();
  const regraTime = regraTimeAtual();
  const qtdItens = Math.max(1, parseInt(elId("input-qtd-itens").value, 10) || 1);
  const tempoContador = Math.max(3, Math.min(30, parseInt(elId("input-tempo-contador").value, 10) || 20));
  const modoDecisao = document.querySelector('input[name="modo-decisao"]:checked').value;
  const temasSelecionados = temasSelecionadosAtuais();
  const incrementos = lerIncrementosDoForm();
  return { numJogadores: nomes.length, nomes, orcamentoInicial, tamanhoTime, regraTime, qtdItens, tempoContador, modoDecisao, temasSelecionados, incrementos };
}

// "1, 2, 5" -> [1, 2, 5]. Inteiros positivos, sem repetição, no máximo 4, em ordem crescente.
function parseIncrementos(texto) {
  const lista = String(texto || "")
    .split(/[,;\s]+/)
    .map((x) => parseInt(x, 10))
    .filter((x) => Number.isInteger(x) && x > 0);
  const unicos = Array.from(new Set(lista)).sort((a, b) => a - b).slice(0, 4);
  return unicos.length ? unicos : INCREMENTOS_PADRAO.slice();
}

function lerIncrementosDoForm() {
  const input = elId("input-incrementos");
  return parseIncrementos(input ? input.value : "");
}

function incrementosDaPartida() {
  return (ESTADO && ESTADO.config && ESTADO.config.incrementos) || INCREMENTOS_PADRAO;
}

function itemDoBanco(temaKey, item) {
  return { nome: item.nome, metric: item.metric, tema: temaKey, temaLabel: BANCO[temaKey].label, temaIcon: BANCO[temaKey].icon };
}

function sortearItens() {
  const config = lerConfigDoForm();

  if (config.nomes.length < 2) {
    mostrarErroSetup("Escale pelo menos 2 jogadores para começar.");
    return;
  }
  if (config.temasSelecionados.length === 0) {
    mostrarErroSetup("Selecione ao menos um tema para o leilão.");
    return;
  }

  let pool = [];
  config.temasSelecionados.forEach((key) => {
    BANCO[key].itens.forEach((item) => pool.push(itemDoBanco(key, item)));
  });

  if (pool.length === 0) {
    mostrarErroSetup("Os temas escolhidos não têm itens cadastrados.");
    return;
  }
  mostrarErroSetup("");

  const qtd = Math.min(config.qtdItens, pool.length);
  const itensSorteados = embaralhar(pool).slice(0, qtd);

  let metaTemaSelecionada = null;
  if (config.modoDecisao === "metrica" && config.temasSelecionados.length === 1) {
    const tema = BANCO[config.temasSelecionados[0]];
    metaTemaSelecionada = { label: tema.label, metricLabel: tema.metricLabel, metricMax: tema.metricMax };
  } else if (config.modoDecisao === "metrica") {
    config.modoDecisao = "manual";
  }
  config.metaTemaSelecionada = metaTemaSelecionada;
  config.qtdItens = qtd;

  sorteioAtual = { config, itens: itensSorteados };
  renderPreviaSorteio();
}

function renderPreviaSorteio() {
  const preview = elId("preview-sorteio");
  preview.classList.remove("hidden");
  const qtd = sorteioAtual.itens.length;
  elId("resumo-sorteio").textContent =
    `${plural(qtd, "item sorteado", "itens sorteados")} e embaralhados — prontos para o leilão! ` +
    "Cada um só será revelado na hora, um de cada vez, para manter a surpresa.";
  renderItensSorteados();
  preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderItensSorteados() {
  const container = elId("lista-itens-sorteados");
  container.innerHTML = "";
  sorteioAtual.itens.forEach((item, idx) => {
    const tema = BANCO[item.tema];
    const linha = document.createElement("div");
    linha.className = "item-sorteado";

    const icone = document.createElement("span");
    icone.className = "item-sorteado-icone";
    icone.textContent = item.temaIcon;
    icone.title = item.temaLabel;

    const inputNome = document.createElement("input");
    inputNome.type = "text";
    inputNome.value = item.nome;
    inputNome.title = "Nome do item";

    const inputMetric = document.createElement("input");
    inputMetric.type = "number";
    inputMetric.step = "0.1";
    inputMetric.placeholder = "nota";
    inputMetric.value = typeof item.metric === "number" ? item.metric : "";
    inputMetric.title = tema ? tema.metricLabel : "Nota";

    const salvar = () => {
      const nome = inputNome.value.trim() || item.nome;
      const n = parseFloat(inputMetric.value.replace(",", "."));
      const metric = Number.isFinite(n) ? n : null;
      aplicarEdicaoItemSorteado(item, nome, metric);
      inputNome.value = item.nome;
    };
    inputNome.addEventListener("change", salvar);
    inputMetric.addEventListener("change", salvar);

    const btnTrocar = document.createElement("button");
    btnTrocar.type = "button";
    btnTrocar.className = "btn btn-ghost btn-icone";
    btnTrocar.textContent = "↻";
    btnTrocar.title = "Trocar por outro item do tema";
    btnTrocar.addEventListener("click", () => trocarItemSorteado(idx));

    linha.append(icone, inputNome, inputMetric, btnTrocar);
    container.appendChild(linha);
  });
}

function aplicarEdicaoItemSorteado(item, novoNome, novaMetric) {
  const tema = BANCO[item.tema];
  const noBanco = tema ? tema.itens.find((i) => i.nome === item.nome) : null;
  item.nome = novoNome;
  item.metric = novaMetric;
  if (noBanco) {
    noBanco.nome = novoNome;
    noBanco.metric = novaMetric;
    salvarBanco(BANCO);
    renderContagemTemas();
  }
}

function trocarItemSorteado(idx) {
  const usados = new Set(sorteioAtual.itens.map((i) => `${i.tema}::${i.nome}`));
  const candidatos = [];
  sorteioAtual.config.temasSelecionados.forEach((key) => {
    BANCO[key].itens.forEach((item) => {
      if (!usados.has(`${key}::${item.nome}`)) candidatos.push(itemDoBanco(key, item));
    });
  });
  if (!candidatos.length) {
    elId("resumo-sorteio").textContent = "Não há mais itens disponíveis nos temas escolhidos para trocar.";
    return;
  }
  sorteioAtual.itens[idx] = candidatos[Math.floor(Math.random() * candidatos.length)];
  renderItensSorteados();
}

function iniciarLeilao() {
  if (!sorteioAtual) return;
  elId("encerramento-antecipado").classList.add("hidden");
  elId("lote-card").classList.remove("hidden");
  elId("lista-jogadores-leilao").classList.remove("hidden");
  const { config, itens } = sorteioAtual;
  ESTADO = {
    config,
    jogadores: config.nomes.map((nome, i) => ({
      id: `p${i}`,
      nome,
      orcamentoInicial: config.orcamentoInicial,
      carteiraAtual: config.orcamentoInicial,
      ultimoLance: 0,
      itensArrematados: [],
      historico: [],
    })),
    filaItens: itens,
    rodadaAtual: 0,
    loteAtual: null,
    pausado: false,
    aguardandoDecisaoFim: false,
    fase: "leilao",
  };
  if (modoSalaAtivo()) SALA.anexarAoEstado(ESTADO);
  ESTADO.loteAtual = criarLote(ESTADO.filaItens[0]);
  salvarEstado();
  aplicarFase("leilao");
  renderLeilao();
  iniciarRevelacao(ESTADO.filaItens[0], () => iniciarTimerLote());
}

/* =========================================================
   Leilão — lotes, lances, timer
   ========================================================= */
function criarLote(item) {
  return {
    item: item.nome,
    metric: item.metric,
    tema: item.tema,
    temaIcon: item.temaIcon,
    temaLabel: item.temaLabel,
    lanceAtual: 0,
    jogadorLiderId: null,
    lances: [],
    tempoRestanteMs: ESTADO.config.tempoContador * 1000,
  };
}

function pararTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function iniciarTimerLote() {
  pararTimer();
  timerInterval = setInterval(() => {
    if (!ESTADO || !ESTADO.loteAtual) return;
    ESTADO.loteAtual.tempoRestanteMs -= TICK_MS;
    if (ESTADO.loteAtual.tempoRestanteMs <= 0) {
      ESTADO.loteAtual.tempoRestanteMs = 0;
      pararTimer();
      renderContador();
      encerrarLote();
      return;
    }
    renderContador();
  }, TICK_MS);
}

/* =========================================================
   Revelação do item (um de cada vez, com efeito surpresa)
   ========================================================= */
function iniciarRevelacao(item, aoTerminar) {
  emRevelacao = true;
  atualizarControlesLeilao();
  aoMudarEstado();

  const overlay = elId("reveal-overlay");
  const nomeEl = elId("reveal-item-nome");
  const iconEl = elId("reveal-icon");
  const subEl = elId("reveal-sub");
  const loteCard = elId("lote-card");
  const lateral = elId("lista-jogadores-leilao");

  loteCard.classList.add("oculto-revelacao");
  lateral.classList.add("oculto-revelacao");

  iconEl.textContent = item.temaIcon || "🔨";
  nomeEl.textContent = item.nome;
  nomeEl.className = "reveal-item-nome";
  subEl.textContent = `Rodada ${ESTADO.rodadaAtual + 1} de ${ESTADO.filaItens.length}`;
  subEl.classList.remove("mostrar");

  overlay.classList.remove("hidden");
  void overlay.offsetWidth; // força reflow para reiniciar as animações
  overlay.classList.add("show");
  nomeEl.classList.add("entrar");

  setTimeout(() => subEl.classList.add("mostrar"), 300);

  // depois de aparecer grande e segurar um instante, encolhe e "funde" ao fundo
  setTimeout(() => nomeEl.classList.add("sair"), 1300);

  // revela a interface real por trás, em crossfade com o encolhimento
  setTimeout(() => {
    loteCard.classList.remove("oculto-revelacao");
    lateral.classList.remove("oculto-revelacao");
  }, 1800);

  setTimeout(() => overlay.classList.remove("show"), 1900);

  setTimeout(() => {
    overlay.classList.add("hidden");
    emRevelacao = false;
    atualizarControlesLeilao();
    aoMudarEstado();
    if (aoTerminar) aoTerminar();
  }, 2150);
}

/* =========================================================
   Pausa do leilão
   ========================================================= */
function pausarLeilao() {
  if (!ESTADO || !ESTADO.loteAtual || ESTADO.pausado || emRevelacao) return;
  ESTADO.pausado = true;
  pararTimer();
  salvarEstado();
  renderLeilao();
}

function retomarLeilao() {
  if (!ESTADO || !ESTADO.loteAtual || !ESTADO.pausado) return;
  ESTADO.pausado = false;
  salvarEstado();
  renderLeilao();
  iniciarTimerLote();
}

function alternarPausa() {
  if (!ESTADO) return;
  if (ESTADO.pausado) retomarLeilao();
  else pausarLeilao();
}

function atualizarControlesLeilao() {
  const btnPausar = elId("btn-pausar");
  if (!btnPausar || !ESTADO) return;
  const btnFechar = elId("btn-fechar-lance");
  const btnPular = elId("btn-pular-item");
  const btnDesfazer = elId("btn-desfazer-lance");
  const banner = elId("pausado-banner");

  btnPausar.disabled = emRevelacao;
  if (ESTADO.pausado) {
    btnPausar.textContent = "▶ Retomar";
    btnPausar.classList.remove("btn-ghost");
    btnPausar.classList.add("btn-gold");
    banner.classList.remove("hidden");
  } else {
    btnPausar.textContent = "⏸ Pausar";
    btnPausar.classList.remove("btn-gold");
    btnPausar.classList.add("btn-ghost");
    banner.classList.add("hidden");
  }
  btnFechar.disabled = emRevelacao || ESTADO.pausado;
  btnPular.disabled = emRevelacao || ESTADO.pausado;
  btnDesfazer.disabled = emRevelacao || !ESTADO.loteAtual || ESTADO.loteAtual.lances.length === 0;
}

function timeCheio(jogador) {
  return ESTADO.config.regraTime === "max" && jogador.itensArrematados.length >= ESTADO.config.tamanhoTime;
}

// Retorna null se o lance é válido, ou a mensagem de erro. Usada pelo modo local
// (cards laterais) e pelo modo sala (lances vindos do celular).
function validarLance(jogador, valor, opcoes = {}) {
  if (!ESTADO || !ESTADO.loteAtual) return "Nenhum item em leilão agora.";
  if (emRevelacao) return "Aguarde a revelação do item.";
  if (emMartelo) return "O lance já foi fechado.";
  if (ESTADO.pausado) return "O leilão está pausado.";
  const lote = ESTADO.loteAtual;
  if (timeCheio(jogador)) return `Time completo — máximo de ${plural(ESTADO.config.tamanhoTime, "item", "itens")}.`;
  if (opcoes.bloquearLider && lote.jogadorLiderId === jogador.id) return "Você já está na frente.";
  if (!Number.isFinite(valor) || valor <= lote.lanceAtual) return `O lance precisa ser maior que ${fmtMoeda(lote.lanceAtual)}.`;
  if (valor > jogador.carteiraAtual) return "Lance maior que sua carteira disponível.";
  return null;
}

// Retorna { ok, erro } para quem chamou poder dar feedback (o celular, no modo sala).
function darLance(jogadorId, valor, opcoes = {}) {
  const jogador = ESTADO ? ESTADO.jogadores.find((j) => j.id === jogadorId) : null;
  if (!jogador) return { ok: false, erro: "Jogador não encontrado." };
  const erroEl = document.querySelector(`.jogador-card[data-id="${jogadorId}"] .erro-lance`);
  const erro = validarLance(jogador, valor, opcoes);
  if (erro) {
    if (erroEl) erroEl.textContent = erro;
    return { ok: false, erro };
  }
  const lote = ESTADO.loteAtual;

  lote.lances.push({
    jogadorId,
    valor,
    lanceAnterior: lote.lanceAtual,
    liderAnteriorId: lote.jogadorLiderId,
    ultimoLanceAnterior: jogador.ultimoLance,
  });
  lote.lanceAtual = valor;
  lote.jogadorLiderId = jogadorId;
  lote.tempoRestanteMs = ESTADO.config.tempoContador * 1000;
  jogador.ultimoLance = valor;
  jogador.historico.push({ tipo: "lance", item: lote.item, valor, rodada: ESTADO.rodadaAtual + 1, timestamp: Date.now() });

  salvarEstado();
  renderLeilao();
  if (modoSalaAtivo()) SALA.aoLanceAceito(jogador, valor);
  return { ok: true };
}

function desfazerLance() {
  if (!ESTADO || !ESTADO.loteAtual || emRevelacao || emMartelo) return;
  const lote = ESTADO.loteAtual;
  const ultimo = lote.lances.pop();
  if (!ultimo) return;

  lote.lanceAtual = ultimo.lanceAnterior;
  lote.jogadorLiderId = ultimo.liderAnteriorId;

  const jogador = ESTADO.jogadores.find((j) => j.id === ultimo.jogadorId);
  if (jogador) {
    jogador.ultimoLance = ultimo.ultimoLanceAnterior;
    const i = jogador.historico.map((h) => h.tipo).lastIndexOf("lance");
    if (i >= 0 && jogador.historico[i].item === lote.item) jogador.historico.splice(i, 1);
  }
  if (!ESTADO.pausado) lote.tempoRestanteMs = ESTADO.config.tempoContador * 1000;

  salvarEstado();
  renderLeilao();
}

function encerrarLote() {
  if (emMartelo) return;
  pararTimer();
  emMartelo = true;
  const lote = ESTADO.loteAtual;
  const vencedor = lote.jogadorLiderId ? ESTADO.jogadores.find((j) => j.id === lote.jogadorLiderId) : null;

  if (vencedor) {
    vencedor.carteiraAtual -= lote.lanceAtual;
    vencedor.itensArrematados.push({ item: lote.item, valor: lote.lanceAtual, rodada: ESTADO.rodadaAtual + 1, metric: lote.metric, tema: lote.tema });
    vencedor.historico.push({ tipo: "arrematado", item: lote.item, valor: lote.lanceAtual, rodada: ESTADO.rodadaAtual + 1, timestamp: Date.now() });
  }
  // fica salvo: se a página recarregar durante o martelo, o lote não é leiloado de novo
  ESTADO.loteFechado = { vencedorNome: vencedor ? vencedor.nome : null, valor: lote.lanceAtual };
  salvarEstado();

  mostrarAnimacaoMartelo(vencedor, lote);

  setTimeout(() => {
    esconderAnimacaoMartelo();
    aposMartelo();
  }, DURACAO_MARTELO_MS);
}

function aposMartelo() {
  emMartelo = false;
  ESTADO.loteFechado = null;
  const temProximoItem = ESTADO.rodadaAtual + 1 < ESTADO.filaItens.length;
  if (temProximoItem && todosTimesCompletos()) {
    mostrarEncerramentoAntecipado();
  } else {
    avancarRodada();
  }
}

function pularItem() {
  if (!ESTADO || !ESTADO.loteAtual || ESTADO.pausado || emRevelacao || emMartelo) return;
  encerrarLote();
}

function avancarRodada() {
  ESTADO.rodadaAtual += 1;
  if (ESTADO.rodadaAtual < ESTADO.filaItens.length) {
    const proximoItem = ESTADO.filaItens[ESTADO.rodadaAtual];
    ESTADO.loteAtual = criarLote(proximoItem);
    salvarEstado();
    renderLeilao();
    iniciarRevelacao(proximoItem, () => iniciarTimerLote());
  } else {
    finalizarJogo();
  }
}

/* =========================================================
   Encerramento antecipado — quando ninguém mais pode dar lance
   ========================================================= */
// Só faz sentido no modo "máximo" (regraTime === "max"): é a única regra onde
// completar o time trava novos lances (timeCheio). No modo "mínimo" o jogador
// ainda pode arrematar mais itens pra tentar upgrade, então não há early-end.
function todosTimesCompletos() {
  return (
    ESTADO.config.regraTime === "max" &&
    ESTADO.jogadores.every((j) => j.itensArrematados.length >= ESTADO.config.tamanhoTime)
  );
}

// Quantos itens ainda podem virar "não vendido" sem que fique matematicamente
// impossível todo mundo completar o time (só faz sentido no modo "máximo").
function calcularFolgaPulos() {
  if (!ESTADO || ESTADO.config.regraTime !== "max") return null;
  const itensRestantes = ESTADO.filaItens.length - ESTADO.rodadaAtual; // inclui o lote em aberto
  const necessidade = ESTADO.jogadores.reduce(
    (soma, j) => soma + Math.max(0, ESTADO.config.tamanhoTime - j.itensArrematados.length),
    0
  );
  return itensRestantes - necessidade;
}

function renderPulosRestantes() {
  const el = elId("pulos-info");
  if (!el) return;
  const folga = calcularFolgaPulos();
  if (folga === null) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.classList.toggle("pulos-critico", folga <= 0);
  if (folga < 0) {
    el.textContent = `⚠️ Times incompletos: já não dá mais pra todo mundo fechar o time (faltariam ${-folga})`;
  } else if (folga === 0) {
    el.textContent = "⚠️ 0 pulos restantes — a partir de agora todo item precisa ser vendido";
  } else {
    el.textContent = `🔁 ${plural(folga, "pulo restante", "pulos restantes")} sem travar os times`;
  }
}

function renderEncerramentoAntecipado() {
  const restantes = ESTADO.filaItens.slice(ESTADO.rodadaAtual + 1);
  elId("encerramento-texto").textContent =
    `Todo mundo já bateu o limite de ${plural(ESTADO.config.tamanhoTime, "item", "itens")} por time — ninguém mais pode dar lance. ` +
    `Ainda restariam ${plural(restantes.length, "item", "itens")} no leilão (sem revelar a pontuação):`;
  elId("lista-itens-restantes").innerHTML = restantes
    .map((item) => `<li>${item.temaIcon || ""} ${escapeHtml(item.nome)}</li>`)
    .join("");
  elId("lote-card").classList.add("hidden");
  elId("lista-jogadores-leilao").classList.add("hidden");
  elId("encerramento-antecipado").classList.remove("hidden");
  renderPulosRestantes();
}

function mostrarEncerramentoAntecipado() {
  ESTADO.aguardandoDecisaoFim = true;
  salvarEstado();
  renderEncerramentoAntecipado();
}

function esconderEncerramentoAntecipado() {
  elId("encerramento-antecipado").classList.add("hidden");
  elId("lote-card").classList.remove("hidden");
  elId("lista-jogadores-leilao").classList.remove("hidden");
}

function encerrarAgora() {
  if (!ESTADO || !ESTADO.aguardandoDecisaoFim) return;
  ESTADO.aguardandoDecisaoFim = false;
  finalizarJogo();
}

function continuarLeilaoMesmoAssim() {
  if (!ESTADO || !ESTADO.aguardandoDecisaoFim) return;
  ESTADO.aguardandoDecisaoFim = false;
  esconderEncerramentoAntecipado();
  salvarEstado();
  avancarRodada();
}

function finalizarJogo() {
  ESTADO.fase = "resultado";
  salvarEstado();
  registrarResultadoNoHistorico();
  aplicarFase("resultado");
  renderResultado();
}

/* =========================================================
   Animação do martelo
   ========================================================= */
function tocarSomMartelo() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    const ruido = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
    const dados = ruido.getChannelData(0);
    for (let i = 0; i < dados.length; i++) dados[i] = (Math.random() * 2 - 1) * (1 - i / dados.length);

    MARTELO_BATIDAS_S.forEach((offset) => {
      const t = ctx.currentTime + offset;

      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.exponentialRampToValueAtTime(70, t + 0.12);
      ganho.gain.setValueAtTime(0.0001, t);
      ganho.gain.exponentialRampToValueAtTime(0.7, t + 0.008);
      ganho.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(ganho).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);

      const fonte = ctx.createBufferSource();
      fonte.buffer = ruido;
      const filtro = ctx.createBiquadFilter();
      filtro.type = "bandpass";
      filtro.frequency.value = 900;
      filtro.Q.value = 0.8;
      const ganhoRuido = ctx.createGain();
      ganhoRuido.gain.setValueAtTime(0.35, t);
      ganhoRuido.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      fonte.connect(filtro).connect(ganhoRuido).connect(ctx.destination);
      fonte.start(t);
    });

    setTimeout(() => ctx.close(), 3000);
  } catch (e) {
    // áudio indisponível — segue sem som
  }
}

function gerarConfete(overlay) {
  const cores = ["#d4af37", "#e9cd75", "#f8fafc", "#22c55e"];
  for (let i = 0; i < 30; i++) {
    const span = document.createElement("span");
    span.className = "confete";
    span.style.left = Math.random() * 100 + "%";
    span.style.background = cores[Math.floor(Math.random() * cores.length)];
    const duracao = 1.1 + Math.random() * 1.2;
    span.style.animationDuration = duracao + "s";
    span.style.animationDelay = Math.random() * 0.3 + "s";
    overlay.appendChild(span);
  }
}

function mostrarAnimacaoMartelo(vencedor, lote) {
  const overlay = elId("gavel-overlay");
  const palco = elId("martelo-palco");
  const texto = elId("gavel-result-text");

  overlay.classList.remove("hidden");
  palco.classList.remove("bater");
  texto.classList.remove("mostrar");
  texto.textContent = "";
  overlay.querySelectorAll(".confete").forEach((c) => c.remove());

  void palco.offsetWidth; // força reflow para reiniciar a animação
  palco.classList.add("bater");
  tocarSomMartelo();

  const ultimaBatidaMs = MARTELO_BATIDAS_S[MARTELO_BATIDAS_S.length - 1] * 1000;
  if (vencedor) {
    setTimeout(() => gerarConfete(overlay.querySelector(".gavel-scene")), ultimaBatidaMs);
  }

  setTimeout(() => {
    texto.textContent = vencedor ? `VENDIDO! ${vencedor.nome} — ${fmtMoeda(lote.lanceAtual)}` : "NÃO VENDIDO";
    texto.classList.add("mostrar");
  }, ultimaBatidaMs + 150);
}

function esconderAnimacaoMartelo() {
  const overlay = elId("gavel-overlay");
  overlay.classList.add("hidden");
  overlay.querySelectorAll(".confete").forEach((c) => c.remove());
}

/* =========================================================
   Render — tela de Leilão
   ========================================================= */
function renderContador() {
  const lote = ESTADO.loteAtual;
  const totalMs = ESTADO.config.tempoContador * 1000;
  const pct = Math.max(0, (lote.tempoRestanteMs / totalMs) * 100);
  const preenchimento = elId("contador-preenchimento");
  preenchimento.style.width = pct + "%";
  preenchimento.classList.toggle("urgente", lote.tempoRestanteMs <= 3000);
  elId("contador-numero").textContent = Math.ceil(lote.tempoRestanteMs / 1000) + "s";
}

function renderHistoricoLances() {
  const lote = ESTADO.loteAtual;
  const el = elId("lances-historico");
  if (!lote.lances.length) {
    el.innerHTML = "";
    return;
  }
  const ultimos = lote.lances.slice(-5).reverse();
  el.innerHTML =
    '<div class="lances-historico-titulo">Histórico de lances</div>' +
    ultimos
      .map((l, i) => {
        const j = ESTADO.jogadores.find((x) => x.id === l.jogadorId);
        return `<div class="lance-linha${i === 0 ? " atual" : ""}"><span>${escapeHtml(j ? j.nome : "?")}</span><strong>${fmtMoeda(l.valor)}</strong></div>`;
      })
      .join("");
}

function renderLeilao() {
  const lote = ESTADO.loteAtual;
  elId("rodada-atual").textContent = ESTADO.rodadaAtual + 1;
  elId("rodada-total").textContent = ESTADO.filaItens.length;
  elId("tema-atual-info").textContent = `${lote.temaIcon || ""} ${lote.temaLabel || ""}`.trim();
  elId("lote-icon").textContent = lote.temaIcon || "🔨";
  elId("lote-item-nome").textContent = lote.item;
  elId("lance-atual-valor").textContent = fmtMoeda(lote.lanceAtual);

  const lider = lote.jogadorLiderId ? ESTADO.jogadores.find((j) => j.id === lote.jogadorLiderId) : null;
  elId("lance-atual-lider").textContent = lider ? `${lider.nome} está na frente` : "Nenhum lance ainda";

  renderContador();
  renderHistoricoLances();
  renderJogadoresLeilao();
  renderPulosRestantes();
  atualizarControlesLeilao();
}

function renderJogadoresLeilao() {
  const container = elId("lista-jogadores-leilao");
  container.innerHTML = "";
  const lote = ESTADO.loteAtual;
  const travadoGeral = ESTADO.pausado || emRevelacao;

  ESTADO.jogadores.forEach((jogador) => {
    const card = document.createElement("div");
    const cheio = timeCheio(jogador);
    const travado = travadoGeral || cheio;
    card.className = "jogador-card" + (lote.jogadorLiderId === jogador.id ? " lider" : "") + (cheio ? " time-cheio" : "");
    card.dataset.id = jogador.id;

    const badges = jogador.itensArrematados
      .map((i) => `<span class="badge">${escapeHtml(i.item)} <span class="badge-valor">${fmtMoeda(i.valor)}</span></span>`)
      .join("");
    const avisoCheio = cheio ? `<div class="aviso-time-cheio">✓ Time completo (${ESTADO.config.tamanhoTime})</div>` : "";

    if (ESTADO.sala) {
      // modo sala: os lances vêm do celular — aqui é só placar + status da conexão
      const conectado = modoSalaAtivo() && SALA.jogadorConectado(jogador.id);
      const statusHtml = `<span class="status-conexao ${conectado ? "online" : "offline"}" title="${conectado ? "Celular conectado" : "Celular desconectado"}">${conectado ? "📱" : "⚠️"}</span>`;
      card.innerHTML = `
        <div class="nome-jogador">${statusHtml} ${escapeHtml(jogador.nome)} ${lote.jogadorLiderId === jogador.id ? "👑" : ""}</div>
        <div class="info-linha"><span>Carteira</span><strong>${fmtMoeda(jogador.carteiraAtual)}</strong></div>
        <div class="info-linha"><span>Último lance</span><strong>${jogador.ultimoLance ? fmtMoeda(jogador.ultimoLance) : "—"}</strong></div>
        <div class="badges">${badges}</div>
        ${avisoCheio}
      `;
      container.appendChild(card);
      return;
    }

    const proximoMin = lote.lanceAtual + 1;
    const incrementos = incrementosDaPartida().map((inc) => {
      const valor = lote.lanceAtual + inc;
      const desabilitado = valor > jogador.carteiraAtual || travado ? "disabled" : "";
      return `<button type="button" class="btn btn-small btn-gold" data-acao="lance-rapido" data-valor="${valor}" ${desabilitado}>+${inc}</button>`;
    }).join("");
    const disabledManual = travado ? "disabled" : "";

    card.innerHTML = `
      <div class="nome-jogador">${escapeHtml(jogador.nome)} ${lote.jogadorLiderId === jogador.id ? "👑" : ""}</div>
      <div class="info-linha"><span>Carteira</span><strong>${fmtMoeda(jogador.carteiraAtual)}</strong></div>
      <div class="info-linha"><span>Último lance</span><strong>${jogador.ultimoLance ? fmtMoeda(jogador.ultimoLance) : "—"}</strong></div>
      <div class="badges">${badges}</div>
      ${avisoCheio}
      <div class="lance-rapido">${incrementos}</div>
      <div class="lance-manual">
        <input type="number" min="${proximoMin}" step="1" placeholder="${proximoMin}" data-acao="input-manual" ${disabledManual}>
        <button type="button" class="btn btn-small btn-primary" data-acao="lance-manual" ${disabledManual}>Dar lance</button>
      </div>
      <div class="erro-lance"></div>
    `;

    card.querySelectorAll('[data-acao="lance-rapido"]').forEach((btn) => {
      btn.addEventListener("click", () => darLance(jogador.id, parseFloat(btn.dataset.valor)));
    });
    card.querySelector('[data-acao="lance-manual"]').addEventListener("click", () => {
      const input = card.querySelector('[data-acao="input-manual"]');
      darLance(jogador.id, parseFloat(input.value));
    });

    container.appendChild(card);
  });
}

/* =========================================================
   Render — tela de Resultado
   ========================================================= */
// Pontuação = SOMA (não média) da métrica dos até tamanhoTime melhores itens do time.
// Isso é proposital: quem não completa o time acaba somando menos números,
// então não dá mais pra vencer só com 2 itens muito bons enquanto outro
// jogador completou o time inteiro com itens medianos.
// Usada tanto pra renderizar o resultado quanto pra gravar no histórico.
function calcularResultado() {
  const modoMetrica = ESTADO.config.modoDecisao === "metrica" && ESTADO.config.metaTemaSelecionada;
  const meta = ESTADO.config.metaTemaSelecionada;
  const tamanhoTime = ESTADO.config.tamanhoTime;

  const jogadoresComPontuacao = ESTADO.jogadores.map((jogador) => {
    const itensOrdenados = [...jogador.itensArrematados].sort((a, b) => (b.metric ?? -Infinity) - (a.metric ?? -Infinity));
    const top = itensOrdenados.slice(0, tamanhoTime).filter((i) => typeof i.metric === "number");
    const pontuacao = top.length ? top.reduce((s, i) => s + i.metric, 0) : null;
    const gasto = jogador.orcamentoInicial - jogador.carteiraAtual;
    const completo = jogador.itensArrematados.length >= tamanhoTime;
    return { jogador, pontuacao, gasto, completo };
  });

  const ranking = [...jogadoresComPontuacao].sort((a, b) => (b.pontuacao ?? -Infinity) - (a.pontuacao ?? -Infinity));
  const melhorPontuacao = modoMetrica && ranking[0] && ranking[0].pontuacao !== null ? ranking[0].pontuacao : null;

  return { modoMetrica, meta, tamanhoTime, jogadoresComPontuacao, ranking, melhorPontuacao };
}

function renderResultado() {
  const { modoMetrica, meta, tamanhoTime, jogadoresComPontuacao, ranking, melhorPontuacao } = calcularResultado();

  const btnRevelar = elId("btn-revelar-indices-resultado");
  btnRevelar.classList.toggle("hidden", modoMetrica);
  elId("grid-resultado-jogadores").classList.remove("revelado");

  const titulo = elId("resultado-titulo");
  const subtitulo = elId("resultado-subtitulo");
  if (modoMetrica && melhorPontuacao !== null) {
    const campeoes = ranking.filter((r) => r.pontuacao === melhorPontuacao).map((r) => r.jogador.nome);
    titulo.textContent = campeoes.length > 1 ? `Empate: ${campeoes.join(" e ")}!` : `${campeoes[0]} venceu!`;
    subtitulo.textContent = `${melhorPontuacao.toFixed(1)} pontos em ${meta.label} (${meta.metricLabel}).`;
  } else {
    titulo.textContent = "Leilão encerrado!";
    subtitulo.textContent = modoMetrica ? "Ninguém arrematou itens pontuáveis." : "Modo manual — comparem os times e decidam o vencedor.";
  }

  const rankingEl = elId("ranking-metrica");
  if (modoMetrica) {
    rankingEl.classList.remove("hidden");
    rankingEl.innerHTML = `
      <h2>🏆 Ranking automático — ${escapeHtml(meta.label)} (${escapeHtml(meta.metricLabel)})</h2>
      <p class="hint">Pontuação = SOMA da métrica dos até ${tamanhoTime} melhores itens do time de cada jogador (não é média) — quem completa o time todo leva vantagem sobre quem garantiu só poucos itens muito bons.</p>
      <ol>
        ${ranking
          .map((r) => {
            const destaque = melhorPontuacao !== null && r.pontuacao === melhorPontuacao ? '<span class="trofeu">🏆</span> ' : "";
            const pontuacaoTxt = r.pontuacao !== null ? `${r.pontuacao.toFixed(1)} pontos` : "sem itens pontáveis";
            return `<li>${destaque}<strong>${escapeHtml(r.jogador.nome)}</strong> — ${pontuacaoTxt}</li>`;
          })
          .join("")}
      </ol>
    `;
  } else {
    rankingEl.classList.add("hidden");
    rankingEl.innerHTML = "";
  }

  const grid = elId("grid-resultado-jogadores");
  grid.innerHTML = "";
  jogadoresComPontuacao.forEach(({ jogador, pontuacao, gasto, completo }) => {
    const card = document.createElement("div");
    card.className = "resultado-card" + (modoMetrica && pontuacao === melhorPontuacao && pontuacao !== null ? " vencedor" : "");

    const itensHtml = jogador.itensArrematados
      .map((i) => {
        const temaDoItem = i.tema && BANCO[i.tema] ? BANCO[i.tema] : null;
        const metricMax = modoMetrica ? meta.metricMax : temaDoItem ? temaDoItem.metricMax : 100;
        const classeMetric = "item-metric" + (modoMetrica ? "" : " so-revelar");
        const metricHtml =
          typeof i.metric === "number" ? `<span class="${classeMetric}">${fmtMetric(i.metric, metricMax)}</span>` : "";
        return `<li class="item-resultado"><span>${escapeHtml(i.item)} (${fmtMoeda(i.valor)})</span>${metricHtml}</li>`;
      })
      .join("") || '<li class="hint">Nenhum item arrematado.</li>';

    const historicoHtml = jogador.historico
      .filter((h) => h.tipo === "arrematado")
      .map((h) => `<div class="linha-historico"><span>Rodada ${h.rodada}: ${escapeHtml(h.item)}</span><span>${fmtMoeda(h.valor)}</span></div>`)
      .join("") || '<p class="hint">Sem arremates.</p>';

    const statusTxt = completo ? "Time completo" : `Faltam ${Math.max(0, tamanhoTime - jogador.itensArrematados.length)}`;

    card.innerHTML = `
      <h3>${escapeHtml(jogador.nome)} <span class="status-time ${completo ? "completo" : "incompleto"}">${statusTxt}</span></h3>
      <div class="info-linha"><span>Total gasto</span><strong>${fmtMoeda(gasto)}</strong></div>
      <div class="info-linha"><span>Saldo restante</span><strong>${fmtMoeda(jogador.carteiraAtual)}</strong></div>
      <ul>${itensHtml}</ul>
      <details class="historico-detalhe">
        <summary>Histórico de arremates</summary>
        ${historicoHtml}
      </details>
    `;
    grid.appendChild(card);
  });
}

/* =========================================================
   Navegação entre fases / novo jogo
   ========================================================= */
function aplicarFase(fase) {
  document.body.dataset.fase = fase;
  elId("btn-novo-jogo-header").hidden = fase === "setup";
}

function novoJogo() {
  pararTimer();
  limparEstado();
  sorteioAtual = null;
  qtdItensEditadoManualmente = false;
  emRevelacao = false;
  emMartelo = false;
  modoDecisaoManualEscolhido = false;
  elId("gavel-overlay").classList.add("hidden");
  elId("reveal-overlay").classList.add("hidden");
  elId("preview-sorteio").classList.add("hidden");
  mostrarErroSetup("");
  aplicarFase("setup");
  renderSetupCompleto();
  aoMudarEstado();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* =========================================================
   Modal genérico (índices oficiais, histórico)
   ========================================================= */
function abrirModal(titulo, corpoHtml) {
  elId("modal-titulo").textContent = titulo;
  elId("modal-corpo").innerHTML = corpoHtml;
  elId("modal-overlay").classList.remove("hidden");
}

function fecharModal() {
  elId("modal-overlay").classList.add("hidden");
}

/* =========================================================
   Histórico de vencedores (persistente, separado do save da partida)
   ========================================================= */
function carregarHistorico() {
  try {
    const raw = localStorage.getItem(CHAVE_HISTORICO);
    const lista = raw ? JSON.parse(raw) : [];
    return Array.isArray(lista) ? lista : [];
  } catch (e) {
    console.warn("Falha ao ler histórico de leilões.", e);
    return [];
  }
}

function salvarHistorico(lista) {
  localStorage.setItem(CHAVE_HISTORICO, JSON.stringify(lista));
}

function registrarResultadoNoHistorico() {
  const { modoMetrica, meta, jogadoresComPontuacao, melhorPontuacao } = calcularResultado();
  const vencedores =
    modoMetrica && melhorPontuacao !== null
      ? jogadoresComPontuacao.filter((r) => r.pontuacao === melhorPontuacao).map((r) => r.jogador.nome)
      : [];

  const registro = {
    data: new Date().toISOString(),
    temas: ESTADO.config.temasSelecionados.map((k) => (BANCO[k] ? BANCO[k].label : k)),
    modoDecisao: ESTADO.config.modoDecisao,
    metricLabel: modoMetrica ? meta.metricLabel : null,
    vencedores,
    jogadores: jogadoresComPontuacao.map(({ jogador, pontuacao, gasto, completo }) => ({
      nome: jogador.nome,
      pontuacao,
      gasto,
      completo,
      itens: jogador.itensArrematados.map((i) => ({ nome: i.item, valor: i.valor })),
    })),
  };

  const hist = carregarHistorico();
  hist.push(registro);
  salvarHistorico(hist);
}

function conteudoHistorico() {
  const hist = carregarHistorico();
  const acoes = `
    <div class="historico-acoes">
      <button type="button" id="btn-exportar-historico" class="btn btn-gold btn-small">⬇ Exportar backup</button>
      <button type="button" id="btn-limpar-historico" class="btn btn-ghost btn-small">🗑 Limpar histórico</button>
    </div>`;

  if (!hist.length) {
    return acoes + '<p class="hint">Nenhum leilão concluído ainda.</p>';
  }

  const itens = hist
    .slice()
    .reverse()
    .map((r) => {
      const dataFmt = new Date(r.data).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
      const vencedorTxt = r.vencedores.length
        ? `🏆 ${r.vencedores.join(" e ")}`
        : r.modoDecisao === "manual"
        ? "decidido manualmente"
        : "sem pontuação";
      const jogadoresResumo = r.jogadores
        .map((j) => `${escapeHtml(j.nome)}${j.pontuacao !== null ? ` (${j.pontuacao.toFixed(1)} pts)` : ""}`)
        .join(", ");
      const timesHtml = r.jogadores
        .map((j) => {
          const itensTxt = j.itens.length
            ? j.itens.map((it) => `${escapeHtml(it.nome)} (${fmtMoeda(it.valor)})`).join(", ")
            : "nenhum item arrematado";
          return `<div class="historico-time"><strong>${escapeHtml(j.nome)}</strong> — ${itensTxt}</div>`;
        })
        .join("");
      return `
        <details class="historico-item">
          <summary><strong>${escapeHtml(vencedorTxt)}</strong> · ${escapeHtml(dataFmt)} <span class="hint">${escapeHtml(r.temas.join(", "))}</span></summary>
          <p class="hint">${jogadoresResumo}</p>
          ${timesHtml}
        </details>`;
    })
    .join("");

  return acoes + itens;
}

function abrirHistorico() {
  abrirModal("📜 Histórico de leilões", conteudoHistorico());
  const btnExportar = elId("btn-exportar-historico");
  const btnLimpar = elId("btn-limpar-historico");
  if (btnExportar) btnExportar.addEventListener("click", exportarHistorico);
  if (btnLimpar) btnLimpar.addEventListener("click", limparHistoricoComConfirmacao);
}

function exportarHistorico() {
  const hist = carregarHistorico();
  const blob = new Blob([JSON.stringify(hist, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `leilao-historico-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function limparHistoricoComConfirmacao() {
  if (!confirm("Apagar todo o histórico de leilões? Essa ação não pode ser desfeita (exporte um backup antes, se quiser guardar).")) return;
  salvarHistorico([]);
  abrirHistorico();
}

/* =========================================================
   Boot
   ========================================================= */
function renderSetupCompleto() {
  renderJogadoresSalvos();
  renderTemas();
  atualizarInfoRegraTime();
  atualizarSugestaoQtdItens();
  renderContagemTemas();
  renderSelectTemaAdd();
  renderResumoConfig();
}

function ligarEventos() {
  elId("form-add-jogador").addEventListener("submit", adicionarJogadorSalvo);
  elId("input-tamanho-time").addEventListener("input", () => {
    atualizarInfoRegraTime();
    atualizarSugestaoQtdItens();
  });
  document.querySelectorAll('input[name="regra-time"]').forEach((r) => r.addEventListener("change", atualizarInfoRegraTime));
  elId("input-qtd-itens").addEventListener("input", () => {
    qtdItensEditadoManualmente = true;
  });
  elId("check-novo-tema").addEventListener("change", (ev) => {
    elId("input-novo-tema-nome").hidden = !ev.target.checked;
    elId("select-tema-add").hidden = ev.target.checked;
  });
  document.querySelectorAll('input[name="modo-decisao"]').forEach((r) =>
    r.addEventListener("change", () => {
      modoDecisaoManualEscolhido = r.value === "manual" && r.checked;
      atualizarModoDecisaoDisponibilidade();
    })
  );
  elId("form-add-itens").addEventListener("submit", lidarComSubmitAddItens);

  // qualquer mudança no setup atualiza o painel "Próximo leilão"
  elId("view-setup").addEventListener("input", renderResumoConfig);
  elId("view-setup").addEventListener("change", renderResumoConfig);

  elId("btn-sortear").addEventListener("click", sortearItens);
  elId("btn-iniciar-leilao").addEventListener("click", iniciarLeilao);
  elId("btn-desfazer-lance").addEventListener("click", desfazerLance);
  elId("btn-pular-item").addEventListener("click", pularItem);
  elId("btn-fechar-lance").addEventListener("click", pularItem);
  elId("btn-pausar").addEventListener("click", alternarPausa);
  elId("btn-encerrar-agora").addEventListener("click", encerrarAgora);
  elId("btn-continuar-leilao").addEventListener("click", continuarLeilaoMesmoAssim);
  elId("btn-novo-jogo").addEventListener("click", novoJogo);
  elId("btn-novo-jogo-header").addEventListener("click", novoJogo);

  elId("btn-historico-header").addEventListener("click", abrirHistorico);
  elId("btn-revelar-indices-resultado").addEventListener("click", () => {
    elId("grid-resultado-jogadores").classList.add("revelado");
    elId("btn-revelar-indices-resultado").classList.add("hidden");
  });

  elId("modal-fechar").addEventListener("click", fecharModal);
  elId("modal-overlay").addEventListener("click", (ev) => {
    if (ev.target.id === "modal-overlay") fecharModal();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !elId("modal-overlay").classList.contains("hidden")) fecharModal();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  BANCO = carregarBanco();
  JOGADORES_SALVOS = carregarJogadoresSalvos();
  jogadoresSelecionados = JOGADORES_SALVOS.slice(0, MAX_JOGADORES);
  ligarEventos();
  renderSetupCompleto();

  ESTADO = carregarEstado();
  if (ESTADO && ESTADO.fase === "leilao") {
    aplicarFase("leilao");
    renderLeilao();
    if (ESTADO.loteFechado) {
      aposMartelo();
    } else if (ESTADO.aguardandoDecisaoFim) {
      renderEncerramentoAntecipado();
    } else if (!ESTADO.pausado) {
      iniciarTimerLote();
    }
  } else if (ESTADO && ESTADO.fase === "resultado") {
    aplicarFase("resultado");
    renderResultado();
  } else {
    aplicarFase("setup");
  }
});
