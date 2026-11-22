/*
 * Coletor de Campo - aplicativo genérico de coleta offline.
 * Não contém dados nem regras técnicas: os formulários e listas vêm do servidor configurado em Ajustes.
 * Os registros ficam no aparelho (IndexedDB) até serem enviados.
 * Todos os direitos reservados.
 */
'use strict';

const VERSAO_APP = '1.6.0';
const LIMITE_ENVIO = 34 * 1024 * 1024; // acima disso o arquivo fica para envio manual

/* ============================== BANCO LOCAL ============================== */
const DB = (() => {
  let p;
  function abrir() {
    if (!p) p = new Promise((res, rej) => {
      const r = indexedDB.open('coletor-campo', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('registros', { keyPath: 'id' });
        d.createObjectStore('blobs', { keyPath: 'id' });
        d.createObjectStore('kv', { keyPath: 'k' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return p;
  }
  async function tx(st, modo, fn) {
    const d = await abrir();
    return new Promise((res, rej) => {
      const t = d.transaction(st, modo);
      const req = fn(t.objectStore(st));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Gravação cancelada (espaço cheio?)'));
    });
  }
  // Se o navegador não permitir armazenamento, os dados ficam só na memória (com aviso na tela).
  const MEM = { registros: new Map(), blobs: new Map(), kv: new Map() };
  const chaveDe = (st, v) => st === 'kv' ? v.k : v.id;
  async function op(st, modo, fn, mem) {
    if (!DB.memoria) {
      try { return await tx(st, modo, fn); } catch (e) {
        if (!(e && /space|quota/i.test(String(e.message || e)))) { DB.memoria = true; setTimeout(() => { const a = document.getElementById('aviso'); if (a) { a.textContent = 'Este navegador não permite guardar dados: o que for registrado aqui se perde ao fechar.'; a.hidden = false; } }, 500); }
        else throw e;
      }
    }
    return mem(MEM[st]);
  }
  const DB = {
    memoria: false,
    get: (st, k) => op(st, 'readonly', s => s.get(k), m => m.get(k)),
    put: (st, v) => op(st, 'readwrite', s => s.put(v), m => { m.set(chaveDe(st, v), v); }),
    del: (st, k) => op(st, 'readwrite', s => s.delete(k), m => { m.delete(k); }),
    all: st => op(st, 'readonly', s => s.getAll(), m => [...m.values()]),
    kvGet: async k => { const r = await DB.get('kv', k); return r ? r.v : undefined; },
    kvSet: (k, v) => DB.put('kv', { k, v }),
    kvKeys: async () => (await DB.all('kv')).map(x => x.k)
  };
  return DB;
})();

/* ================================ ESTADO ================================ */
const S = {
  cfg: null,
  ajustes: { url: '', chave: '', avaliador: '' },
  ctx: { filial: '', fase: '' },
  extras: { secoes: {}, funcoes: {} },
  regs: new Map(),
  sinc: false,
  progresso: '',
  editor: null,
  gravando: null,
  instalar: null
};

/* =============================== UTILIDADES =============================== */
function h(tag, props, ...filhos) {
  const el = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    el.appendChild(typeof f === 'string' || typeof f === 'number' ? document.createTextNode(String(f)) : f);
  }
  return el;
}
const $ = s => document.querySelector(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 20);
const agoraIso = () => new Date().toISOString();
const dois = n => String(n).padStart(2, '0');
function hojeIso() { const d = new Date(); return d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate()); }
function horaAgora() { const d = new Date(); return dois(d.getHours()) + ':' + dois(d.getMinutes()); }
function dataHoraBr(iso) { if (!iso) return ''; const d = new Date(iso); return dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + ' ' + dois(d.getHours()) + ':' + dois(d.getMinutes()); }
function carimboArquivo() { const d = new Date(); return d.getFullYear() + dois(d.getMonth() + 1) + dois(d.getDate()) + '-' + dois(d.getHours()) + dois(d.getMinutes()) + dois(d.getSeconds()); }
function numero(v) { if (v === '' || v === null || v === undefined) return NaN; return Number(String(v).trim().replace(/\s/g, '').replace(',', '.')); }
function mostraNum(v) { return (v === '' || v === undefined || v === null) ? '' : String(v).replace('.', ','); }
function tamanho(b) { if (!b) return ''; return b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.ceil(b / 1024) + ' KB'; }
function limpaNome(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w .()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, ms || 3200);
}

function modal(conteudo, opcoes) {
  opcoes = opcoes || {};
  const fundo = h('div', { class: 'modal-fundo' });
  const caixa = h('div', { class: 'modal' + (opcoes.cheio ? ' cheio' : '') }, conteudo);
  fundo.appendChild(caixa);
  document.body.appendChild(fundo);
  document.body.classList.add('travado');
  const fechar = () => { fundo.remove(); document.body.classList.remove('travado'); if (opcoes.aoFechar) opcoes.aoFechar(); };
  if (!opcoes.cheio && !opcoes.semFechar) fundo.addEventListener('click', e => { if (e.target === fundo) fechar(); });
  return fechar;
}

function confirmar(texto, rotuloSim) {
  return new Promise(res => {
    let fechar;
    const c = h('div', null,
      h('p', { class: 'modal-txt', text: texto }),
      h('div', { class: 'linha-bts' },
        h('button', { class: 'bt sec', text: 'Cancelar', onclick: () => { fechar(); res(false); } }),
        h('button', { class: 'bt perigo', text: rotuloSim || 'Confirmar', onclick: () => { fechar(); res(true); } })));
    fechar = modal(c);
  });
}

function perguntar(texto, valor) {
  return new Promise(res => {
    let fechar;
    const inp = h('input', { class: 'inp', value: valor || '' });
    const c = h('div', null, h('p', { class: 'modal-txt', text: texto }), inp,
      h('div', { class: 'linha-bts' },
        h('button', { class: 'bt sec', text: 'Cancelar', onclick: () => { fechar(); res(null); } }),
        h('button', { class: 'bt', text: 'OK', onclick: () => { fechar(); res(inp.value.trim()); } })));
    fechar = modal(c);
    setTimeout(() => inp.focus(), 50);
  });
}

function blobParaBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

const urlsObj = new Map();
async function urlDoAnexo(id) {
  if (urlsObj.has(id)) return urlsObj.get(id);
  const b = await DB.get('blobs', id);
  if (!b) return null;
  const u = URL.createObjectURL(b.blob);
  urlsObj.set(id, u);
  return u;
}

/* ============================== FORMULÁRIOS ============================== */
function formularios() { return (S.cfg && S.cfg.formularios) || []; }
function form(id) { return formularios().find(f => f.id === id); }
function filiais() { return (S.cfg && S.cfg.listas && S.cfg.listas.filiais) || []; }
function filialInfo(cod) { return filiais().find(f => f.codigo === cod); }

function linhasQl(filial) {
  const ql = (S.cfg && S.cfg.listas && S.cfg.listas.ql) || [];
  let r = ql.filter(x => x[0] === filial);
  if (!r.length) {
    const fi = filialInfo(filial);
    if (fi && fi.refQl) r = ql.filter(x => x[0] === fi.refQl);
    if (!r.length && fi && fi.bandeira) r = ql.filter(x => x[1] === fi.bandeira);
  }
  return r;
}
function secoesDe(filial) {
  const s = new Set(linhasQl(filial).map(x => x[2]));
  (S.extras.secoes[filial] || []).forEach(x => s.add(x));
  return [...s].filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt'));
}
function funcoesDe(filial, secao) {
  const s = new Set(linhasQl(filial).filter(x => !secao || x[2] === secao).map(x => x[3]));
  (S.extras.funcoes[filial + '|' + secao] || []).forEach(x => s.add(x));
  return [...s].filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt'));
}
/** GHE automático: seções da filial (QL) em ordem alfabética = 01, 02, 03... Seção que a filial não tem não ocupa número. */
function gheDe(filial, secao) {
  if (!secao) return '';
  const unicas = [...new Set(linhasQl(filial).map(x => semAcento(x[2]).trim()).filter(Boolean))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const i = unicas.indexOf(semAcento(secao).trim());
  return i < 0 ? '' : (i < 9 ? '0' : '') + (i + 1);
}
function alocadosDe(filial, secao, funcao) {
  const l = linhasQl(filial).find(x => x[0] === filial && x[2] === secao && x[3] === funcao);
  return l ? l[5] : '';
}

function instrumentosDisponiveis(filtro) {
  const lista = new Map();
  ((S.cfg && S.cfg.instrumentos) || []).forEach(i => lista.set(i.id, i.valores || {}));
  for (const r of S.regs.values()) if (r.form === 'INSTRUMENTO' && !r.excluido) lista.set(r.id, r.valores || {});
  const out = [];
  lista.forEach((v, id) => {
    if (filtro && !String(v.tipo || '').toLowerCase().includes(String(filtro).toLowerCase())) return;
    out.push({ id, rotulo: [v.tipo, [v.fabricante, v.modelo].filter(Boolean).join(' '), v.serie ? 'nº ' + v.serie : ''].filter(Boolean).join(' - ') || 'Instrumento' });
  });
  return out;
}

/* =============================== REGISTROS =============================== */
function pendente(r) {
  return r.excluido || !r.sync || r.sync.versao !== r.versao || (r.anexos || []).some(a => !a.enviado && !a.grande && !a.semArquivo);
}
function registrosVisiveis() { return [...S.regs.values()].filter(r => !r.excluido); }
function qtdPendentes() { return [...S.regs.values()].filter(pendente).length; }

async function gravarReg(r) { S.regs.set(r.id, r); await DB.put('registros', r); }

function aplicarPadroes(campos, alvo) {
  campos.forEach(c => {
    if (c.padrao === 'hoje') alvo[c.id] = hojeIso();
    else if (c.padrao === 'agora') alvo[c.id] = horaAgora();
    else if (c.padrao !== undefined) alvo[c.id] = c.padrao;
  });
}

async function novoRegistro(formId) {
  const f = form(formId);
  if (!f) return;
  if (!f.semFilial && !S.ctx.filial) { toast('Escolha a filial na tela inicial antes de começar.'); location.hash = '#/'; return; }
  if (!S.ajustes.avaliador) {
    const nome = await perguntar('Seu nome (aparece nos registros e mostra à equipe quem fez cada levantamento):');
    if (!nome) return;
    S.ajustes.avaliador = nome.trim().toUpperCase(); await DB.kvSet('ajustes', S.ajustes);
  }
  const r = {
    id: uid(), form: f.id, filial: f.semFilial ? '' : S.ctx.filial, fase: f.semFilial ? '' : S.ctx.fase,
    secao: '', funcao: '', ghe: '', avaliador: S.ajustes.avaliador || '', status: 'rascunho',
    criadoEm: agoraIso(), atualizadoEm: agoraIso(), versao: 1, valores: {}, anexos: [], sync: null
  };
  aplicarPadroes(f.campos, r.valores);
  await gravarReg(r);
  pedirPersistencia();
  location.hash = '#/r/' + r.id;
}

function copiaSemAnexos(campos, valores) {
  const out = {};
  campos.forEach(c => {
    const v = valores[c.id];
    if (v === undefined) return;
    if (['foto', 'audio', 'video', 'arquivo', 'assinatura', 'cronometro', 'gps'].includes(c.tipo) || c.pessoal) return;
    if (c.tipo === 'grupo') out[c.id] = (v || []).map(it => Object.assign(copiaSemAnexos(c.campos, it), { _id: uid() }));
    else out[c.id] = JSON.parse(JSON.stringify(v));
  });
  return out;
}

async function duplicarRegistro(r) {
  const f = form(r.form);
  const n = Object.assign({}, r, {
    id: uid(), status: 'rascunho', criadoEm: agoraIso(), atualizadoEm: agoraIso(), versao: 1, sync: null, anexos: [],
    valores: copiaSemAnexos(f.campos, r.valores || {})
  });
  await gravarReg(n);
  toast('Cópia criada (sem fotos, áudios e assinaturas).');
  location.hash = '#/r/' + n.id;
}

async function excluirRegistro(r) {
  if (!(await confirmar('Excluir este registro? Os arquivos dele também serão apagados do celular.', 'Excluir'))) return false;
  if (!r.sync) await removerLocal(r);
  else { r.excluido = true; r.versao++; await gravarReg(r); sincronizar(false); }
  toast('Registro excluído.');
  return true;
}

async function removerLocal(r) {
  for (const a of r.anexos || []) { await DB.del('blobs', a.id); urlsObj.delete(a.id); }
  await DB.del('registros', r.id);
  S.regs.delete(r.id);
}

async function adicionarAnexo(reg, campoPath, c, blob, nomeBase, extensao) {
  const f = form(reg.form);
  const a = {
    id: uid(), campo: campoPath, mime: blob.type || 'application/octet-stream', tamanho: blob.size,
    nome: [reg.filial ? 'F' + reg.filial : '', reg.form, limpaNome(nomeBase || c.rotulo).slice(0, 30), carimboArquivo() + '-' + uid().slice(0, 4)].filter(Boolean).join(' - ') + '.' + extensao,
    legenda: '', pessoal: !!c.pessoal, criadoEm: agoraIso(), enviado: false
  };
  if (blob.size > LIMITE_ENVIO) a.grande = true;
  await DB.put('blobs', { id: a.id, blob });
  reg.anexos.push(a);
  return a;
}

async function removerAnexo(reg, id) {
  reg.anexos = reg.anexos.filter(a => a.id !== id);
  await DB.del('blobs', id);
  urlsObj.delete(id);
}

/* ============================ FOTO E ARQUIVOS ============================ */
async function processarFoto(arquivo, carimbo) {
  try {
    const bmp = await createImageBitmap(arquivo);
    const max = 1920;
    const esc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * esc), hh = Math.round(bmp.height * esc);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = hh;
    const g = cv.getContext('2d');
    g.drawImage(bmp, 0, 0, w, hh);
    if (carimbo) {
      const fs = Math.max(14, Math.round(w / 48));
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(0, hh - fs * 1.9, w, fs * 1.9);
      g.fillStyle = '#fff';
      g.font = fs + 'px sans-serif';
      g.fillText(carimbo, fs * 0.6, hh - fs * 0.6, w - fs * 1.2);
    }
    return await new Promise(res => cv.toBlob(b => res(b), 'image/jpeg', 0.82));
  } catch (e) {
    return arquivo;
  }
}

function carimboLigado() { return S.ajustes.carimbo !== false; }

async function definirCarimbo(v) {
  S.ajustes.carimbo = !!v;
  await DB.kvSet('ajustes', S.ajustes);
  document.querySelectorAll('input.flag-carimbo').forEach(x => { x.checked = !!v; });
}

function flagCarimbo() {
  return h('label', { class: 'flag' },
    h('input', { type: 'checkbox', class: 'flag-carimbo', checked: carimboLigado(), onchange: e => definirCarimbo(e.target.checked) }),
    'Inserir data, hora, filial e seção na foto');
}

function textoCarimbo(reg) {
  const d = new Date();
  const f = form(reg.form);
  return [dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + dois(d.getHours()) + ':' + dois(d.getMinutes()),
    reg.filial ? 'Filial ' + reg.filial : '', reg.secao || '', f ? f.titulo : ''].filter(Boolean).join('  |  ');
}

/* ================================ SERVIDOR ================================ */
async function api(corpo, tempo) {
  if (window.SERVIDOR_DEMO) return window.SERVIDOR_DEMO(corpo);
  if (!S.ajustes.url || !S.ajustes.chave) throw new Error('Configure o endereço do servidor e a chave em Ajustes.');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), tempo || 60000);
  try {
    const r = await fetch(S.ajustes.url, {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({}, corpo, { chave: S.ajustes.chave }))
    });
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch (e) {
      throw new Error('Resposta inesperada do servidor. Confira se o endereço termina em /exec e se a implantação está como "Qualquer pessoa".');
    }
    if (!j.ok) { const e = new Error(j.erro || 'Erro no servidor.'); e.codigo = j.codigo; throw e; }
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Tempo esgotado (sinal fraco?). Tente de novo.');
    if (e instanceof TypeError) throw new Error('Sem conexão com o servidor.');
    throw e;
  } finally { clearTimeout(t); }
}

async function baixarConfig(silencioso) {
  try {
    const j = await api({ acao: 'config' }, 90000);
    S.cfg = j;
    await DB.kvSet('config', j);
    if (!S.ctx.fase && j.fases && j.fases.length) { S.ctx.fase = j.fases[0]; await DB.kvSet('ctx', S.ctx); }
    if (!silencioso) toast('Formulários atualizados (' + j.formularios.length + ').');
    return true;
  } catch (e) {
    if (!silencioso) toast(e.message, 6000);
    return false;
  }
}

function semDadosLocais(r) {
  const c = JSON.parse(JSON.stringify(r));
  delete c.sync;
  c.anexos = (c.anexos || []).map(a => ({ id: a.id, campo: a.campo, nome: a.nome, mime: a.mime, legenda: a.legenda, pessoal: a.pessoal, url: a.url || '', fileId: a.fileId || '', tamanho: a.tamanho || 0, criadoEm: a.criadoEm || '' }));
  return c;
}

async function sincronizar(manual) {
  if (S.sinc) return;
  if (!S.ajustes.url || !S.ajustes.chave) { if (manual) toast('Configure o servidor em Ajustes.'); return; }
  if (!navigator.onLine) { if (manual) toast('Sem internet. Tudo continua guardado neste aparelho.'); return; }
  S.sinc = true;
  let ok = 0, erros = [], grandes = 0, rec = 0, erroRec = '', total = 0;
  try {
    // 1. Recebe primeiro: assim o que foi feito no outro aparelho é juntado antes de enviar daqui.
    await salvarEditorAgora();
    try { rec = await receberDoServidor(); } catch (e) { erroRec = e.message; if (e.codigo === 'CHAVE' || e.message.startsWith('Sem conexão')) throw e; }
    // 2. Envia o que está pendente aqui.
    const fila = [...S.regs.values()].filter(pendente).sort((a, b) => (a.form === 'INSTRUMENTO' ? -1 : 0) - (b.form === 'INSTRUMENTO' ? -1 : 0) || a.atualizadoEm.localeCompare(b.atualizadoEm));
    total = fila.length;
    for (let i = 0; i < fila.length; i++) {
      const r = fila[i];
      S.progresso = 'Enviando ' + (i + 1) + ' de ' + fila.length;
      atualizarStatus();
      try {
        if (r.excluido) {
          await api({ acao: 'excluir', id: r.id });
          await removerLocal(r);
          ok++; continue;
        }
        for (const a of r.anexos || []) {
          if (a.enviado || a.semArquivo) continue;
          if (a.grande) { grandes++; continue; }
          const b = await DB.get('blobs', a.id);
          if (!b) { a.semArquivo = true; continue; }
          S.progresso = 'Enviando ' + (i + 1) + ' de ' + fila.length + ' - arquivo ' + tamanho(b.blob.size);
          atualizarStatus();
          const base64 = await blobParaBase64(b.blob);
          const res = await api({ acao: 'anexo', registroId: r.id, form: r.form, filial: r.filial,
            anexo: { id: a.id, campo: a.campo, nome: a.nome, mime: a.mime, legenda: a.legenda, pessoal: a.pessoal }, base64 }, 300000);
          a.url = res.url; a.fileId = res.fileId; a.enviado = true;
          await DB.put('registros', r);
        }
        const versao = r.versao;
        const enviado = semDadosLocais(r);
        await api({ acao: 'registro', registro: enviado }, 120000);
        r.sync = { versao, em: agoraIso(), atualizadoEm: enviado.atualizadoEm };
        r.base = baseDe(enviado);
        await DB.put('registros', r);
        ok++;
      } catch (e) {
        erros.push(e.message);
        if (e.codigo === 'CHAVE' || e.message.startsWith('Sem conexão')) break;
      }
    }
  } catch (e) {
    erros.push(e.message);
  } finally {
    S.sinc = false; S.progresso = '';
    await DB.kvSet('ultimaSinc', agoraIso());
    atualizarStatus();
    if (ok || rec) reabrirListas();
  }
  const partes = [];
  if (total || manual) partes.push(total ? 'Enviados: ' + ok : 'Tudo enviado');
  if (grandes) partes.push(grandes + ' arquivo(s) grande(s) ficaram para envio manual');
  if (rec) partes.push('Recebidos do outro aparelho: ' + rec);
  if (erros.length) toast(partes.concat('Falha: ' + erros[0]).join('. '), 7000);
  else if (erroRec && manual) toast(partes.concat('Recepção falhou: ' + erroRec).join('. '), 6000);
  else if (partes.length) toast(partes.join('. ') + '.');
}

/* ===================== RECEPÇÃO (OUTROS APARELHOS) ===================== */
function reabrirListas() {
  if (location.hash === '' || location.hash === '#/' || location.hash.startsWith('#/registros') || location.hash.startsWith('#/f/')) rotear();
}
function chaveRecepcao() { return 'ultimaBaixa:' + (S.ajustes.receberTodas ? '*' : (S.ctx.filial || '-')); }

/** Busca no servidor o que mudou desde a última vez (feito em outro aparelho) e junta aqui. */
async function receberDoServidor() {
  if (!S.ajustes.receberTodas && !S.ctx.filial) return 0;
  const k = chaveRecepcao();
  let desde = (await DB.kvGet(k)) || 0, n = 0, pulado = null;
  for (let pag = 0; pag < 40; pag++) {
    S.progresso = 'Recebendo...'; atualizarStatus();
    const j = await api({ acao: 'listar', desde, filial: S.ajustes.receberTodas ? '' : S.ctx.filial, limite: 150 }, 90000);
    for (const reg of j.registros || []) {
      const t = reg.servidorEm;
      const res = await mesclarDoServidor(reg);
      if (res === 'pulado') pulado = pulado === null ? t : Math.min(pulado, t);
      else if (res) n++;
    }
    desde = j.ate || desde;
    if (!j.mais) break;
  }
  await DB.kvSet(k, pulado !== null ? Math.min(desde, pulado - 1) : desde);
  await DB.kvSet('ultimaRecepcao', agoraIso());
  return n;
}

/**
 * Regra: alteração deste aparelho ainda não enviada prevalece (será enviada e vale para os outros).
 * Sem alteração pendente aqui, vale a versão mais recente do servidor.
 */
/** Retrato do registro no último acerto com o servidor (base da junção campo a campo). */
function baseDe(r) {
  return JSON.stringify({ valores: r.valores || {}, secao: r.secao || '', funcao: r.funcao || '', ghe: r.ghe || '', fase: r.fase || '', status: r.status || '' });
}
const igual = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

/** Junta anexos: os deste aparelho continuam; os que só existem no outro entram como "no Drive". */
function juntarAnexos(locais, remotos, manterLocaisSemRemoto) {
  const mapa = new Map((locais || []).map(a => [a.id, a]));
  const out = (remotos || []).map(a => {
    const x = mapa.get(a.id);
    if (x && !x.removidoLocal) return Object.assign({}, x, { url: a.url || x.url, fileId: a.fileId || x.fileId, legenda: a.legenda !== undefined ? a.legenda : x.legenda, enviado: x.enviado || !!a.url });
    return a.url ? Object.assign({}, a, { enviado: true, removidoLocal: true }) : Object.assign({}, a, { enviado: false, removidoLocal: true, semArquivo: true, noOutro: true });
  });
  if (manterLocaisSemRemoto) (locais || []).forEach(a => { if (!out.some(x => x.id === a.id)) out.push(a); });
  return out;
}

/**
 * Regra de junção:
 * - Sem alteração pendente neste aparelho: vale a versão do servidor.
 * - Com alteração pendente aqui e o servidor também mudou: junta campo a campo. O que foi mudado aqui fica;
 *   o resto vem do servidor. O resultado é enviado na mesma sincronização.
 */
async function mesclarDoServidor(s) {
  const l = S.regs.get(s.id);
  const aberto = S.editor && S.editor.reg.id === s.id && location.hash.startsWith('#/r/');
  if (s.excluido) {
    if (!l || pendente(l)) return false;
    if (aberto) return 'pulado';
    await removerLocal(l); return true;
  }
  delete s.servidorEm;
  const baseServidor = baseDe(s);
  if (l) {
    if (l.base === baseServidor && igual((l.anexos || []).map(a => a.id).sort(), (s.anexos || []).map(a => a.id).sort())) return false;
    if (aberto) return 'pulado';
    if (pendente(l)) {
      if (l.excluido) return false;
      let b = null;
      try { b = l.base ? JSON.parse(l.base) : null; } catch (e) { }
      if (!b) return false; // nunca acertado com o servidor: este aparelho prevalece
      const v = {};
      new Set(Object.keys(l.valores || {}).concat(Object.keys(s.valores || {}))).forEach(k => {
        v[k] = igual((l.valores || {})[k], b.valores[k]) ? (s.valores || {})[k] : l.valores[k];
        if (v[k] === undefined) delete v[k];
      });
      ['secao', 'funcao', 'ghe', 'fase'].forEach(k => { if (igual(l[k] || '', b[k])) l[k] = s[k] || ''; });
      if (s.status === 'concluido') l.status = 'concluido';
      l.valores = v;
      l.anexos = juntarAnexos(l.anexos, s.anexos, true);
      l.base = baseServidor;
      l.versao = Math.max(l.versao || 1, s.versao || 1) + 1;
      l.atualizadoEm = agoraIso();
      await gravarReg(l);
      return true;
    }
  }
  const novo = Object.assign({}, s);
  novo.anexos = juntarAnexos(l && l.anexos, s.anexos, false);
  for (const a of (l && l.anexos) || []) if (!novo.anexos.some(x => x.id === a.id)) { await DB.del('blobs', a.id); urlsObj.delete(a.id); }
  novo.sync = { versao: s.versao, em: agoraIso(), atualizadoEm: s.atualizadoEm };
  novo.base = baseServidor;
  await gravarReg(novo);
  return true;
}

/* ============================= TOPO E ESTADO ============================= */
function atualizarStatus() {
  const b = $('#status');
  const n = qtdPendentes();
  const on = navigator.onLine;
  b.className = 'status ' + (S.sinc ? 'enviando' : on ? (n ? 'pend' : 'ok') : 'off');
  b.textContent = S.sinc ? (S.progresso || 'Enviando...') : (on ? '' : 'Offline · ') + (n ? n + ' a enviar' : 'Tudo enviado');
}

function definirTopo(titulo, comVoltar) {
  $('#titulo').textContent = titulo;
  $('#voltar').hidden = !comVoltar;
  const r0 = location.hash.replace('#/', '').split('/');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', r0[0] === a.dataset.r || (a.dataset.r === 'inicio' && (location.hash === '' || location.hash === '#/'))
    || (a.dataset.g !== undefined && r0[0] === 'g' && r0[1] === a.dataset.g)));
  desenharNavGrupos();
}

async function pedirPersistencia() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) { }
}

/* ================================= TELAS ================================= */
async function rotear() {
  await salvarEditorAgora();
  pararGravacao();
  S.editor = null;
  const rota = (location.hash || '#/').slice(2).split('/');
  const app = $('#app');
  app.innerHTML = '';
  window.scrollTo(0, 0);
  if (rota[0] === 'g' && rota[1]) return telaGrupo(app, Number(rota[1]));
  if (rota[0] === 'f' && rota[1]) return telaFormulario(app, rota[1]);
  if (rota[0] === 'r' && rota[1]) return telaRegistro(app, rota[1]);
  if (rota[0] === 'registros') return telaRegistros(app);
  if (rota[0] === 'ajustes') return telaAjustes(app);
  if (rota[0] === 'docs') return telaDocumentos(app);
  return telaInicio(app);
}

function telaInicio(app) {
  definirTopo('Coletor de Campo', false);
  if (!S.cfg) {
    app.appendChild(h('div', { class: 'cartao destaque' },
      h('h2', { text: 'Primeiro acesso' }),
      h('p', { text: 'Informe o endereço do seu servidor e a chave em Ajustes, e depois toque em "Baixar formulários". Faça isso com internet; depois o app funciona sem sinal.' }),
      h('a', { class: 'bt', href: '#/ajustes', text: 'Ir para Ajustes' })));
    return;
  }
  // Contexto
  const selFil = h('select', { class: 'inp', onchange: async e => {
    let v = e.target.value;
    if (v === '__outra') { v = await perguntar('Código da filial:'); if (!v) { e.target.value = S.ctx.filial; return; } }
    S.ctx.filial = v; await DB.kvSet('ctx', S.ctx); rotear(); sincronizar(false); baixarFuncionarios(v, false);
  } }, h('option', { value: '', text: 'Escolha a filial' }),
    filiais().map(f => h('option', { value: f.codigo, text: f.codigo + ' - ' + (f.nome || f.bandeira) + (f.cidade ? ' (' + f.cidade + ')' : '') })),
    (S.ctx.filial && !filialInfo(S.ctx.filial)) ? h('option', { value: S.ctx.filial, text: S.ctx.filial }) : null,
    h('option', { value: '__outra', text: 'Outra filial...' }));
  selFil.value = S.ctx.filial || '';
  const selFase = h('select', { class: 'inp', onchange: async e => { S.ctx.fase = e.target.value; await DB.kvSet('ctx', S.ctx); } },
    (S.cfg.fases || []).map(f => h('option', { value: f, text: f })));
  selFase.value = S.ctx.fase || '';
  app.appendChild(h('div', { class: 'cartao ctx-ini' },
    h('div', null, h('label', { class: 'rot', text: 'Filial' }), selFil),
    h('div', null, 
h('label', { class: 'rot', text: 'Fase da loja (vale para os próximos registros)' }), selFase)));

  if (S.instalar) app.appendChild(h('button', { class: 'bt larga', text: 'Instalar o app neste aparelho', onclick: async () => { S.instalar.prompt(); S.instalar = null; rotear(); } }));

  // Equipe que já registrou nesta filial
  const equipe = equipeDaFilial();
  if (!S.ajustes.avaliador) app.appendChild(h('div', { class: 'cartao alerta' },
    h('strong', { text: 'Informe seu nome em Ajustes > Avaliador.' }),
    h('p', { class: 'peq', text: 'Quando duas ou mais pessoas trabalham na mesma filial, é o nome que mostra quem fez cada levantamento.' })));
  if (equipe.length) app.appendChild(h('div', { class: 'cartao equipe' },
    h('div', { class: 'eq-cab' }, h('strong', { text: 'Equipe nesta filial' }), h('small', { text: 'Tudo o que cada um registra entra nos mesmos documentos' })),
    h('div', { class: 'eq-lista' }, equipe.map(p => h('div', { class: 'eq-pessoa' + (p.nome === S.ajustes.avaliador ? ' eu' : '') },
      h('span', { class: 'eq-ini', text: iniciais(p.nome) }),
      h('div', null, h('strong', { text: p.nome + (p.nome === S.ajustes.avaliador ? ' (você)' : '') }),
        h('small', { text: p.n + ' registro(s) · ' + p.grupos.map(g => GRUPO_VISUAL(g).curto).join(', ') + ' · último ' + dataHoraBr(p.ultimo) })))))));

  // Menus por grupo (botões coloridos)
  const todos = registrosVisiveis();
  const grade = h('div', { class: 'grade-grupos' });
  gruposForms().forEach((g, i) => {
    const vis = GRUPO_VISUAL(g);
    const fs = formularios().filter(f => f.grupo === g);
    const regs = todos.filter(r => fs.some(f => f.id === r.form && (f.semFilial || r.filial === S.ctx.filial)));
    const rasc = regs.filter(r => r.status !== 'concluido').length;
    const quem = [...new Set(regs.map(r => r.avaliador).filter(Boolean))];
    grade.appendChild(h('a', { class: 'tile cor-' + vis.cor, href: '#/g/' + i },
      h('span', { class: 'tile-ic', text: vis.ic }),
      h('strong', { class: 'tile-tit', text: g }),
      h('small', { class: 'tile-sub', text: fs.length + ' formulário(s)' + (regs.length ? ' · ' + regs.length + ' registro(s)' + (rasc ? ', ' + rasc + ' em rascunho' : '') : '') }),
      quem.length ? h('span', { class: 'tile-quem' }, quem.slice(0, 4).map(n => h('span', { class: 'eq-ini mini', title: n, text: iniciais(n) }))) : null));
  });
  app.appendChild(grade);
}

/* ======================= GRUPOS, CORES E EQUIPE ======================= */
function GRUPO_VISUAL(g) {
  const k = String(g || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (k.includes('prepar')) return { cor: 1, ic: '🧰', curto: 'Preparação' };
  if (k.includes('ambient')) return { cor: 2, ic: '🌡️', curto: 'Ambientais' };
  if (k.includes('insalub') || k.includes('pericul')) return { cor: 3, ic: '⚠️', curto: 'Insalubridade' };
  if (k.includes('ergonom')) return { cor: 4, ic: '🧍', curto: 'Ergonomia' };
  if (k.includes('requisit')) return { cor: 5, ic: '📋', curto: 'Requisitos' };
  if (k.includes('particip')) return { cor: 6, ic: '👥', curto: 'Participação' };
  return { cor: 7, ic: '📁', curto: g };
}
function gruposForms() { const g = []; formularios().forEach(f => { if (!g.includes(f.grupo)) g.push(f.grupo); }); return g; }
function iniciais(n) { const p = String(n || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
function equipeDaFilial() {
  const m = new Map();
  registrosVisiveis().forEach(r => {
    const f = form(r.form);
    if (!f || f.semFilial || r.filial !== S.ctx.filial || !r.avaliador) return;
    const p = m.get(r.avaliador) || { nome: r.avaliador, n: 0, ultimo: '', grupos: [] };
    p.n++; if (r.atualizadoEm > p.ultimo) p.ultimo = r.atualizadoEm;
    if (!p.grupos.includes(f.grupo)) p.grupos.push(f.grupo);
    m.set(r.avaliador, p);
  });
  return [...m.values()].sort((a, b) => b.ultimo.localeCompare(a.ultimo));
}
function desenharNavGrupos() {
  let box = $('#nav-grupos');
  if (!box) { box = h('div', { id: 'nav-grupos' }); $('#nav a[data-r="inicio"]').after(box); }
  const gs = S.cfg ? gruposForms() : [];
  if (box.dataset.chave === gs.join('|')) return;
  box.dataset.chave = gs.join('|'); box.innerHTML = '';
  gs.forEach((g, i) => { const v = GRUPO_VISUAL(g); box.appendChild(h('a', { href: '#/g/' + i, class: 'nav-g cor-' + v.cor, 'data-g': String(i) }, h('i'), v.curto)); });
  const r0 = location.hash.replace('#/', '').split('/');
  box.querySelectorAll('a').forEach(a => a.classList.toggle('on', r0[0] === 'g' && r0[1] === a.dataset.g));
}

function telaGrupo(app, i) {
  const g = gruposForms()[i];
  if (!g) { location.hash = '#/'; return; }
  const vis = GRUPO_VISUAL(g);
  definirTopo(g, true);
  app.appendChild(h('div', { class: 'faixa-grupo cor-' + vis.cor },
    h('span', { class: 'tile-ic', text: vis.ic }),
    h('div', null, h('strong', { text: g }), h('small', { text: 'Filial ' + (S.ctx.filial || '(não escolhida)') + ' · ' + (S.ctx.fase || '') }))));
  const todos = registrosVisiveis();
  const lista = h('div', { class: 'lista-forms' });
  formularios().filter(f => f.grupo === g).forEach(f => {
    const regs = todos.filter(r => r.form === f.id && (f.semFilial || r.filial === S.ctx.filial));
    const pend = regs.filter(pendente).length;
    const quem = [...new Set(regs.map(r => r.avaliador).filter(Boolean))];
    lista.appendChild(h('a', { class: 'item-form cor-' + vis.cor, href: '#/f/' + f.id },
      h('div', { class: 'if-txt' }, h('strong', { text: f.titulo }), h('small', { text: f.ref || '' }),
        quem.length ? h('small', { class: 'if-quem', text: 'Por: ' + quem.join(', ') }) : null),
      h('div', { class: 'if-n' }, regs.length ? h('span', { class: 'bolha' + (pend ? ' pend' : ''), text: String(regs.length) }) : null)));
  });
  app.appendChild(lista);
}

function resumoRegistro(r) {
  const f = form(r.form);
  let t = '';
  if (f) for (const tipo of ['texto', 'selecao']) {
    const c = f.campos.find(c => c.tipo === tipo && !c.pessoal && !c.se && r.valores && r.valores[c.id]);
    if (c) { t = String(r.valores[c.id]); break; }
  }
  return [r.funcao || r.secao, t].filter(Boolean).join(' · ') || (f ? f.titulo : r.form);
}

function linhaRegistro(r, mostrarForm) {
  const f = form(r.form);
  return h('a', { class: 'item-reg', href: '#/r/' + r.id },
    h('div', { class: 'ir-txt' },
      h('strong', { text: resumoRegistro(r) }),
      h('small', { text: [mostrarForm && f ? f.titulo : '', r.filial ? 'Filial ' + r.filial : '', dataHoraBr(r.atualizadoEm)].filter(Boolean).join(' · ') }),
      r.avaliador ? h('small', { class: 'ir-quem' }, h('span', { class: 'eq-ini mini', text: iniciais(r.avaliador) }), r.avaliador) : null),
    h('div', { class: 'ir-tags' },
      h('span', { class: 'tag ' + (r.status === 'concluido' ? 'ok' : 'rasc'), text: r.status === 'concluido' ? 'Concluído' : 'Rascunho' }),
      h('span', { class: 'tag ' + (pendente(r) ? 'pend' : 'env'), text: pendente(r) ? 'A enviar' : 'Enviado' })));
}

function telaFormulario(app, id) {
  const f = form(id);
  if (!f) { location.hash = '#/'; return; }
  definirTopo(f.titulo, true);
  app.appendChild(h('div', { class: 'cartao faixa-cor cor-' + GRUPO_VISUAL(f.grupo).cor },
    h('div', { class: 'ref', text: f.ref || '' }),
    f.semFilial ? null : h('div', { class: 'ctx-linha', text: 'Filial ' + (S.ctx.filial || '(não escolhida)') + ' · ' + (S.ctx.fase || '') }),
    h('button', { class: 'bt larga', text: '+ Novo registro', onclick: () => novoRegistro(f.id) })));
  const regs = registrosVisiveis().filter(r => r.form === f.id && (f.semFilial || r.filial === S.ctx.filial))
    .sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
  if (!regs.length) app.appendChild(h('p', { class: 'vazio', text: 'Nenhum registro ainda.' }));
  const l = h('div', { class: 'lista-regs' });
  regs.forEach(r => l.appendChild(linhaRegistro(r, false)));
  app.appendChild(l);
}

function telaRegistros(app) {
  definirTopo('Registros', false);
  let filtro = 'todos';
  const lista = h('div', { class: 'lista-regs' });
  function desenhar() {
    lista.innerHTML = '';
    let regs = registrosVisiveis();
    if (filtro === 'pend') regs = regs.filter(pendente);
    if (filtro === 'rasc') regs = regs.filter(r => r.status !== 'concluido');
    regs.sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
    if (!regs.length) lista.appendChild(h('p', { class: 'vazio', text: 'Nada por aqui.' }));
    regs.forEach(r => lista.appendChild(linhaRegistro(r, true)));
  }
  const chipsF = h('div', { class: 'chips' });
  [['todos', 'Todos'], ['pend', 'A enviar'], ['rasc', 'Rascunhos']].forEach(([k, t]) => {
    chipsF.appendChild(h('button', { class: 'chip' + (k === filtro ? ' on' : ''), text: t, onclick: e => {
      filtro = k; chipsF.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); e.target.classList.add('on'); desenhar();
    } }));
  });
  app.appendChild(h('div', { class: 'cartao' }, chipsF,
    h('button', { class: 'bt larga', text: 'Sincronizar agora (enviar e receber)', onclick: () => sincronizar(true) })));
  app.appendChild(lista);
  desenhar();
}

async function telaAjustes(app) {
  definirTopo('Ajustes', false);
  const url = h('input', { class: 'inp', value: S.ajustes.url, placeholder: 'https://script.google.com/macros/s/.../exec', autocomplete: 'off' });
  const chave = h('input', { class: 'inp', value: S.ajustes.chave, type: 'password', autocomplete: 'off' });
  const aval = h('input', { class: 'inp', value: S.ajustes.avaliador, placeholder: 'Nome que aparece nos registros' });
  async function salvar() {
    S.ajustes = Object.assign({}, S.ajustes, { url: url.value.trim(), chave: chave.value.trim(), avaliador: aval.value.trim() });
    await DB.kvSet('ajustes', S.ajustes);
  }
  app.appendChild(h('div', { class: 'cartao' },
    h('h3', { text: 'Servidor' }),
    h('label', { class: 'rot', text: 'Endereço do servidor (termina em /exec)' }), url,
    h('label', { class: 'rot', text: 'Chave' }), h('div', { class: 'linha-inp' }, chave,
      h('button', { class: 'bt sec mini', text: 'ver', onclick: () => { chave.type = chave.type === 'password' ? 'text' : 'password'; } })),
    h('label', { class: 'rot', text: 'Avaliador' }), aval,
    flagCarimbo(),
    h('div', { class: 'linha-bts' },
      h('button', { class: 'bt sec', text: 'Testar conexão', onclick: async () => {
        await salvar();
        try { const j = await api({ acao: 'ping' }); toast('Conectado. Servidor versão ' + j.versao + '.'); } catch (e) { toast(e.message, 6000); }
      } }),
      h('button', { class: 'bt', text: 'Baixar formulários', onclick: async () => { await salvar(); if (await baixarConfig(false)) location.hash = '#/'; } }))));

  // Dados da filial: QL e funcionários
  const fLocal = S.ctx.filial ? await funcionariosLocais(S.ctx.filial) : null;
  const inpQL = h('input', { type: 'file', accept: '.csv,.txt,text/csv', hidden: true, onchange: e => { importarArquivoFilial('QL', e.target.files[0]); e.target.value = ''; } });
  const inpFu = h('input', { type: 'file', accept: '.csv,.txt,text/csv', hidden: true, onchange: e => { importarArquivoFilial('FUNC', e.target.files[0]); e.target.value = ''; } });
  app.appendChild(h('div', { class: 'cartao' },
    h('h3', { text: 'Dados da filial' }),
    h('p', { class: 'peq', text: 'Envie o arquivo CSV exportado do sistema. Antes de gravar aparece um resumo do que muda, e só a filial escolhida (ou as filiais do arquivo) é trocada.' }),
    h('p', { class: 'peq', text: 'Quadro de lotação: colunas FILIAL, DESC_SECAO, NOME_FUNCAO e ALOCADOS (as mesmas do QL que já usa). Funcionários: REGIONAL, BANDEIRA, FILIAL, NOME, FUNÇÃO, SEÇÃO e MATRICULA.' }),
    h('div', { class: 'linha-bts' },
      h('label', { class: 'bt sec' }, '📊 Atualizar QL (CSV)', inpQL),
      h('label', { class: 'bt sec' }, '👥 Atualizar funcionários (CSV)', inpFu),
      h('label', { class: 'bt sec' }, '📋 Atualizar descrições das funções (CSV)', h('input', { type: 'file', accept: '.csv,.txt,text/csv', hidden: true, onchange: e => { importarArquivoFilial('DESC', e.target.files[0]); e.target.value = ''; } }))),
    h('p', { class: 'peq', text: 'Descrições das funções (do PGR) no app: ' + (((S.cfg && S.cfg.listas && S.cfg.listas.descricoes) || []).length) + '. Elas preenchem a "Tarefa prescrita" ao escolher a função.' }),
    h('p', { class: 'peq', text: S.ctx.filial ? ('Funcionários da filial ' + S.ctx.filial + ' neste aparelho: ' + (fLocal && fLocal.lista ? fLocal.lista.length + ' (baixado ' + dataHoraBr(fLocal.baixadoEm) + ')' : 'nenhum')) : 'Escolha a filial na tela inicial.' }),
    h('div', { class: 'linha-bts' },
      S.ctx.filial ? h('button', { class: 'bt sec', text: 'Baixar lista de funcionários', onclick: async () => { await baixarFuncionarios(S.ctx.filial, true); rotear(); } }) : null,
      h('button', { class: 'bt perigo', text: 'Apagar listas de funcionários deste aparelho', onclick: async () => {
        if (!(await confirmar('Apagar deste aparelho as listas de funcionários baixadas? Os registros e assinaturas não são apagados.', 'Apagar'))) return;
        await apagarFuncionariosLocais(); toast('Listas apagadas deste aparelho.'); rotear();
      } }))));

  // Aparência (modo escuro)
  const temaAtual = S.ajustes.tema || 'auto';
  const chipsTema = chips(['Claro', 'Escuro', 'Automático'], { claro: 'Claro', escuro: 'Escuro', auto: 'Automático' }[temaAtual], false, async v => {
    S.ajustes.tema = { 'Claro': 'claro', 'Escuro': 'escuro', 'Automático': 'auto' }[v] || 'auto';
    await DB.kvSet('ajustes', S.ajustes); aplicarTema();
  });
  app.appendChild(h('div', { class: 'cartao' },
    h('h3', { text: 'Aparência' }),
    h('p', { class: 'peq', text: 'Modo escuro para avaliações à noite ou em locais com pouca luz. Automático segue o modo do celular ou do computador.' }),
    chipsTema));

  // Sincronização entre aparelhos
  const ultRec = await DB.kvGet('ultimaRecepcao');
  const chkTodas = h('input', { type: 'checkbox', checked: !!S.ajustes.receberTodas, onchange: async e => { S.ajustes.receberTodas = e.target.checked; await DB.kvSet('ajustes', S.ajustes); } });
  app.appendChild(h('div', { class: 'cartao' },
    h('h3', { text: 'Celular e computador' }),
    h('p', { class: 'peq', text: 'O que você faz em um aparelho chega ao outro quando os dois sincronizam com internet: enviando aqui e abrindo lá (ou tocando no botão do topo). Rascunhos também passam. Fotos e áudios feitos no outro aparelho aparecem como "no Drive" e abrem pelo link.' }),
    h('p', { class: 'peq', text: 'Última recepção: ' + (ultRec ? dataHoraBr(ultRec) : 'nunca') + '. Recebendo: ' + (S.ajustes.receberTodas ? 'todas as filiais.' : 'filial escolhida na tela inicial' + (S.ctx.filial ? ' (' + S.ctx.filial + ').' : ' (nenhuma escolhida).')) }),
    h('label', { class: 'flag' }, chkTodas, 'Receber registros de todas as filiais'),
    h('div', { class: 'linha-bts' },
      h('button', { class: 'bt sec', text: 'Sincronizar agora', onclick: () => sincronizar(true) }),
      h('button', { class: 'bt sec', text: 'Receber tudo de novo', onclick: async () => { await DB.kvSet(chaveRecepcao(), 0); sincronizar(true); } }))));

  // Armazenamento
  let uso = '';
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); uso = tamanho(e.usage || 0) + ' usados de ' + tamanho(e.quota || 0); } } catch (e) { }
  let persist = false;
  try { persist = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { }
  const nEnviados = [...S.regs.values()].reduce((s, r) => s + (r.anexos || []).filter(a => a.enviado).length, 0);
  const grandes = [...S.regs.values()].flatMap(r => (r.anexos || []).filter(a => a.grande).map(a => ({ r, a })));
  app.appendChild(h('div', { class: 'cartao' },
    h('h3', { text: 'Dados no celular' }),
    h('p', { class: 'peq', text: 'Espaço: ' + (uso || 'não informado') + '. Proteção contra limpeza automática: ' + (persist ? 'ativa' : 'não ativa') + '.' }),
    h('div', { class: 'linha-bts col' },
      h('button', { class: 'bt sec', text: 'Exportar cópia de segurança (arquivo)', onclick: exportarBackup }),
      h('label', { class: 'bt sec' }, 'Importar cópia de segurança',
        h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: e => importarBackup(e.target.files[0]) })),
      h('button', { class: 'bt sec', text: 'Liberar espaço (apagar do celular ' + nEnviados + ' arquivo(s) já enviados)', disabled: !nEnviados, onclick: liberarEspaco })),
    grandes.length ? h('div', null, h('p', { class: 'peq', text: 'Arquivos grandes demais para envio automático. Baixe e coloque na pasta do Drive manualmente:' }),
      grandes.map(({ a }) => h('button', { class: 'bt sec mini', text: a.nome + ' (' + tamanho(a.tamanho) + ')', onclick: () => baixarAnexo(a) }))) : null));

  app.appendChild(h('div', { class: 'cartao' },
    h('h3', { text: 'Aplicativo' }),
    h('p', { class: 'peq', text: 'Versão ' + VERSAO_APP + (S.cfg ? ' · formulários de ' + dataHoraBr(S.cfg.geradoEm) : '') }),
    h('button', { class: 'bt sec', text: 'Procurar atualização do app', onclick: async () => {
      try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); toast('Verificado. Se houver versão nova, aparecerá um aviso no topo.'); } catch (e) { toast('Sem conexão.'); }
    } })));
}

async function baixarAnexo(a) {
  const b = await DB.get('blobs', a.id);
  if (!b) { toast('Arquivo não está mais no celular.'); return; }
  const u = URL.createObjectURL(b.blob);
  const l = h('a', { href: u, download: a.nome });
  document.body.appendChild(l); l.click(); l.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}

async function exportarBackup() {
  toast('Preparando a cópia...', 8000);
  const partes = ['{"app":"coletor","versao":"' + VERSAO_APP + '","geradoEm":"' + agoraIso() + '","registros":'];
  const regs = [...S.regs.values()];
  partes.push(JSON.stringify(regs), ',"arquivos":{');
  let primeiro = true;
  for (const r of regs) for (const a of r.anexos || []) {
    const b = await DB.get('blobs', a.id);
    if (!b) continue;
    partes.push((primeiro ? '' : ',') + JSON.stringify(a.id) + ':' + JSON.stringify({ mime: b.blob.type, b64: await blobParaBase64(b.blob) }));
    primeiro = false;
  }
  partes.push('}}');
  const blob = new Blob(partes, { type: 'application/json' });
  const u = URL.createObjectURL(blob);
  const l = h('a', { href: u, download: 'coletor-copia-' + carimboArquivo() + '.json' });
  document.body.appendChild(l); l.click(); l.remove();
  setTimeout(() => URL.revokeObjectURL(u), 30000);
  toast('Cópia salva em Downloads (' + tamanho(blob.size) + ').');
}

async function importarBackup(arq) {
  if (!arq) return;
  try {
    const j = JSON.parse(await arq.text());
    let n = 0;
    for (const r of j.registros || []) {
      const atual = S.regs.get(r.id);
      if (atual && atual.versao >= r.versao) continue;
      for (const a of r.anexos || []) {
        const d = j.arquivos && j.arquivos[a.id];
        if (d) {
          const bytes = Uint8Array.from(atob(d.b64), ch => ch.charCodeAt(0));
          await DB.put('blobs', { id: a.id, blob: new Blob([bytes], { type: d.mime }) });
        }
      }
      await gravarReg(r); n++;
    }
    toast(n + ' registro(s) restaurado(s).');
    rotear();
  } catch (e) { toast('Arquivo inválido: ' + e.message, 6000); }
}

async function liberarEspaco() {
  if (!(await confirmar('Apagar do celular os arquivos que já estão no Drive? Os registros continuam aqui; as miniaturas deixam de aparecer.', 'Apagar'))) return;
  let n = 0;
  for (const r of S.regs.values()) {
    for (const a of r.anexos || []) if (a.enviado && !a.removidoLocal) { await DB.del('blobs', a.id); urlsObj.delete(a.id); a.removidoLocal = true; n++; }
    await DB.put('registros', r);
  }
  toast(n + ' arquivo(s) apagado(s) do celular.');
  rotear();
}


/* =============================== DOCUMENTOS =============================== */
function nomeCurtoArquivo(n) { return String(n || '').replace(/\.(docx|pdf)$/i, ''); }

async function telaDocumentos(app) {
  definirTopo('Documentos', false);
  const fil = S.ctx.filial;
  if (!S.cfg || !fil) {
    app.appendChild(h('div', { class: 'cartao destaque' }, h('p', { text: 'Escolha a filial na tela inicial.' }), h('a', { class: 'bt', href: '#/', text: 'Ir para o início' })));
    return;
  }
  const chaveCache = 'docs:' + fil;
  let dados = await DB.kvGet(chaveCache);
  const sel = new Set();
  const caixaSit = h('div', { class: 'cartao' });
  const caixaGerar = h('div', { class: 'cartao' });
  const caixaDocs = h('div', { class: 'cartao' });
  app.appendChild(caixaSit); app.appendChild(caixaGerar); app.appendChild(caixaDocs);

  function desenhar() {
    // Situação da filial
    caixaSit.innerHTML = '';
    caixaSit.appendChild(h('h3', { text: 'Filial ' + fil }));
    if (!dados) caixaSit.appendChild(h('p', { class: 'peq', text: navigator.onLine ? 'Carregando a situação da filial...' : 'Sem internet. Os documentos são gerados no servidor: conecte para usar esta tela.' }));
    else {
      const p = dados.pendencias || {}, r = dados.requisitos || {};
      caixaSit.appendChild(h('p', { class: 'peq', text: 'Atualizado em ' + dataHoraBr(dados.em) + ' · política: ' + (dados.politica || '') }));
      caixaSit.appendChild(h('div', { class: 'resumo-docs' },
        h('div', { class: 'rd ' + (p.total ? 'pend' : 'ok') }, h('strong', { text: String(p.total || 0) }), h('span', { text: 'pendências de campo' })),
        h('div', { class: 'rd ok' }, h('strong', { text: String(r['Atende'] || 0) }), h('span', { text: 'itens da NR-17 atendidos' })),
        h('div', { class: 'rd ' + (r['Não atende'] ? 'nc' : 'ok') }, h('strong', { text: String(r['Não atende'] || 0) }), h('span', { text: 'não atendidos (vão ao plano)' })),
        h('div', { class: 'rd ' + (r['Sem evidência'] ? 'pend' : 'ok') }, h('strong', { text: String(r['Sem evidência'] || 0) }), h('span', { text: 'sem evidência' }))));
      if ((dados.pendenciasLista || []).length) {
        const det = h('details', { class: 'pend-lista' }, h('summary', { text: 'Ver o que falta coletar (' + dados.pendenciasLista.length + ')' }),
          h('ul', null, dados.pendenciasLista.map(x => h('li', null, h('strong', { text: (x.secao && x.secao !== '-' ? x.secao + ' · ' : '') + x.funcao }), h('br'), x.pendencia, x.oQueFazer ? h('div', { class: 'peq', text: x.oQueFazer }) : null))));
        caixaSit.appendChild(det);
      }
    }
    caixaSit.appendChild(h('button', { class: 'bt sec larga', text: 'Atualizar situação', onclick: () => carregar(true) }));

    // Gerar
    caixaGerar.innerHTML = '';
    caixaGerar.appendChild(h('h3', { text: 'Gerar' }));
    const inpEmissao = h('input', { class: 'inp curto-data', type: 'date', value: hojeIso(), max: hojeIso() });
    caixaGerar.appendChild(h('div', { class: 'linha-emissao' }, h('label', { class: 'rot', text: 'Data de emissão do documento' }), inpEmissao,
      h('p', { class: 'peq', text: 'Vai na capa, na identificação e na assinatura. O período do levantamento continua sendo o das visitas registradas.' })));
    const emissao = () => {
      const v = inpEmissao.value;
      if (!v) return hojeIso();
      if (v > hojeIso()) { toast('A data de emissão não pode ser futura.'); return null; }
      return v;
    };
    caixaGerar.appendChild(h('button', { class: 'bt larga', text: 'Gerar AET da filial', onclick: () => { const d = emissao(); if (d) gerar({ tipo: 'AET', dataEmissao: d }); } }));
    const secoes = (dados && dados.secoes && dados.secoes.length) ? dados.secoes : secoesDe(fil);
    const selSec = h('select', { class: 'inp' }, h('option', { value: '', text: 'Escolha a seção' }), secoes.map(x => h('option', { value: x, text: x })));
    const recortes = (dados && dados.recortes) || ['Completo', 'Ergonomia', 'Conforto ambiental', 'Não conformidades e plano de ação'];
    const selRec = h('select', { class: 'inp' }, recortes.map((x, i) => h('option', { value: String(i), text: x })));
    caixaGerar.appendChild(h('label', { class: 'rot', text: 'Relatório de uma seção' }));
    caixaGerar.appendChild(h('div', { class: 'linha-sel' }, selSec, selRec));
    caixaGerar.appendChild(h('button', { class: 'bt sec larga', text: 'Gerar relatório da seção', onclick: () => {
      if (!selSec.value) { toast('Escolha a seção.'); return; }
      const d = emissao(); if (!d) return;
      gerar({ tipo: 'SECAO', secao: selSec.value, recorte: Number(selRec.value), dataEmissao: d });
    } }));
    caixaGerar.appendChild(h('p', { class: 'peq', text: 'Antes de gerar, o app envia o que estiver pendente neste aparelho. A geração leva de 1 a 3 minutos.' }));

    // Documentos gerados
    caixaDocs.innerHTML = '';
    caixaDocs.appendChild(h('h3', { text: 'Documentos gerados' }));
    const docs = (dados && dados.documentos) || [];
    if (!docs.length) caixaDocs.appendChild(h('p', { class: 'peq', text: 'Nenhum documento gerado ainda para esta filial.' }));
    const lista = h('div', { class: 'lista-docs' });
    docs.forEach(d => {
      const pdf = /pdf/i.test(d.mime) || /\.pdf$/i.test(d.nome);
      const chk = h('input', { type: 'checkbox', checked: sel.has(d.id), onchange: e => { e.target.checked ? sel.add(d.id) : sel.delete(d.id); atualizarBtEmail(); } });
      lista.appendChild(h('div', { class: 'item-doc' },
        h('label', { class: 'doc-sel' }, chk),
        h('div', { class: 'doc-txt' }, h('strong', { text: nomeCurtoArquivo(d.nome) }), h('small', { text: (pdf ? 'PDF' : 'Word') + ' · ' + dataHoraBr(d.em) + (d.tamanho ? ' · ' + tamanho(d.tamanho) : '') })),
        h('div', { class: 'doc-bts' },
          h('button', { class: 'bt sec mini', text: 'Compartilhar', onclick: () => compartilharDoc(d) }),
          h('a', { class: 'bt sec mini', href: d.url, target: '_blank', rel: 'noopener', text: 'Abrir' }))));
    });
    caixaDocs.appendChild(lista);
    const btEmail = h('button', { class: 'bt larga', text: 'Enviar selecionados por e-mail', onclick: () => enviarEmail(docs.filter(d => sel.has(d.id))) });
    caixaDocs.appendChild(btEmail);
    function atualizarBtEmail() { btEmail.disabled = !sel.size; btEmail.textContent = sel.size ? 'Enviar ' + sel.size + ' documento(s) por e-mail' : 'Marque os documentos para enviar por e-mail'; }
    atualizarBtEmail();
  }

  async function carregar(manual) {
    if (!navigator.onLine) { if (manual) toast('Sem internet.'); desenhar(); return; }
    if (manual) toast('Atualizando a situação da filial...', 15000);
    try {
      const j = await api({ acao: 'docs-preparar', filial: fil }, 180000);
      dados = Object.assign(j, { em: agoraIso() });
      await DB.kvSet(chaveCache, dados);
      if (manual) toast('Situação atualizada.');
    } catch (e) { toast(e.message, 7000); }
    if (location.hash.startsWith('#/docs')) desenhar();
  }

  async function gerar(o) {
    if (!navigator.onLine) { toast('Sem internet. A geração é feita no servidor.'); return; }
    await salvarEditorAgora();
    if (qtdPendentes()) { toast('Enviando o que está pendente neste aparelho...', 20000); await sincronizar(false); }
    if (qtdPendentes() && !(await confirmar(qtdPendentes() + ' registro(s) deste aparelho ainda não foram enviados e não entrarão no documento. Gerar mesmo assim?', 'Gerar'))) return;
    const p = dados && dados.pendencias;
    if (o.tipo === 'AET' && p && p.total && !(await confirmar('Há ' + p.total + ' pendência(s) de campo (' + (p.semLevantamento || 0) + ' funções sem levantamento, ' + (p.semAtividade || 0) + ' sem análise da atividade, ' +
      (p.semEvidencia || 0) + ' itens da NR-17 sem evidência). Os itens sem evidência entram como "Não evidenciado", com ação de 30 dias. Gerar a AET mesmo assim?', 'Gerar AET'))) return;
    const aviso = modal(h('div', null, h('h3', { text: o.tipo === 'AET' ? 'Gerando a AET' : 'Gerando o relatório' }),
      h('p', { class: 'modal-txt', text: 'Isso leva de 1 a 3 minutos. Mantenha o app aberto e a internet ligada.' }), h('div', { class: 'girando' })), { semFechar: true });
    try {
      const j = await api(Object.assign({ acao: 'docs-gerar', filial: fil }, o), 340000);
      dados = Object.assign({}, dados || {}, { documentos: j.documentos, em: agoraIso() });
      await DB.kvSet(chaveCache, dados);
      aviso();
      toast(j.mensagem, 8000);
      sel.clear();
      // marca o documento recém-gerado (o PDF, se houver) para enviar
      const recentes = (j.documentos || []).filter(d => Date.now() - new Date(d.em).getTime() < 10 * 60000).slice(0, 2);
      const pdf = recentes.find(d => /pdf/i.test(d.mime));
      if (pdf) sel.add(pdf.id); else if (recentes[0]) sel.add(recentes[0].id);
      desenhar();
    } catch (e) { aviso(); toast('Não foi possível gerar: ' + e.message, 9000); }
  }

  async function baixarDoc(d) {
    const j = await api({ acao: 'docs-baixar', filial: fil, id: d.id }, 180000);
    const bytes = Uint8Array.from(atob(j.base64), ch => ch.charCodeAt(0));
    return new File([bytes], j.nome, { type: j.mime });
  }

  async function compartilharDoc(d) {
    toast('Baixando ' + nomeCurtoArquivo(d.nome) + '...', 20000);
    try {
      const arq = await baixarDoc(d);
      if (navigator.canShare && navigator.canShare({ files: [arq] })) {
        $('#toast').hidden = true;
        try { await navigator.share({ files: [arq], title: nomeCurtoArquivo(d.nome) }); } catch (e) { if (e.name !== 'AbortError') throw e; }
      } else {
        const u = URL.createObjectURL(arq);
        const l = h('a', { href: u, download: arq.name });
        document.body.appendChild(l); l.click(); l.remove();
        setTimeout(() => URL.revokeObjectURL(u), 30000);
        toast('Arquivo salvo em Downloads.');
      }
    } catch (e) { toast(e.message, 7000); }
  }

  async function enviarEmail(docs) {
    if (!docs.length) return;
    const ult = (await DB.kvGet('emailUltimo')) || {};
    const para = h('input', { class: 'inp', type: 'email', multiple: true, value: ult.para || '', placeholder: 'email@exemplo.com (separe vários com vírgula)' });
    const assunto = h('input', { class: 'inp', value: (docs.length === 1 ? nomeCurtoArquivo(docs[0].nome) : 'Documentos de ergonomia (NR-17) - filial ' + fil) });
    const msg = h('textarea', { class: 'inp', rows: 6 });
    msg.value = 'Prezados,\n\nSeguem em anexo os documentos de ergonomia (NR-17) da filial ' + fil + ':\n' + docs.map(d => '- ' + d.nome).join('\n') + '\n\nAtenciosamente,\n' + (S.ajustes.avaliador || '');
    const copia = h('input', { type: 'checkbox', checked: ult.copia !== false });
    let fechar;
    const enviar = h('button', { class: 'bt', text: 'Enviar', onclick: async () => {
      if (!para.value.trim()) { toast('Informe o e-mail.'); return; }
      enviar.disabled = true; enviar.textContent = 'Enviando...';
      try {
        const j = await api({ acao: 'docs-email', filial: fil, ids: docs.map(d => d.id), para: para.value, assunto: assunto.value, mensagem: msg.value, copia: copia.checked, remetente: S.ajustes.avaliador || 'SST' }, 180000);
        await DB.kvSet('emailUltimo', { para: para.value, copia: copia.checked });
        fechar(); toast(j.mensagem, 7000);
      } catch (e) { enviar.disabled = false; enviar.textContent = 'Enviar'; toast(e.message, 8000); }
    } });
    fechar = modal(h('div', null, h('h3', { text: 'Enviar por e-mail' }),
      h('p', { class: 'peq', text: 'Sai da conta do Google do servidor' + (dados && dados.emailConta ? ' (' + dados.emailConta + ')' : '') + ', com ' + docs.length + ' anexo(s).' }),
      h('label', { class: 'rot', text: 'Para' }), para,
      h('label', { class: 'rot', text: 'Assunto' }), assunto,
      h('label', { class: 'rot', text: 'Mensagem' }), msg,
      h('label', { class: 'flag' }, copia, 'Enviar cópia para mim'),
      h('div', { class: 'linha-bts' }, h('button', { class: 'bt sec', text: 'Cancelar', onclick: () => fechar() }), enviar)));
  }

  desenhar();
  carregar(false);
}

/* ================================= EDITOR ================================= */
async function salvarEditorAgora() {
  const E = S.editor;
  if (!E || !E.sujo) return;
  E.sujo = false;
  clearTimeout(E.timer);
  E.reg.atualizadoEm = agoraIso();
  E.reg.versao = (E.reg.versao || 1) + 1;
  await gravarReg(E.reg);
  atualizarStatus();
}

function alterou() {
  const E = S.editor;
  if (!E) return;
  E.sujo = true;
  clearTimeout(E.timer);
  E.timer = setTimeout(salvarEditorAgora, 700);
  atualizarVisibilidade();
  E.calculados = E.calculados.filter(x => x.el.isConnected || !x.visto);
  E.calculados.forEach(x => { if (x.el.isConnected) { x.visto = true; x.render(); } });
  if (E.marcaSalvo) E.marcaSalvo.textContent = 'Salvando...';
  clearTimeout(E.timer2);
  E.timer2 = setTimeout(() => { if (E.marcaSalvo) E.marcaSalvo.textContent = 'Salvo neste aparelho'; }, 900);
}

function condicaoOk(se, escopo) {
  if (!se) return true;
  const v = escopo[se.campo];
  if (se.valores) return Array.isArray(v) ? v.some(x => se.valores.includes(x)) : se.valores.includes(v);
  return Array.isArray(v) ? v.includes(se.valor) : v === se.valor;
}

function atualizarVisibilidade() {
  const E = S.editor;
  if (!E) return;
  // remove só os campos que já estiveram na tela e saíram (ex.: item de grupo removido)
  E.condicionais = E.condicionais.filter(x => { if (x.el.isConnected) { x.visto = true; return true; } return !x.visto; });
  E.condicionais.forEach(x => { x.el.hidden = !condicaoOk(x.c.se, x.escopo); });
}

function vazio(c, v) {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (c.tipo === 'cronometro') return !(v.voltas && v.voltas.length);
  if (c.tipo === 'gps') return !v.lat;
  if (c.tipo === 'goniometro') return !v.anexo;
  if (c.tipo === 'resultado') return false;
  return false;
}

function faltantes(campos, escopo, prefixo) {
  const out = [];
  campos.forEach(c => {
    if (c.tipo === 'info' || !condicaoOk(c.se, escopo)) return;
    const v = escopo[c.id];
    if (c.obrig && vazio(c, v)) out.push(prefixo + c.rotulo);
    if (c.tipo === 'grupo' && Array.isArray(v)) v.forEach((it, i) => out.push(...faltantes(c.campos, it, prefixo + c.rotulo + ' ' + (i + 1) + ': ')));
  });
  return out;
}

async function telaRegistro(app, id) {
  const reg = S.regs.get(id);
  if (!reg || reg.excluido) { location.hash = '#/registros'; return; }
  const f = form(reg.form);
  if (!f) { app.appendChild(h('p', { class: 'vazio', text: 'Formulário não encontrado. Baixe os formulários em Ajustes.' })); return; }
  definirTopo(f.titulo, true);
  const E = { reg, f, sujo: false, condicionais: [], dependentes: [], calculados: [] };
  S.editor = E;

  // Cabeçalho do registro
  const marca = h('span', { class: 'salvo', text: 'Salvo neste aparelho' });
  E.marcaSalvo = marca;
  app.appendChild(h('div', { class: 'cartao fino cab-reg faixa-cor cor-' + GRUPO_VISUAL(f.grupo).cor },
    h('div', { class: 'cab-txt' },
      h('div', { class: 'ref', text: f.ref || '' }),
      h('div', { class: 'ctx-linha' }, (reg.filial ? 'Filial ' + reg.filial + ' · ' : '') + (reg.avaliador ? 'Por ' + reg.avaliador + ' · ' : '') + 'Criado ' + dataHoraBr(reg.criadoEm) + ' · ', marca)),
    h('div', { class: 'cab-bts' },
      h('button', { class: 'bt sec pequeno', title: 'Duplicar este registro', text: '⧉ Duplicar', onclick: async () => { await salvarEditorAgora(); duplicarRegistro(reg); } }),
      h('button', { class: 'bt perigo pequeno', title: 'Excluir este registro', text: '🗑 Excluir', onclick: async () => { await salvarEditorAgora(); if (await excluirRegistro(reg)) history.back(); } }))));

  // Contexto: fase, seção, função, GHE
  const ctx = f.contexto || {};
  const cartaoCtx = h('div', { class: 'cartao ctx-reg' });
  if (!f.semFilial) {
    const selFase = h('select', { class: 'inp', onchange: e => { reg.fase = e.target.value; alterou(); } },
      ((S.cfg && S.cfg.fases) || []).map(x => h('option', { value: x, text: x })));
    selFase.value = reg.fase || '';
    cartaoCtx.appendChild(h('label', { class: 'rot', text: 'Fase da loja' }));
    cartaoCtx.appendChild(selFase);
  }
  if (ctx.secao) {
    const info = h('div', { class: 'peq' });
    const selFun = h('select', { class: 'inp' });
    if (reg.secao) { const g0 = gheDe(reg.filial, reg.secao); if (g0 && g0 !== reg.ghe) { reg.ghe = g0; E.sujo = true; } }
    const inpGhe = h('input', { class: 'inp', value: reg.ghe || '', placeholder: 'automático pela seção', readonly: true, tabindex: -1, title: 'Numerado sozinho: seções da filial em ordem alfabética' });
    const mostrarInfo = () => {
      const n = alocadosDe(reg.filial, reg.secao, reg.funcao);
      info.textContent = (n !== '' && reg.funcao) ? 'Alocados no QL: ' + n : '';
    };
    const encherFuncoes = () => {
      selFun.innerHTML = '';
      selFun.appendChild(h('option', { value: '', text: ctx.funcao ? 'Escolha a função' : '(todas as funções da seção)' }));
      funcoesDe(reg.filial, reg.secao).forEach(x => selFun.appendChild(h('option', { value: x, text: x })));
      if (reg.funcao && !funcoesDe(reg.filial, reg.secao).includes(reg.funcao)) selFun.appendChild(h('option', { value: reg.funcao, text: reg.funcao }));
      selFun.appendChild(h('option', { value: '__outra', text: 'Outra (digitar)...' }));
      selFun.value = reg.funcao || '';
    };
    const selSec = h('select', { class: 'inp', onchange: async e => {
      let v = e.target.value;
      if (v === '__outra') {
        v = await perguntar('Nome da seção:');
        if (!v) { e.target.value = reg.secao; return; }
        v = v.toUpperCase();
        (S.extras.secoes[reg.filial] = S.extras.secoes[reg.filial] || []).push(v);
        await DB.kvSet('extras', S.extras);
        e.target.insertBefore(h('option', { value: v, text: v }), e.target.lastChild);
        e.target.value = v;
      }
      reg.secao = v; reg.funcao = ''; reg.ghe = gheDe(reg.filial, v); inpGhe.value = reg.ghe;
      encherFuncoes(); mostrarInfo(); alterou();
    } }, h('option', { value: '', text: 'Escolha a seção' }), secoesDe(reg.filial).map(x => h('option', { value: x, text: x })),
      (reg.secao && !secoesDe(reg.filial).includes(reg.secao)) ? h('option', { value: reg.secao, text: reg.secao }) : null,
      h('option', { value: '__outra', text: 'Outra (digitar)...' }));
    selSec.value = reg.secao || '';
    selFun.addEventListener('change', async e => {
      let v = e.target.value;
      if (v === '__outra') {
        v = await perguntar('Nome da função:');
        if (!v) { e.target.value = reg.funcao; return; }
        v = v.toUpperCase();
        const k = reg.filial + '|' + reg.secao;
        (S.extras.funcoes[k] = S.extras.funcoes[k] || []).push(v);
        await DB.kvSet('extras', S.extras);
      }
      reg.funcao = v;
      const g = gheDe(reg.filial, reg.secao);
      if (g) { reg.ghe = g; inpGhe.value = g; }
      encherFuncoes(); mostrarInfo(); alterou();
      preencherDoPGR(S.editor);
    });
    encherFuncoes(); mostrarInfo();
    cartaoCtx.appendChild(h('label', { class: 'rot', text: 'Seção' }));
    cartaoCtx.appendChild(selSec);
    if (ctx.funcao) {
      cartaoCtx.appendChild(h('label', { class: 'rot', text: 'Função' + (ctx.funcaoObrig ? ' *' : '') }));
      cartaoCtx.appendChild(selFun);
      cartaoCtx.appendChild(info);
      cartaoCtx.appendChild(h('label', { class: 'rot', text: 'GHE (automático pela seção)' }));
      cartaoCtx.appendChild(inpGhe);
    }
  }
  if (cartaoCtx.childNodes.length) {
    // agrupa cada rótulo com o seu campo (no computador ficam lado a lado, 2 por linha)
    const filhos = [...cartaoCtx.childNodes]; let par = null;
    filhos.forEach(n => { if (n.tagName === 'LABEL' || !par) { par = h('div', { class: 'ctx-par' }); cartaoCtx.appendChild(par); } par.appendChild(n); });
    app.appendChild(cartaoCtx);
  }

  // Campos
  const corpo = h('div', { class: 'cartao campos' });
  corpo.appendChild(renderCampos(f.campos, reg.valores, ''));
  app.appendChild(corpo);
  atualizarVisibilidade();

  // Ações
  app.appendChild(h('div', { class: 'cartao' },
    h('div', { class: 'linha-bts' },
      h('button', { class: 'bt sec', text: 'Duplicar', onclick: async () => { await salvarEditorAgora(); duplicarRegistro(reg); } }),
      h('button', { class: 'bt perigo', text: 'Excluir', onclick: async () => { await salvarEditorAgora(); if (await excluirRegistro(reg)) history.back(); } }))));
  app.appendChild(h('div', { class: 'barra-fim' },
    h('button', { class: 'bt larga', text: reg.status === 'concluido' ? 'Concluído - salvar e enviar' : 'Concluir', onclick: concluir })));

  async function concluir() {
    const falta = faltantes(f.campos, reg.valores, '');
    if (ctx.funcaoObrig && !reg.funcao) falta.unshift('Função');
    if (falta.length) {
      let fechar;
      fechar = modal(h('div', null, h('p', { class: 'modal-txt', text: 'Faltam campos obrigatórios. O registro continua salvo como rascunho.' }),
        h('ul', { class: 'faltas' }, falta.slice(0, 25).map(x => h('li', { text: x }))),
        h('button', { class: 'bt larga', text: 'Voltar ao registro', onclick: () => fechar() })));
      return;
    }
    reg.status = 'concluido';
    E.sujo = true;
    await salvarEditorAgora();
    toast('Concluído.');
    sincronizar(false);
    history.back();
  }
}

function renderCampos(campos, escopo, caminho) {
  const frag = document.createDocumentFragment();
  campos.forEach(c => frag.appendChild(renderCampo(c, escopo, caminho)));
  return frag;
}

function rotuloDe(c) {
  return h('div', { class: 'rot' }, c.rotulo, c.unidade ? h('span', { class: 'un', text: ' (' + c.unidade + ')' }) : null, c.obrig ? h('span', { class: 'obr', text: ' *' }) : null,
    (c.dica || c.figura) ? h('button', { type: 'button', class: 'ic-i', 'aria-label': 'Explicação', text: 'i', onclick: e => { e.preventDefault(); mostrarDica(c); } }) : null);
}

function mostrarDica(c) {
  let fechar;
  const fig = c.figura && S.cfg && S.cfg.figuras ? S.cfg.figuras[c.figura] : null;
  const caixaFig = fig ? h('div', { class: 'fig' }) : null;
  if (caixaFig) caixaFig.innerHTML = fig;
  fechar = modal(h('div', null, h('h3', { text: c.rotulo }), c.dica ? h('p', { class: 'modal-txt', text: c.dica }) : null, caixaFig,
    h('button', { class: 'bt larga', text: 'Entendi', onclick: () => fechar() })));
}

function isoParaBr(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
function brParaData(s) {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  if (d.getFullYear() !== Number(m[3]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[1])) return null;
  return d;
}
/** Interpreta texto colado: 23/11/2026, 23-11-2026, 23.11.2026, 2026-11-23, 23/11/26. */
function interpretarDataColada(t) {
  t = String(t || '').trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return dois(m[3]) + '/' + dois(m[2]) + '/' + m[1];
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) return dois(m[1]) + '/' + dois(m[2]) + '/' + (m[3].length === 2 ? '20' + m[3] : m[3]);
  return null;
}

function renderCampo(c, escopo, caminho) {
  const E = S.editor;
  const path = caminho ? caminho + '.' + c.id : c.id;
  let el;
  if (c.tipo === 'info') el = h('div', { class: 'info', text: c.rotulo });
  else {
    el = h('div', { class: 'campo t-' + c.tipo }, rotuloDe(c), c.ajuda ? h('div', { class: 'ajuda', text: c.ajuda }) : null);
    const ctl = (CONTROLES[c.tipo] || CONTROLES.texto)(c, escopo, path);
    el.appendChild(ctl);
  }
  if (c.se) { E.condicionais.push({ el, c, escopo }); el.hidden = !condicaoOk(c.se, escopo); }
  return el;
}

function chips(opcoes, valor, multi, aoMudar) {
  const box = h('div', { class: 'chips' });
  const marcar = () => box.querySelectorAll('.chip').forEach(ch => {
    const o = ch.dataset.v;
    ch.classList.toggle('on', multi ? (valor || []).includes(o) : valor === o);
  });
  opcoes.forEach(o => box.appendChild(h('button', { type: 'button', class: 'chip' + (o.length > 34 ? ' longo' : ''), 'data-v': o, text: o, onclick: () => {
    if (multi) { valor = (valor || []).slice(); const i = valor.indexOf(o); if (i >= 0) valor.splice(i, 1); else valor.push(o); }
    else valor = valor === o ? '' : o;
    marcar(); aoMudar(valor);
  } })));
  marcar();
  box.definir = v => { valor = v; marcar(); };
  return box;
}

const CONTROLES = {
  texto(c, esc) {
    const inp = h('input', { class: 'inp', value: esc[c.id] || '', 'data-campo': c.id, oninput: e => { esc[c.id] = e.target.value; alterou(); } });
    if (!c.buscaFuncionario) return inp;
    return h('div', { class: 'linha-inp' }, inp, h('button', { type: 'button', class: 'bt sec thumb', text: '🔍 Relação', title: 'Buscar na relação de funcionários da filial', onclick: async () => {
      const r = await escolherFuncionarios(S.editor.reg.filial, false);
      if (!r || !r[0]) return;
      esc[c.id] = r[0].n; inp.value = r[0].n;
      const cm = c.buscaFuncionario.matricula;
      if (cm) { esc[cm] = r[0].m || ''; const im = document.querySelector('[data-campo="' + cm + '"]'); if (im) im.value = r[0].m || ''; }
      alterou(); toast('Preenchido: ' + r[0].n + (r[0].f ? ' (' + r[0].f + ')' : ''));
    } }));
  },
  textolongo(c, esc) {
    const t = h('textarea', { class: 'inp', rows: 3, 'data-campo': c.id, oninput: e => { esc[c.id] = e.target.value; ajusta(); alterou(); } });
    t.value = esc[c.id] || '';
    function ajusta() { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 420) + 'px'; }
    t.addEventListener('ajustar', ajusta);
    setTimeout(ajusta, 0);
    if (!c.doPGR) return t;
    return h('div', null, t, h('button', { type: 'button', class: 'bt sec pequeno bt-pgr', text: '📋 Usar descrição do PGR', onclick: async () => {
      const r = S.editor && S.editor.reg;
      const d = r ? descricaoPGR(r.secao, r.funcao) : '';
      if (!d && r && r.funcao && !((S.cfg.listas || {}).descricoes || []).length) { toast('As descrições do PGR ainda não estão neste aparelho. Com internet, toque em Ajustes > Baixar formulários.', 7000); return; }
      if (!d) { toast(r && r.funcao ? 'Não há descrição no PGR para ' + r.funcao + '.' : 'Escolha a seção e a função primeiro.'); return; }
      if (esc[c.id] && esc[c.id] !== d && !(await confirmar('Trocar o texto atual pela descrição do PGR?', 'Trocar'))) return;
      esc[c.id] = d; t.value = d; ajusta(); alterou();
    } }));
  },
  numero(c, esc) {
    return h('input', { class: 'inp', inputmode: 'decimal', value: mostraNum(esc[c.id]), oninput: e => {
      const s = e.target.value.trim(); const n = numero(s);
      esc[c.id] = s === '' ? '' : (isNaN(n) ? s : n);
      e.target.classList.toggle('erro', s !== '' && isNaN(n));
      alterou();
    } });
  },
  inteiro(c, esc) {
    return h('input', { class: 'inp', inputmode: 'numeric', 'data-campo': c.id, value: mostraNum(esc[c.id]), oninput: e => {
      const s = e.target.value.trim(); const n = parseInt(s, 10);
      esc[c.id] = s === '' ? '' : (isNaN(n) ? s : n);
      e.target.classList.toggle('erro', s !== '' && (isNaN(n) || (c.min !== undefined && n < c.min) || (c.max !== undefined && n > c.max)));
      alterou();
    } });
  },
  data(c, esc) {
    const faixa = c.faixa || { de: -3650, ate: 3650 };
    const msg = h('div', { class: 'erro-txt' });
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const limite = n => { const d = new Date(hoje); d.setDate(d.getDate() + n); return d; };
    const fmt = d => dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + '/' + d.getFullYear();
    const inp = h('input', { class: 'inp', inputmode: 'numeric', placeholder: 'dd/mm/aaaa', maxlength: 10, value: isoParaBr(esc[c.id]), autocomplete: 'off' });
    function aplicar(texto) {
      msg.textContent = '';
      inp.classList.remove('erro');
      if (!texto) { esc[c.id] = ''; alterou(); return; }
      if (texto.length < 10) { esc[c.id] = ''; return; }
      const d = brParaData(texto);
      let erro = '';
      if (!d) erro = 'Data inválida.';
      else if (d > limite(faixa.ate)) erro = faixa.ate <= 0 ? 'Data no futuro não é permitida aqui.' : 'Data muito distante. Limite: ' + fmt(limite(faixa.ate)) + '.';
      else if (d < limite(faixa.de)) erro = 'Data muito antiga. Limite: ' + fmt(limite(faixa.de)) + '.';
      if (erro) { msg.textContent = erro; inp.classList.add('erro'); esc[c.id] = ''; alterou(); return; }
      esc[c.id] = d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate());
      alterou();
    }
    inp.addEventListener('input', () => {
      const bruto = inp.value;
      if (/[^\d/]/.test(bruto)) msg.textContent = 'Digite só números (o app coloca as barras).';
      const dig = bruto.replace(/\D/g, '').slice(0, 8);
      let v = dig;
      if (dig.length > 4) v = dig.slice(0, 2) + '/' + dig.slice(2, 4) + '/' + dig.slice(4);
      else if (dig.length > 2) v = dig.slice(0, 2) + '/' + dig.slice(2);
      inp.value = v;
      aplicar(v);
    });
    inp.addEventListener('paste', e => {
      const t = (e.clipboardData || window.clipboardData).getData('text');
      const v = interpretarDataColada(t);
      e.preventDefault();
      if (!v) { msg.textContent = 'O texto colado não é uma data.'; return; }
      inp.value = v; aplicar(v);
    });
    const btHoje = (faixa.de <= 0 && faixa.ate >= 0) ? h('button', { type: 'button', class: 'bt sec mini', text: 'Hoje', onclick: () => { inp.value = fmt(hoje); aplicar(inp.value); } }) : null;
    return h('div', null, h('div', { class: 'linha-inp' }, inp, btHoje), msg);
  },
  hora(c, esc) { return h('input', { class: 'inp', type: 'time', value: esc[c.id] || '', onchange: e => { esc[c.id] = e.target.value; alterou(); } }); },
  selecao(c, esc) { const b = chips(c.opcoes || [], esc[c.id] || '', false, v => { esc[c.id] = v; alterou(); }); b.dataset.campo = c.id; return b; },
  simnao(c, esc) { return chips(c.opcoes || ['Sim', 'Não'], esc[c.id] || '', false, v => { esc[c.id] = v; alterou(); }); },
  multipla(c, esc) { return chips(c.opcoes || [], esc[c.id] || [], true, v => { esc[c.id] = v; alterou(); }); },

  numeros(c, esc) {
    const res = h('div', { class: 'peq' });
    const calc = s => {
      const n = String(s || '').split(/[;\s]+/).filter(Boolean).map(numero).filter(x => !isNaN(x));
      res.textContent = n.length ? 'n = ' + n.length + ' · média ' + mostraNum((n.reduce((a, b) => a + b, 0) / n.length).toFixed(1)) +
        ' · mín ' + mostraNum(Math.min(...n)) + ' · máx ' + mostraNum(Math.max(...n)) : '';
    };
    const inp = h('input', { class: 'inp', inputmode: 'decimal', value: esc[c.id] || '', placeholder: 'ex.: 520 480 610', oninput: e => { esc[c.id] = e.target.value; calc(e.target.value); alterou(); } });
    calc(esc[c.id]);
    return h('div', null, inp, res);
  },

  gps(c, esc) {
    const txt = h('span', { class: 'peq', text: esc[c.id] && esc[c.id].lat ? esc[c.id].lat.toFixed(5) + ', ' + esc[c.id].lon.toFixed(5) : '' });
    return h('div', { class: 'linha-bts' }, h('button', { type: 'button', class: 'bt sec', text: 'Capturar localização', onclick: () => {
      navigator.geolocation.getCurrentPosition(p => {
        esc[c.id] = { lat: p.coords.latitude, lon: p.coords.longitude, prec: p.coords.accuracy };
        txt.textContent = p.coords.latitude.toFixed(5) + ', ' + p.coords.longitude.toFixed(5) + ' (±' + Math.round(p.coords.accuracy) + ' m)';
        alterou();
      }, () => toast('Não foi possível obter a localização.'), { enableHighAccuracy: true, timeout: 20000 });
    } }), txt);
  },

  instrumento(c, esc) {
    const box = h('div');
    const desenhar = () => {
      box.innerHTML = '';
      const ops = instrumentosDisponiveis(c.filtro);
      if (!ops.length) box.appendChild(h('div', { class: 'peq', text: 'Nenhum instrumento deste tipo cadastrado.' }));
      const sel = h('div', { class: 'chips' });
      ops.forEach(o => sel.appendChild(h('button', { type: 'button', class: 'chip longo' + (esc[c.id] === o.id ? ' on' : ''), text: o.rotulo, onclick: () => {
        esc[c.id] = esc[c.id] === o.id ? '' : o.id; alterou(); desenhar();
      } })));
      box.appendChild(sel);
      box.appendChild(h('button', { type: 'button', class: 'bt sec mini', text: '+ Cadastrar instrumento', onclick: async () => { await salvarEditorAgora(); novoRegistro('INSTRUMENTO'); } }));
    };
    desenhar();
    return box;
  },

  foto(c, esc, path) { return controleArquivos(c, esc, path, 'foto'); },
  arquivo(c, esc, path) { return controleArquivos(c, esc, path, 'arquivo'); },
  video(c, esc, path) { return controleArquivos(c, esc, path, 'video'); },
  audio(c, esc, path) { return controleAudio(c, esc, path); },
  assinatura(c, esc, path) { return controleAssinatura(c, esc, path); },
  cronometro(c, esc) { return controleCronometro(c, esc); },

  secao(c, esc) {
    const reg = S.editor.reg;
    if (!esc[c.id] && reg.secao) esc[c.id] = reg.secao;
    const lista = secoesDe(reg.filial);
    const sel = h('select', { class: 'inp' }, h('option', { value: '', text: 'Escolha a seção' }), lista.map(x => h('option', { value: x, text: x })),
      (esc[c.id] && !lista.includes(esc[c.id])) ? h('option', { value: esc[c.id], text: esc[c.id] }) : null,
      h('option', { value: '__outra', text: 'Outra (digitar)...' }));
    sel.value = esc[c.id] || '';
    sel.addEventListener('change', async () => {
      let v = sel.value;
      if (v === '__outra') {
        v = await perguntar('Nome da seção:');
        if (!v) { sel.value = esc[c.id] || ''; return; }
        v = v.toUpperCase();
        (S.extras.secoes[reg.filial] = S.extras.secoes[reg.filial] || []).push(v);
        await DB.kvSet('extras', S.extras);
        sel.insertBefore(h('option', { value: v, text: v }), sel.lastChild);
        sel.value = v;
      }
      esc[c.id] = v;
      S.editor.dependentes.filter(d => d.escopo === esc && d.campo === c.id).forEach(d => d.mudouSecao());
      alterou();
    });
    return sel;
  },

  funcoes(c, esc) {
    const reg = S.editor.reg;
    const box = h('div');
    const secaoAtual = () => esc[c.deSecao] || reg.secao || '';
    const desenhar = () => {
      box.innerHTML = '';
      const sec = secaoAtual();
      if (!sec) { box.appendChild(h('div', { class: 'peq', text: 'Escolha a seção acima para listar as funções.' })); return; }
      const ops = funcoesDe(reg.filial, sec);
      (esc[c.id] || []).forEach(x => { if (!ops.includes(x)) ops.push(x); });
      box.appendChild(chips(ops, esc[c.id] || [], true, v => { esc[c.id] = v; alterou(); }));
      box.appendChild(h('button', { type: 'button', class: 'bt sec mini', text: '+ Outra função', onclick: async () => {
        const v = await perguntar('Nome da função:');
        if (!v) return;
        const k = reg.filial + '|' + sec;
        (S.extras.funcoes[k] = S.extras.funcoes[k] || []).push(v.toUpperCase());
        await DB.kvSet('extras', S.extras);
        esc[c.id] = (esc[c.id] || []).concat(v.toUpperCase()); alterou(); desenhar();
      } }));
    };
    S.editor.dependentes.push({ escopo: esc, campo: c.deSecao, mudouSecao: () => { esc[c.id] = []; desenhar(); } });
    desenhar();
    return box;
  },

  duracao(c, esc) {
    const min = h('input', { class: 'inp curto', inputmode: 'numeric', placeholder: 'min' });
    const seg = h('input', { class: 'inp curto', inputmode: 'numeric', placeholder: 'seg' });
    const mostrar = () => {
      const v = Number(esc[c.id]);
      if (esc[c.id] === '' || esc[c.id] === undefined || isNaN(v)) { min.value = ''; seg.value = ''; return; }
      min.value = Math.floor(v / 60); seg.value = Math.round(v % 60);
    };
    const ler = () => {
      if (min.value === '' && seg.value === '') { esc[c.id] = ''; alterou(); return; }
      const m = parseInt(min.value || '0', 10), s2 = parseInt(seg.value || '0', 10);
      if (isNaN(m) || isNaN(s2) || s2 > 59) { seg.classList.toggle('erro', s2 > 59); return; }
      seg.classList.remove('erro');
      esc[c.id] = m * 60 + s2; alterou();
    };
    min.addEventListener('input', ler); seg.addEventListener('input', ler);
    mostrar();
    const bt = c.doCronometro ? h('button', { type: 'button', class: 'bt sec mini', text: c.modo === 'max' ? 'Usar o maior ciclo do cronômetro' : 'Usar a média do cronômetro', onclick: () => {
      const cr = esc[c.doCronometro];
      const v = cr && cr.voltas ? cr.voltas.map(x => Number(x.seg)) : [];
      if (!v.length) { toast('Marque pelo menos um ciclo no cronômetro.'); return; }
      esc[c.id] = Math.round(c.modo === 'max' ? Math.max(...v) : v.reduce((a, b) => a + b, 0) / v.length);
      mostrar(); alterou();
    } }) : null;
    return h('div', null, h('div', { class: 'dur-linha' }, min, h('span', { text: 'min' }), seg, h('span', { text: 'seg' })), bt);
  },

  epis(c, esc) {
    if (!Array.isArray(esc[c.id])) esc[c.id] = [];
    const box = h('div');
    const desenhar = () => {
      box.innerHTML = '';
      const nomes = (c.opcoes || []).slice();
      esc[c.id].forEach(x => { if (!nomes.includes(x.epi)) nomes.push(x.epi); });
      box.appendChild(chips(nomes, esc[c.id].map(x => x.epi), true, sel => {
        const atual = esc[c.id];
        esc[c.id] = sel.map(n => atual.find(x => x.epi === n) || { epi: n, ca: '' });
        alterou(); desenhar();
      }));
      esc[c.id].forEach(x => box.appendChild(h('div', { class: 'epi-linha' }, h('span', { text: x.epi }),
        h('input', { class: 'inp curto', inputmode: 'numeric', placeholder: 'CA', value: x.ca || '', oninput: e => { x.ca = e.target.value.replace(/\D/g, ''); e.target.value = x.ca; alterou(); } }))));
      box.appendChild(h('button', { type: 'button', class: 'bt sec mini', text: '+ Outro EPI', onclick: async () => {
        const v = await perguntar('Nome do EPI:');
        if (!v) return;
        esc[c.id].push({ epi: v, ca: '' }); alterou(); desenhar();
      } }));
    };
    desenhar();
    return box;
  },

  resultado(c, esc) {
    const box = h('div', { class: 'resultado' });
    let fn = null;
    try { fn = new Function('return ' + c.calc)(); } catch (e) { }
    const render = () => {
      box.innerHTML = '';
      let r = null;
      try { r = fn ? fn(esc) : null; } catch (e) { }
      if (!r || !r.linhas) { box.appendChild(h('div', { class: 'peq', text: 'Preencha as medições para ver o resultado.' })); return; }
      r.linhas.forEach(l => box.appendChild(barraReferencia(l)));
      if (r.nota) box.appendChild(h('div', { class: 'peq', text: r.nota }));
    };
    S.editor.calculados.push({ el: box, render });
    render();
    return box;
  },

  grupo(c, esc, path) {
    if (!Array.isArray(esc[c.id])) esc[c.id] = [];
    const nomeItem = c.item || 'item';
    const Nome = nomeItem.charAt(0).toUpperCase() + nomeItem.slice(1);
    const lista = h('div', { class: 'grupo-itens' + (c.compacto ? ' compacto' : '') });
    const desenhar = () => {
      lista.innerHTML = '';
      esc[c.id].forEach((it, i) => {
        if (!it._id) it._id = uid();
        const cab = h('div', { class: 'gi-cab' }, h('strong', { text: Nome + ' ' + (i + 1) }),
          h('div', null,
            h('button', { type: 'button', class: 'bt sec mini', text: 'Copiar', onclick: () => {
              const novo = Object.assign(copiaSemAnexos(c.campos, it), { _id: uid() });
              esc[c.id].splice(i + 1, 0, novo); alterou(); desenhar();
            } }),
            h('button', { type: 'button', class: 'bt perigo mini', text: 'Excluir', onclick: async () => {
              if (!(await confirmar('Excluir ' + nomeItem + ' ' + (i + 1) + '?', 'Excluir'))) return;
              const reg = S.editor.reg;
              const ids = [];
              c.campos.forEach(s => { const v = it[s.id]; if (Array.isArray(v) && ['foto', 'audio', 'video', 'arquivo'].includes(s.tipo)) ids.push(...v); if (s.tipo === 'assinatura' && v) ids.push(v); });
              for (const id of ids) await removerAnexo(reg, id);
              esc[c.id].splice(i, 1); alterou(); desenhar();
            } })));
        lista.appendChild(h('div', { class: 'grupo-item' }, cab, renderCampos(c.campos, it, path + '[' + it._id + ']')));
      });
      atualizarVisibilidade();
    };
    desenhar();
    const btAdd = h('button', { type: 'button', class: 'bt sec larga bt-add', text: '+ Adicionar ' + nomeItem, onclick: () => {
      const novo = { _id: uid() };
      aplicarPadroes(c.campos, novo);
      esc[c.id].push(novo); alterou(); desenhar();
      setTimeout(() => { const ult = lista.lastElementChild; if (ult) ult.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
    } });
    return h('div', { class: 'grupo' }, btAdd, lista);
  }
};

function barraReferencia(l) {
  const [a, b] = l.escala, W = 300;
  const x = v => Math.max(0, Math.min(W, (v - a) / (b - a) * W));
  const ok = l.valor >= l.faixa[0] && l.valor <= l.faixa[1];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 300 34'); svg.setAttribute('class', 'barra-svg');
  const add = (tag, at) => { const e = document.createElementNS(ns, tag); for (const k in at) e.setAttribute(k, at[k]); svg.appendChild(e); return e; };
  add('rect', { x: 0, y: 10, width: W, height: 12, rx: 6, fill: 'var(--trilho)' });
  add('rect', { x: x(l.faixa[0]), y: 10, width: Math.max(2, x(l.faixa[1]) - x(l.faixa[0])), height: 12, fill: 'var(--faixa-ok)' });
  add('line', { x1: x(l.valor), y1: 4, x2: x(l.valor), y2: 28, stroke: ok ? '#2e8b57' : '#c0392b', 'stroke-width': 4, 'stroke-linecap': 'round' });
  const t1 = add('text', { x: 2, y: 34, 'font-size': 9, fill: 'var(--sub)' }); t1.textContent = mostraNum(a);
  const t2 = add('text', { x: W - 2, y: 34, 'font-size': 9, fill: 'var(--sub)', 'text-anchor': 'end' }); t2.textContent = mostraNum(b);
  return h('div', { class: 'barra-res' },
    h('div', { class: 'barra-cab' }, h('span', { text: l.rotulo }), h('strong', { class: ok ? 'ok' : 'fora', text: mostraNum(l.valor) + ' ' + l.unidade + (ok ? ' - dentro' : ' - fora') })),
    svg, h('div', { class: 'peq', text: l.ref || '' }));
}

/* ------------------------ fotos, vídeos e arquivos ------------------------ */
function controleArquivos(c, esc, path, modo) {
  const reg = S.editor.reg;
  const box = h('div');
  const miniaturas = h('div', { class: 'miniaturas' });
  async function desenhar() {
    miniaturas.innerHTML = '';
    const ids = Array.isArray(esc[c.id]) ? esc[c.id] : [];
    for (const id of ids) {
      const a = reg.anexos.find(x => x.id === id);
      if (!a) continue;
      const u = a.removidoLocal ? null : await urlDoAnexo(id);
      let vis;
      if (u && a.mime.startsWith('image/')) vis = h('img', { src: u, alt: '' });
      else vis = h('div', { class: 'thumb-ic', text: a.noOutro ? 'NO OUTRO APARELHO' : a.removidoLocal ? (a.mime.startsWith('image/') ? 'FOTO NO DRIVE' : 'NO DRIVE') : a.mime.startsWith('video/') ? 'VÍDEO' : a.mime === 'application/pdf' ? 'PDF' : 'ARQ' });
      miniaturas.appendChild(h('button', { type: 'button', class: 'thumb' + (a.grande ? ' grande' : ''), onclick: () => verAnexo(a, u, desenhar, esc, c) },
        vis, a.legenda ? h('span', { class: 'thumb-leg', text: a.legenda }) : null, a.enviado ? h('span', { class: 'thumb-ok', text: '✓' }) : null));
    }
  }
  async function receber(arquivos) {
    for (const arq of arquivos) {
      let blob = arq, ext = (arq.name.split('.').pop() || 'bin').toLowerCase();
      if (arq.type.startsWith('image/') && !arq.type.includes('gif')) { blob = await processarFoto(arq, carimboLigado() ? textoCarimbo(reg) : null); ext = blob === arq ? ext : 'jpg'; }
      const a = await adicionarAnexo(reg, path, c, blob, c.rotulo.split('(')[0].trim(), ext);
      if (a.grande) toast('Arquivo de ' + tamanho(blob.size) + ': grande demais para envio automático. Grave vídeos curtos (até ~1 min).', 7000);
      esc[c.id] = (Array.isArray(esc[c.id]) ? esc[c.id] : []).concat(a.id);
    }
    alterou();
    await salvarEditorAgora();
    desenhar();
  }
  const aceita = modo === 'foto' ? 'image/*' : modo === 'video' ? 'video/*' : 'image/*,application/pdf';
  const inpCam = h('input', { type: 'file', accept: aceita, capture: 'environment', hidden: true, onchange: e => { receber([...e.target.files]); e.target.value = ''; } });
  const inpGal = h('input', { type: 'file', accept: aceita, multiple: true, hidden: true, onchange: e => { receber([...e.target.files]); e.target.value = ''; } });
  if (modo !== 'video') box.appendChild(flagCarimbo());
  box.appendChild(h('div', { class: 'linha-bts' },
    modo !== 'arquivo' ? h('button', { type: 'button', class: 'bt', text: modo === 'video' ? 'Gravar vídeo' : 'Câmera', onclick: () => inpCam.click() }) : h('button', { type: 'button', class: 'bt', text: 'Fotografar', onclick: () => { inpCam.accept = 'image/*'; inpCam.click(); } }),
    h('button', { type: 'button', class: 'bt sec', text: modo === 'arquivo' ? 'Escolher arquivo' : 'Galeria', onclick: () => inpGal.click() }), inpCam, inpGal));
  box.appendChild(miniaturas);
  desenhar();
  return box;
}

function verAnexo(a, u, redesenhar, esc, c) {
  const reg = S.editor.reg;
  let fechar;
  const leg = h('input', { class: 'inp', value: a.legenda || '', placeholder: 'Legenda (aparece no relatório)', oninput: e => { a.legenda = e.target.value; alterou(); } });
  let vis = null;
  if (u && a.mime.startsWith('image/')) vis = h('img', { class: 'ver-img', src: u });
  else if (u && a.mime.startsWith('video/')) vis = h('video', { class: 'ver-img', src: u, controls: true });
  else if (u && a.mime.startsWith('audio/')) vis = h('audio', { src: u, controls: true });
  fechar = modal(h('div', null, vis || h('p', { class: 'peq', text: a.noOutro ? 'Arquivo ainda não enviado pelo outro aparelho. Aparece aqui depois que ele sincronizar.' : a.removidoLocal ? 'Arquivo guardado no Drive (não fica neste aparelho).' : a.nome }),
    h('p', { class: 'peq', text: a.nome + ' · ' + tamanho(a.tamanho) + (a.enviado ? ' · enviado' : a.grande ? ' · grande demais: envio manual' : ' · a enviar') }),
    leg,
    h('div', { class: 'linha-bts' },
      u ? h('button', { class: 'bt sec', text: 'Baixar', onclick: () => baixarAnexo(a) }) : null,
      (!u && a.url) ? h('a', { class: 'bt sec', href: a.url, target: '_blank', rel: 'noopener', text: 'Abrir no Drive' }) : null,
      h('button', { class: 'bt perigo', text: 'Excluir', onclick: async () => {
        if (!(await confirmar('Excluir este arquivo?', 'Excluir'))) return;
        const v = esc[c.id];
        esc[c.id] = Array.isArray(v) ? v.filter(x => x !== a.id) : '';
        await removerAnexo(reg, a.id); alterou(); fechar(); redesenhar();
      } }),
      h('button', { class: 'bt', text: 'Fechar', onclick: () => { fechar(); redesenhar(); } }))), { aoFechar: () => salvarEditorAgora() });
}

/* --------------------------------- áudio --------------------------------- */
function pararGravacao() {
  if (S.gravando) { try { S.gravando.rec.stop(); } catch (e) { } }
}

function controleAudio(c, esc, path) {
  const reg = S.editor.reg;
  const lista = h('div', { class: 'audios' });
  const bt = h('button', { type: 'button', class: 'bt', text: '● Gravar áudio' });
  async function desenhar() {
    lista.innerHTML = '';
    for (const id of (esc[c.id] || [])) {
      const a = reg.anexos.find(x => x.id === id);
      if (!a) continue;
      const u = a.removidoLocal ? null : await urlDoAnexo(id);
      lista.appendChild(h('div', { class: 'audio-item' }, u ? h('audio', { src: u, controls: true }) : h('span', { class: 'peq', text: 'No Drive' }),
        h('button', { type: 'button', class: 'bt perigo mini', text: 'Excluir', onclick: async () => {
          if (!(await confirmar('Excluir este áudio?', 'Excluir'))) return;
          esc[c.id] = esc[c.id].filter(x => x !== id); await removerAnexo(reg, id); alterou(); desenhar();
        } })));
    }
  }
  bt.addEventListener('click', async () => {
    if (S.gravando) { S.gravando.rec.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { toast('Permita o uso do microfone para gravar.'); return; }
    const tipo = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const rec = new MediaRecorder(stream, tipo ? { mimeType: tipo } : undefined);
    const partes = [];
    const ini = Date.now();
    rec.ondataavailable = e => { if (e.data.size) partes.push(e.data); };
    rec.onstop = async () => {
      clearInterval(S.gravando && S.gravando.int);
      stream.getTracks().forEach(t => t.stop());
      S.gravando = null;
      bt.textContent = '● Gravar áudio'; bt.classList.remove('gravando');
      const blob = new Blob(partes, { type: rec.mimeType || 'audio/webm' });
      if (!blob.size) return;
      if (!S.editor || S.editor.reg !== reg) { // saiu da tela durante a gravação: grava mesmo assim
        const a = await adicionarAnexo(reg, path, c, blob, 'audio', 'webm');
        esc[c.id] = (esc[c.id] || []).concat(a.id); reg.versao++; reg.atualizadoEm = agoraIso(); await gravarReg(reg); return;
      }
      const a = await adicionarAnexo(reg, path, c, blob, 'audio', 'webm');
      esc[c.id] = (esc[c.id] || []).concat(a.id);
      alterou(); await salvarEditorAgora(); desenhar();
    };
    rec.start(1000);
    S.gravando = { rec, int: setInterval(() => { const s = Math.round((Date.now() - ini) / 1000); bt.textContent = '■ Parar (' + Math.floor(s / 60) + ':' + dois(s % 60) + ')'; }, 500) };
    bt.textContent = '■ Parar (0:00)'; bt.classList.add('gravando');
  });
  desenhar();
  return h('div', null, bt, lista);
}

/* ------------------------------- assinatura ------------------------------- */
/** Abre o quadro de assinatura em tela cheia. Devolve a imagem (PNG) ou null se cancelar. */
function coletarAssinatura(titulo, subtitulo) {
  return new Promise(resolve => {
    const cv = h('canvas', { class: 'assin-cv' });
    let fechar, desenhando = false, tem = false, g;
    const ajustar = () => {
      const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      g = cv.getContext('2d'); g.scale(dpr, dpr);
      g.fillStyle = '#fff'; g.fillRect(0, 0, r.width, r.height);
      g.lineWidth = 2.4; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#111';
    };
    const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', e => { if (!g) ajustar(); desenhando = true; tem = true; cv.setPointerCapture(e.pointerId); const [x, y] = pos(e); g.beginPath(); g.moveTo(x, y); });
    cv.addEventListener('pointermove', e => { if (!desenhando || !g) return; const [x, y] = pos(e); g.lineTo(x, y); g.stroke(); });
    cv.addEventListener('pointerup', () => { desenhando = false; });
    fechar = modal(h('div', { class: 'assin-box' },
      h('p', { class: 'assin-tit', text: titulo }), subtitulo ? h('p', { class: 'peq', text: subtitulo }) : null, cv,
      h('div', { class: 'linha-bts' },
        h('button', { class: 'bt sec', text: 'Limpar', onclick: () => { ajustar(); tem = false; } }),
        h('button', { class: 'bt sec', text: 'Cancelar', onclick: () => { fechar(); resolve(null); } }),
        h('button', { class: 'bt', text: 'Confirmar', onclick: async () => {
          if (!tem) { toast('Assinatura em branco.'); return; }
          const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
          fechar(); resolve(blob);
        } }))), { cheio: true });
    setTimeout(ajustar, 30);
  });
}

function controleAssinatura(c, esc, path) {
  const reg = S.editor.reg;
  const prev = h('div', { class: 'assin-prev' });
  async function desenhar() {
    prev.innerHTML = '';
    if (esc[c.id]) {
      const a = reg.anexos.find(x => x.id === esc[c.id]);
      const u = a && !a.removidoLocal ? await urlDoAnexo(a.id) : null;
      if (u) prev.appendChild(h('img', { src: u, alt: 'assinatura' })); else prev.appendChild(h('span', { class: 'peq', text: 'Assinatura registrada' }));
    }
  }
  const bt = h('button', { type: 'button', class: 'bt', text: 'Coletar assinatura', onclick: async () => {
    const blob = await coletarAssinatura('Assine dentro do quadro.');
    if (!blob) return;
    if (esc[c.id]) await removerAnexo(reg, esc[c.id]);
    const a = await adicionarAnexo(reg, path, c, blob, 'assinatura', 'png');
    esc[c.id] = a.id; alterou(); await salvarEditorAgora(); desenhar();
  } });
  desenhar();
  return h('div', null, prev, bt);
}

/* ------------------------------- cronômetro ------------------------------- */
function controleCronometro(c, esc) {
  if (!esc[c.id] || typeof esc[c.id] !== 'object') esc[c.id] = { acum: 0, inicio: null, marca: 0, voltas: [] };
  const v = esc[c.id];
  const tempo = () => (v.acum || 0) + (v.inicio ? (Date.now() - v.inicio) / 1000 : 0);
  const visor = h('div', { class: 'crono-visor' });
  const btIni = h('button', { type: 'button', class: 'bt' });
  const btVolta = h('button', { type: 'button', class: 'bt sec', text: 'Marcar ciclo' });
  const btZerar = h('button', { type: 'button', class: 'bt perigo mini', text: 'Zerar' });
  const lista = h('div', { class: 'crono-lista' });
  const stats = h('div', { class: 'peq' });
  const fmt = s => Math.floor(s / 60) + ':' + dois(Math.floor(s % 60)) + ',' + Math.floor((s * 10) % 10);
  function atualizar() {
    visor.textContent = fmt(tempo());
    btIni.textContent = v.inicio ? 'Pausar' : (tempo() ? 'Continuar' : 'Iniciar');
  }
  function desenharLista() {
    lista.innerHTML = '';
    v.voltas.forEach((x, i) => lista.appendChild(h('div', { class: 'crono-v' },
      h('span', { text: 'C' + (i + 1) + ': ' + mostraNum(Number(x.seg).toFixed(1)) + ' s' }),
      h('input', { class: 'inp mini', placeholder: 'o que foi', value: x.rotulo || '', oninput: e => { x.rotulo = e.target.value; alterou(); } }),
      h('button', { type: 'button', class: 'bt perigo mini', text: 'x', onclick: () => { v.voltas.splice(i, 1); alterou(); desenharLista(); } }))));
    const n = v.voltas.length, tot = v.voltas.reduce((s, x) => s + Number(x.seg), 0);
    stats.textContent = n ? n + ' ciclo(s) · média ' + mostraNum((tot / n).toFixed(1)) + ' s · ' + mostraNum((60 * n / tot).toFixed(1)) + ' ciclos/min' : '';
  }
  btIni.addEventListener('click', () => {
    if (v.inicio) { v.acum = tempo(); v.inicio = null; } else v.inicio = Date.now();
    alterou(); atualizar();
  });
  btVolta.addEventListener('click', () => {
    const t = tempo();
    if (!t) return;
    v.voltas.push({ seg: Math.round((t - (v.marca || 0)) * 10) / 10, rotulo: '' });
    v.marca = t; alterou(); desenharLista();
  });
  btZerar.addEventListener('click', async () => {
    if (!(await confirmar('Zerar o cronômetro e apagar os ciclos?', 'Zerar'))) return;
    v.acum = 0; v.inicio = null; v.marca = 0; v.voltas = []; alterou(); atualizar(); desenharLista();
  });
  const int = setInterval(() => { if (!visor.isConnected) { clearInterval(int); return; } atualizar(); }, 100);
  atualizar(); desenharLista();
  return h('div', { class: 'crono' }, visor, h('div', { class: 'linha-bts' }, btIni, btVolta, btZerar), stats, lista);
}

/* ================================ INÍCIO ================================ */
/* ==================== DESCRIÇÃO DAS FUNÇÕES (do PGR) ==================== */
function descricaoPGR(secao, funcao) {
  const L = (S.cfg && S.cfg.listas && S.cfg.listas.descricoes) || [];
  if (!funcao || !L.length) return '';
  const fs = semAcento(funcao).trim(), ss = semAcento(secao).trim();
  const exato = L.find(x => semAcento(x[1]).trim() === fs && semAcento(x[0]).trim() === ss);
  if (exato) return exato[2];
  const soFuncao = L.find(x => semAcento(x[1]).trim() === fs);
  return soFuncao ? soFuncao[2] : '';
}
/** Ao escolher a função: preenche os campos marcados doPGR que estiverem vazios. */
async function preencherDoPGR(E) {
  if (!E || !E.f) return;
  if (!((S.cfg && S.cfg.listas && S.cfg.listas.descricoes) || []).length && navigator.onLine && S.ajustes.url) await baixarConfig(true);
  if (S.editor !== E) return;
  const d = descricaoPGR(E.reg.secao, E.reg.funcao);
  if (!d) return;
  let n = 0;
  E.f.campos.filter(c => c.doPGR).forEach(c => {
    if (E.reg.valores[c.id]) return;
    E.reg.valores[c.id] = d; n++;
    const t = document.querySelector('[data-campo="' + c.id + '"]');
    if (t) { t.value = d; t.dispatchEvent(new Event('ajustar')); }
  });
  if (n) { alterou(); toast('Tarefa prescrita preenchida com a descrição do PGR. Pode editar.'); }
}

/* ==================== FUNCIONÁRIOS DA FILIAL (dado pessoal) ==================== */
// Lista guardada só neste aparelho, por filial: [[matrícula, nome, seção, função], ...]
S.func = {};
async function funcionariosLocais(filial) {
  if (!filial) return null;
  if (!S.func[filial]) S.func[filial] = (await DB.kvGet('func:' + filial)) || null;
  return S.func[filial];
}
async function baixarFuncionarios(filial, manual, forcar) {
  if (!filial || !S.ajustes.url || !S.ajustes.chave || !navigator.onLine) { if (manual) toast('Sem internet ou servidor não configurado.'); return null; }
  const atual = await funcionariosLocais(filial);
  if (!manual && !forcar && atual && Date.now() - new Date(atual.baixadoEm).getTime() < 6 * 3600000) return atual;
  try {
    const j = await api({ acao: 'funcionarios', filial }, 90000);
    const o = { lista: j.lista || [], atualizadoEm: j.atualizadoEm || '', baixadoEm: agoraIso() };
    S.func[filial] = o; await DB.kvSet('func:' + filial, o);
    if (manual) toast(o.lista.length ? o.lista.length + ' funcionário(s) da filial ' + filial + ' neste aparelho.' : 'O servidor ainda não tem a lista de funcionários da filial ' + filial + '. Envie em Ajustes > Dados da filial.', 6000);
    return o;
  } catch (e) { if (manual) toast(e.message, 6000); return atual; }
}
async function apagarFuncionariosLocais() {
  for (const k of Object.keys(S.func)) delete S.func[k];
  const chaves = (await DB.kvKeys()).filter(k => String(k).startsWith('func:'));
  for (const k of chaves) await DB.del('kv', k);
}
function semAcento(t) { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(); }

/** Janela de busca na relação de funcionários. Devolve [{m, n, s, f}] escolhidos (multi) ou um item. */
async function escolherFuncionarios(filial, multi, jaEscolhidos) {
  let o = await funcionariosLocais(filial);
  if (!o || !o.lista.length) o = await baixarFuncionarios(filial, false);
  const lista = (o && o.lista) || [];
  return new Promise(resolve => {
    const marcados = new Map();
    const ja = new Set((jaEscolhidos || []).map(p => p.m || p.n));
    const busca = h('input', { class: 'inp', placeholder: 'Buscar por nome ou matrícula', autocomplete: 'off' });
    const secoes = [...new Set(lista.map(x => x[2]).filter(Boolean))].sort();
    const selSec = h('select', { class: 'inp' }, h('option', { value: '', text: 'Todas as seções' }), secoes.map(x => h('option', { value: x, text: x })));
    const res = h('div', { class: 'func-res' });
    const cont = h('span', { class: 'peq' });
    const btSecao = h('button', { class: 'bt sec pequeno', text: 'Marcar todos da seção', hidden: true, onclick: () => { lista.filter(x => x[2] === selSec.value && !ja.has(x[0] || x[1])).forEach(x => marcados.set(x[0] + '|' + x[1], x)); desenhar(); } });
    function desenhar() {
      res.innerHTML = '';
      const q = semAcento(busca.value).trim();
      const itens = lista.filter(x => (!selSec.value || x[2] === selSec.value) && (!q || semAcento(x[1]).includes(q) || String(x[0]).includes(q))).slice(0, 80);
      if (!lista.length) res.appendChild(h('p', { class: 'peq', text: 'A relação de funcionários desta filial não está no aparelho. Envie o arquivo em Ajustes > Dados da filial, ou use "Adicionar nome manualmente".' }));
      else if (!itens.length) res.appendChild(h('p', { class: 'peq', text: 'Nenhum funcionário encontrado.' }));
      itens.forEach(x => {
        const k = x[0] + '|' + x[1], jaTem = ja.has(x[0] || x[1]);
        res.appendChild(h('button', { type: 'button', class: 'func-item' + (marcados.has(k) ? ' on' : '') + (jaTem ? ' ja' : ''), disabled: jaTem, onclick: () => {
          if (!multi) { fechar(); resolve([{ m: x[0], n: x[1], s: x[2], f: x[3] }]); return; }
          if (marcados.has(k)) marcados.delete(k); else marcados.set(k, x); desenhar();
        } }, h('span', { class: 'fi-chk', text: jaTem ? '✓' : marcados.has(k) ? '✓' : '' }),
          h('span', { class: 'fi-txt' }, h('strong', { text: x[1] }), h('small', { text: [x[0] ? 'Mat. ' + x[0] : '', x[3], x[2]].filter(Boolean).join(' · ') + (jaTem ? ' · já na lista' : '') }))));
      });
      cont.textContent = multi ? marcados.size + ' marcado(s)' : '';
      btSecao.hidden = !multi || !selSec.value;
    }
    busca.addEventListener('input', desenhar); selSec.addEventListener('change', desenhar);
    const manual = h('button', { class: 'bt sec', text: '+ Adicionar nome manualmente', onclick: async () => {
      const n = await perguntar('Nome completo:'); if (!n) return;
      const m = await perguntar('Matrícula (opcional):');
      fechar(); resolve([...marcados.values()].map(x => ({ m: x[0], n: x[1], s: x[2], f: x[3] })).concat([{ m: (m || '').trim(), n: n.toUpperCase(), s: '', f: '', manual: true }]));
    } });
    const fechar = modal(h('div', { class: 'func-box' },
      h('h3', { text: multi ? 'Escolher participantes' : 'Escolher funcionário' }),
      h('p', { class: 'peq', text: lista.length ? lista.length + ' funcionário(s) da filial ' + filial + (o && o.atualizadoEm ? ' · lista de ' + o.atualizadoEm : '') : '' }),
      h('div', { class: 'func-filtros' }, busca, selSec), btSecao, res,
      h('div', { class: 'linha-bts' }, manual,
        h('button', { class: 'bt sec', text: 'Cancelar', onclick: () => { fechar(); resolve(null); } }),
        multi ? h('button', { class: 'bt', text: 'Adicionar', onclick: () => { fechar(); resolve([...marcados.values()].map(x => ({ m: x[0], n: x[1], s: x[2], f: x[3] }))); } }) : null),
      multi ? cont : null), { cheio: true });
    desenhar();
    setTimeout(() => busca.focus(), 60);
  });
}

/* ============================ LISTA DE PRESENÇA ============================ */
CONTROLES.presenca = function (c, esc, path) {
  const E = S.editor, reg = E.reg;
  const box = h('div', { class: 'presenca' });
  const lista = () => (Array.isArray(esc[c.id]) ? esc[c.id] : []);
  function atualizarContagem() {
    const l = lista();
    if (c.conta) { esc[c.conta] = l.length || ''; const inp = document.querySelector('[data-campo="' + c.conta + '"]'); if (inp) inp.value = l.length || ''; }
    if (c.funcoesEm && l.length) {
      const cont = {}; l.forEach(p => { if (p.f) cont[p.f] = (cont[p.f] || 0) + 1; });
      const txt = Object.keys(cont).sort().map(k => k + ' (' + cont[k] + ')').join('; ');
      if (txt && (!esc[c.funcoesEm] || esc._funcoesAuto === esc[c.funcoesEm])) {
        esc[c.funcoesEm] = txt; esc._funcoesAuto = txt;
        const t = document.querySelector('[data-campo="' + c.funcoesEm + '"]'); if (t) t.value = txt;
      }
    }
  }
  async function assinar(p) {
    const blob = await coletarAssinatura(p.n, [p.m ? 'Matrícula ' + p.m : '', p.f].filter(Boolean).join(' · ') + ' - assine dentro do quadro.');
    if (!blob) return;
    if (p.ass) await removerAnexo(reg, p.ass);
    const a = await adicionarAnexo(reg, path, c, blob, 'assinatura ' + p.n, 'png');
    p.ass = a.id; p.em = agoraIso();
    alterou(); await salvarEditorAgora(); desenhar();
  }
  function desenhar() {
    box.innerHTML = '';
    const l = lista(), nAss = l.filter(p => p.ass).length;
    box.appendChild(h('div', { class: 'pres-cab' },
      h('strong', { text: l.length + ' participante(s)' }), l.length ? h('span', { class: 'peq', text: ' · ' + nAss + ' assinaram no aparelho' }) : null));
    const ul = h('div', { class: 'pres-lista' });
    l.forEach((p, i) => ul.appendChild(h('div', { class: 'pres-item' + (p.ass ? ' ok' : '') },
      h('span', { class: 'pres-n', text: String(i + 1) }),
      h('div', { class: 'pres-txt' }, h('strong', { text: p.n }), h('small', { text: [p.m ? 'Mat. ' + p.m : '', p.f, p.s].filter(Boolean).join(' · ') + (p.ass ? ' · assinou ' + dataHoraBr(p.em) : '') })),
      h('button', { type: 'button', class: 'bt pequeno' + (p.ass ? ' sec' : ''), text: p.ass ? 'Refazer' : '✍ Assinar', onclick: () => assinar(p) }),
      h('button', { type: 'button', class: 'bt perigo pequeno', title: 'Tirar da lista', text: '×', onclick: async () => {
        if (p.ass && !(await confirmar('Tirar ' + p.n + ' da lista? A assinatura dele também sai.', 'Tirar'))) return;
        if (p.ass) await removerAnexo(reg, p.ass);
        esc[c.id] = lista().filter(x => x !== p); atualizarContagem(); alterou(); desenhar();
      } }))));
    box.appendChild(ul);
    box.appendChild(h('div', { class: 'linha-bts' },
      h('button', { type: 'button', class: 'bt sec', text: '+ Escolher participantes', onclick: async () => {
        const novos = await escolherFuncionarios(reg.filial, true, lista());
        if (!novos || !novos.length) return;
        esc[c.id] = lista().concat(novos.map(x => Object.assign({ ass: '', em: '' }, x)));
        atualizarContagem(); alterou(); desenhar();
      } }),
      l.length ? h('button', { type: 'button', class: 'bt sec', text: '🖨 Imprimir lista para assinar', onclick: () => imprimirLista(reg, c, false) }) : null,
      nAss ? h('button', { type: 'button', class: 'bt', text: '📄 Gerar PDF da lista assinada', onclick: () => gerarPdfLista(reg) }) : null));
    if (l.length) box.appendChild(h('p', { class: 'peq', text: 'Papel: imprima, colete as assinaturas e fotografe a lista no campo "Lista de presença assinada em papel". Aparelho: toque em Assinar ao lado de cada nome e passe o aparelho para a pessoa; no fim, gere o PDF.' }));
  }
  desenhar();
  return box;
};

function escHtml(t) { return String(t === undefined || t === null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/** Lista para imprimir (funciona sem internet). comAss: inclui as assinaturas já coletadas no aparelho. */
async function imprimirLista(reg, c, comAss) {
  await salvarEditorAgora();
  const v = reg.valores || {}, l = Array.isArray(v[c.id]) ? v[c.id] : [];
  const fi = filialInfo(reg.filial) || {};
  const linhas = [];
  for (let i = 0; i < l.length; i++) {
    const p = l[i];
    let ass = '';
    if (comAss && p.ass) { const u = await urlDoAnexo(p.ass); if (u) ass = '<img src="' + u + '">'; }
    linhas.push('<tr><td class="c">' + (i + 1) + '</td><td>' + escHtml(p.n) + '</td><td class="c">' + escHtml(p.m || '') + '</td><td>' + escHtml(p.f || '') + '</td><td class="ass">' + ass + '</td></tr>');
  }
  for (let i = 0; i < 3; i++) linhas.push('<tr><td class="c">' + (l.length + i + 1) + '</td><td></td><td></td><td></td><td class="ass"></td></tr>');
  const area = h('div', { id: 'impressao' });
  area.innerHTML = '<h1>LISTA DE PRESENÇA</h1><h2>' + escHtml(v.tipo || 'Reunião') + '</h2>' +
    '<table class="cab"><tr><td><b>Unidade:</b> ' + escHtml((fi.bandeira || fi.nome || '') + ' - filial ' + reg.filial) + '</td><td><b>Data:</b> ' + escHtml(isoParaBr(v.data) || '___/___/______') + '</td><td><b>Horário:</b> ' + escHtml(v.hora || '') + '</td></tr>' +
    '<tr><td><b>Local:</b> ' + escHtml(v.local || '') + '</td><td colspan="2"><b>Conduzido por:</b> ' + escHtml(reg.avaliador || '') + '</td></tr>' +
    (v.pauta ? '<tr><td colspan="3"><b>Pauta:</b> ' + escHtml(v.pauta) + '</td></tr>' : '') + '</table>' +
    '<table class="lst"><thead><tr><th>Nº</th><th>Nome</th><th>Matrícula</th><th>Função</th><th>Assinatura</th></tr></thead><tbody>' + linhas.join('') + '</tbody></table>' +
    '<p class="rod">Declaro que participei da atividade acima. Lista gerada pelo Coletor de Campo em ' + escHtml(dataHoraBr(agoraIso())) + ' · registro ' + escHtml(reg.id.slice(0, 8)) + '</p>' +
    '<div class="ass-cond"><div>_______________________________________<br>' + escHtml(reg.avaliador || 'Responsável') + '<br>Responsável pela atividade</div></div>';
  document.body.appendChild(area);
  document.body.classList.add('imprimindo');
  const limpar = () => { area.remove(); document.body.classList.remove('imprimindo'); window.removeEventListener('afterprint', limpar); };
  window.addEventListener('afterprint', limpar);
  setTimeout(() => { window.print(); setTimeout(() => { if (document.body.classList.contains('imprimindo')) limpar(); }, 1500); }, 200);
}

/** PDF da lista assinada no aparelho: envia as assinaturas e o servidor monta o PDF com código de verificação. */
async function gerarPdfLista(reg) {
  if (!navigator.onLine) { toast('Precisa de internet para gerar o PDF. As assinaturas estão guardadas neste aparelho. Sem internet, use "Imprimir lista".', 7000); return; }
  await salvarEditorAgora();
  const fechar = modal(h('div', null, h('div', { class: 'girando' }), h('p', { class: 'modal-txt', text: 'Enviando assinaturas e gerando o PDF...' })), { semFechar: true });
  try {
    await sincronizar(false);
    const r = S.regs.get(reg.id);
    if (r && pendente(r)) throw new Error('As assinaturas ainda não foram enviadas. Confira a internet e tente de novo.');
    const j = await api({ acao: 'lista-presenca', registroId: reg.id }, 240000);
    fechar();
    const bytes = Uint8Array.from(atob(j.base64), ch => ch.charCodeAt(0));
    const arq = new File([bytes], j.nome, { type: j.mime });
    let fim;
    fim = modal(h('div', null,
      h('h3', { text: 'Lista de presença gerada' }),
      h('p', { class: 'modal-txt', text: j.mensagem }),
      h('p', { class: 'peq', text: 'Código de verificação: ' + j.codigo }),
      h('div', { class: 'linha-bts' },
        h('button', { class: 'bt', text: 'Compartilhar / salvar', onclick: async () => {
          try {
            if (navigator.canShare && navigator.canShare({ files: [arq] })) await navigator.share({ files: [arq], title: arq.name });
            else { const u = URL.createObjectURL(arq); const a = h('a', { href: u, download: arq.name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 30000); toast('Arquivo salvo em Downloads.'); }
          } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
        } }),
        j.url ? h('a', { class: 'bt sec', href: j.url, target: '_blank', rel: 'noopener', text: 'Abrir no Drive' }) : null,
        h('button', { class: 'bt sec', text: 'Fechar', onclick: () => fim() }))));
  } catch (e) { fechar(); toast(e.message, 8000); }
}

/* ===================== IMPORTAR QL E FUNCIONÁRIOS (Ajustes) ===================== */
async function lerTextoArquivo(arq) {
  const buf = await arq.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch (e) { return new TextDecoder('windows-1252').decode(buf); }
}
async function importarArquivoFilial(tipo, arq) {
  if (!arq) return;
  if (!navigator.onLine) { toast('Precisa de internet para enviar o arquivo.'); return; }
  const nomeTipo = tipo === 'QL' ? 'quadro de lotação (QL)' : tipo === 'DESC' ? 'descrições das funções' : 'lista de funcionários';
  let espera = modal(h('div', null, h('div', { class: 'girando' }), h('p', { class: 'modal-txt', text: 'Lendo o arquivo...' })), { semFechar: true });
  let texto;
  try { texto = await lerTextoArquivo(arq); } catch (e) { espera(); toast('Não consegui ler o arquivo: ' + e.message); return; }
  async function previa(soFilial) {
    return api({ acao: 'importar', tipo, texto, filial: soFilial || '', aplicar: false }, 240000);
  }
  try {
    const temFilial = !!S.ctx.filial && tipo !== 'DESC';
    let soFilial = temFilial ? S.ctx.filial : '';
    let j;
    try { j = await previa(soFilial); }
    catch (e) { if (soFilial && /não tem linhas da filial/.test(e.message)) { soFilial = ''; j = await previa(''); } else throw e; }
    espera();
    const resumoTxt = r => tipo === 'DESC' ? 'Descrições: ' + r.antes + ' → ' + r.depois + ' (a tabela inteira é trocada)' : tipo === 'QL'
      ? 'Filial ' + r.filial + ': ' + r.linhasAntes + ' → ' + r.linhasDepois + ' funções; trabalhadores ' + r.totalAntes + ' → ' + r.totalDepois +
        (r.novas.length ? '. Novas: ' + r.novas.slice(0, 8).join('; ') + (r.novas.length > 8 ? '...' : '') : '') + (r.removidas.length ? '. Saem: ' + r.removidas.slice(0, 8).join('; ') + (r.removidas.length > 8 ? '...' : '') : '')
      : 'Filial ' + r.filial + ': ' + r.antes + ' → ' + r.depois + ' funcionários (' + r.entraram + ' entram, ' + r.sairam + ' saem; ' + r.secoes + ' seções)';
    const escolha = await new Promise(resolve => {
      let f;
      const caixa = h('div', null,
        h('h3', { text: 'Atualizar ' + nomeTipo }),
        h('p', { class: 'peq', text: 'Arquivo: ' + arq.name + (tipo === 'DESC' ? '' : ' · ' + j.filiaisNoArquivo + ' filial(is) no arquivo.') }),
        h('ul', { class: 'imp-resumo' }, j.resumo.slice(0, 12).map(r => h('li', { text: resumoTxt(r) }))),
        j.resumo.length > 12 ? h('p', { class: 'peq', text: '... e mais ' + (j.resumo.length - 12) + ' filial(is).' }) : null,
        tipo === 'DESC' ? null : h('p', { class: 'peq', text: soFilial ? 'Só a filial ' + soFilial + ' será trocada; as outras continuam como estão.' : 'As filiais do arquivo serão trocadas; as que não estão no arquivo continuam como estão.' }),
        h('div', { class: 'linha-bts' },
          h('button', { class: 'bt sec', text: 'Cancelar', onclick: () => { f(); resolve(null); } }),
          soFilial && j.filiaisNoArquivo > 1 ? h('button', { class: 'bt sec', text: 'Aplicar a todas as ' + j.filiaisNoArquivo + ' filiais', onclick: () => { f(); resolve('todas'); } }) : null,
          h('button', { class: 'bt', text: soFilial ? 'Aplicar à filial ' + soFilial : 'Aplicar', onclick: () => { f(); resolve(soFilial || 'todas'); } })));
      f = modal(caixa, { semFechar: true });
    });
    if (!escolha) return;
    espera = modal(h('div', null, h('div', { class: 'girando' }), h('p', { class: 'modal-txt', text: 'Gravando na planilha...' })), { semFechar: true });
    const fim = await api({ acao: 'importar', tipo, texto, filial: escolha === 'todas' ? '' : escolha, aplicar: true }, 300000);
    espera();
    toast(tipo === 'DESC' ? 'Descrições das funções atualizadas: ' + fim.linhas + ' linha(s).' : (tipo === 'QL' ? 'QL atualizado' : 'Lista de funcionários atualizada') + ': ' + fim.linhas + ' linha(s) em ' + fim.filiais.length + ' filial(is).', 6000);
    if (tipo === 'QL' || tipo === 'DESC') await baixarConfig(true); else if (S.ctx.filial) await baixarFuncionarios(S.ctx.filial, false, true);
    rotear();
  } catch (e) { try { espera(); } catch (x) { } toast(e.message, 9000); }
}

/* ==================== TRANSFERIDOR NA FOTO (RULA) ==================== */
const GONIO_PONTOS = [
  { k: 'quadril', n: 'Quadril', d: 'lateral do quadril, na altura da cintura' },
  { k: 'ombro', n: 'Ombro', d: 'ponta do ombro' },
  { k: 'cotovelo', n: 'Cotovelo', d: 'ponta do cotovelo' },
  { k: 'punho', n: 'Punho', d: 'centro do punho' },
  { k: 'mao', n: 'Mão', d: 'nós dos dedos (meio da mão)' },
  { k: 'orelha', n: 'Orelha', d: 'orelha (abertura do ouvido)' }
];
const GONIO_LINHAS = [['quadril', 'ombro'], ['ombro', 'cotovelo'], ['cotovelo', 'punho'], ['punho', 'mao'], ['ombro', 'orelha']];
const GONIO_NOMES = { braco: 'Braço', antebraco: 'Antebraço', punho: 'Punho', pescoco: 'Pescoço', tronco: 'Tronco' };

/** Ângulos (graus) a partir dos pontos. f = +1 se a pessoa está virada para a direita da foto, -1 para a esquerda. */
function calcularAngulos(P, f) {
  const vet = (a, b) => (P[a] && P[b]) ? { x: P[b].x - P[a].x, y: P[b].y - P[a].y } : null;
  const grau = r => r * 180 / Math.PI;
  const paraCima = w => grau(Math.atan2(w.x * f, -w.y));   // 0 = vertical para cima; + = para a frente
  const paraBaixo = w => grau(Math.atan2(w.x * f, w.y));   // 0 = vertical para baixo; + = para a frente
  const entre = (a, b) => grau(Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) || 1)))));
  const norm = a => ((a + 540) % 360) - 180;
  const T = vet('quadril', 'ombro'), U = vet('ombro', 'cotovelo'), F = vet('cotovelo', 'punho'), H = vet('punho', 'mao'), N = vet('ombro', 'orelha');
  const r = {};
  if (T) r.tronco = paraCima(T);                                                   // inclinação do tronco em relação à vertical
  if (U) r.braco = norm(paraBaixo(U) - (T ? paraBaixo({ x: -T.x, y: -T.y }) : 0)); // braço em relação à linha do tronco
  if (U && F) r.antebraco = entre(U, F);                                           // flexão do cotovelo
  if (F && H) r.punho = entre(F, H);                                               // desvio da mão em relação ao antebraço
  if (N) r.pescoco = norm(paraCima(N) - (T ? paraCima(T) : 0));                    // cabeça em relação ao tronco
  return r;
}
/** Faixa do RULA para cada ângulo: devolve { campo: { n, texto } }. */
function faixasRULA(a) {
  const s = {};
  if (a.braco !== undefined) { const b = a.braco; s.braco = b < -20 ? { n: 2, t: 'extensão' } : b <= 20 ? { n: 1, t: b < 0 ? 'extensão' : 'flexão' } : b <= 45 ? { n: 2, t: 'flexão' } : b <= 90 ? { n: 3, t: 'flexão' } : { n: 4, t: 'flexão' }; }
  if (a.antebraco !== undefined) s.antebraco = { n: (a.antebraco >= 60 && a.antebraco <= 100) ? 1 : 2, t: 'flexão' };
  if (a.punho !== undefined) s.punho = { n: a.punho < 5 ? 1 : a.punho <= 15 ? 2 : 3, t: a.punho < 5 ? 'neutro' : 'flexão/extensão' };
  if (a.pescoco !== undefined) { const p = a.pescoco; s.pescoco = p < -5 ? { n: 4, t: 'extensão' } : p <= 10 ? { n: 1, t: 'flexão' } : p <= 20 ? { n: 2, t: 'flexão' } : { n: 3, t: 'flexão' }; }
  if (a.tronco !== undefined) { const t = Math.abs(a.tronco); s.tronco = { n: t < 5 ? 1 : t <= 20 ? 2 : t <= 60 ? 3 : 4, t: a.tronco < -5 ? 'extensão' : 'flexão' }; }
  return s;
}
function textoAngulos(g) {
  const a = (g && g.angulos) || {};
  return Object.keys(GONIO_NOMES).filter(k => a[k] !== undefined).map(k => GONIO_NOMES[k] + ' ' + Math.round(a[k]) + '°').join(' · ');
}

/** Carrega imagem (Blob) num canvas, no máximo 1600 px no lado maior. */
async function canvasDeBlob(blob) {
  let fonte;
  try { fonte = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (e) { fonte = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); }); }
  const w = fonte.width, hh = fonte.height, k = Math.min(1, 1600 / Math.max(w, hh));
  const cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(hh * k);
  cv.getContext('2d').drawImage(fonte, 0, 0, cv.width, cv.height);
  return cv;
}
/** Escolher um quadro do vídeo. Devolve canvas ou null. */
function quadroDoVideo(blob) {
  return new Promise(resolve => {
    const u = URL.createObjectURL(blob);
    const vid = h('video', { src: u, muted: true, playsinline: true, preload: 'auto', class: 'gonio-video' });
    const barra = h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'gonio-barra' });
    const tempo = h('span', { class: 'peq', text: '0,0 s' });
    const ir = t => { vid.currentTime = Math.max(0, Math.min(vid.duration || 0, t)); };
    vid.addEventListener('loadedmetadata', () => { ir(0.01); });
    const mostrarTempo = () => { tempo.textContent = mostraNum(vid.currentTime.toFixed(1)) + ' s de ' + mostraNum((vid.duration || 0).toFixed(1)) + ' s'; if (vid.duration) barra.value = Math.round(vid.currentTime / vid.duration * 1000); };
    vid.addEventListener('timeupdate', mostrarTempo); vid.addEventListener('seeked', mostrarTempo);
    barra.addEventListener('input', () => { if (vid.duration) ir(barra.value / 1000 * vid.duration); });
    const fechar = modal(h('div', { class: 'gonio-box' },
      h('p', { class: 'assin-tit', text: 'Escolha o quadro do vídeo' }),
      h('p', { class: 'peq', text: 'Arraste a barra até o momento da postura mais crítica. Use os botões para ajustar quadro a quadro.' }),
      vid, barra, tempo,
      h('div', { class: 'linha-bts' },
        h('button', { class: 'bt sec', text: '◀ quadro', onclick: () => ir(vid.currentTime - 1 / 30) }),
        h('button', { class: 'bt sec', text: 'quadro ▶', onclick: () => ir(vid.currentTime + 1 / 30) })),
      h('div', { class: 'linha-bts' },
        h('button', { class: 'bt sec', text: 'Cancelar', onclick: () => { fechar(); URL.revokeObjectURL(u); resolve(null); } }),
        h('button', { class: 'bt', text: 'Usar este quadro', onclick: () => {
          const k = Math.min(1, 1600 / Math.max(vid.videoWidth, vid.videoHeight));
          const cv = document.createElement('canvas'); cv.width = Math.round(vid.videoWidth * k); cv.height = Math.round(vid.videoHeight * k);
          cv.getContext('2d').drawImage(vid, 0, 0, cv.width, cv.height);
          fechar(); URL.revokeObjectURL(u); resolve(cv);
        } }))), { cheio: true });
  });
}
/** Origem da imagem: fotos/vídeos do próprio registro, câmera ou arquivo. Devolve canvas ou null. */
async function escolherImagemGonio(reg) {
  const locais = [];
  for (const a of (reg.anexos || [])) {
    if (!/^(image|video)\//.test(a.mime || '')) continue;
    const b = await DB.get('blobs', a.id);
    if (b) locais.push({ a, blob: b.blob });
  }
  return new Promise(resolve => {
    let fechar;
    const usar = async blob => {
      fechar();
      try { resolve(/^video\//.test(blob.type) ? await quadroDoVideo(blob) : await canvasDeBlob(blob)); }
      catch (e) { toast('Não consegui abrir o arquivo: ' + e.message); resolve(null); }
    };
    const grade = h('div', { class: 'miniaturas' });
    locais.forEach(({ a, blob }) => {
      const u = URL.createObjectURL(blob);
      grade.appendChild(h('button', { type: 'button', class: 'thumb', onclick: () => usar(blob) },
        /^video/.test(blob.type) ? h('span', { class: 'thumb-ic', text: '▶ vídeo' }) : h('img', { src: u, alt: '' }),
        h('span', { class: 'thumb-leg', text: a.legenda || a.nome })));
    });
    const inpCam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: e => e.target.files[0] && usar(e.target.files[0]) });
    const inpArq = h('input', { type: 'file', accept: 'image/*,video/*', hidden: true, onchange: e => e.target.files[0] && usar(e.target.files[0]) });
    fechar = modal(h('div', null,
      h('h3', { text: 'Medir ângulos' }),
      h('p', { class: 'peq', text: 'Use foto ou vídeo de lado (perfil), com a câmera na altura do corpo e o corpo inteiro aparecendo. Foto de frente ou de cima distorce os ângulos.' }),
      locais.length ? h('p', { class: 'rot', text: 'Fotos e vídeos deste registro' }) : null, locais.length ? grade : null,
      h('div', { class: 'linha-bts' },
        h('label', { class: 'bt' }, '📷 Tirar foto', inpCam),
        h('label', { class: 'bt sec' }, '🖼 Escolher foto ou vídeo', inpArq),
        h('button', { class: 'bt sec', text: 'Cancelar', onclick: () => { fechar(); resolve(null); } }))));
  });
}

/** Tela de marcação dos pontos. Devolve { angulos, faixas, frente, pontos, blob } ou null. */
function marcarPontosGonio(fonte, anterior) {
  return new Promise(resolve => {
    const W = fonte.width, H = fonte.height;
    const P = {}; let atual = 0, frente = (anterior && anterior.frente) || 1, arrastando = null;
    if (anterior && anterior.pontos) Object.keys(anterior.pontos).forEach(k => { const p = anterior.pontos[k]; if (p) P[k] = { x: p.x * W, y: p.y * H }; });
    while (atual < GONIO_PONTOS.length && P[GONIO_PONTOS[atual].k]) atual++;
    const cv = h('canvas', { class: 'gonio-cv' }); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const instr = h('p', { class: 'gonio-instr' });
    const res = h('div', { class: 'gonio-res' });
    const escala = () => W / cv.getBoundingClientRect().width;
    function desenhar(ctx, final) {
      const e = Math.max(W, H) / 900;
      ctx.drawImage(fonte, 0, 0, W, H);
      ctx.lineCap = 'round';
      GONIO_LINHAS.forEach(([a, b]) => { if (P[a] && P[b]) { ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 7 * e; ctx.beginPath(); ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); ctx.stroke();
        ctx.strokeStyle = a === 'quadril' ? '#ffd54a' : '#38e0c8'; ctx.lineWidth = 4 * e; ctx.stroke(); } });
      if (P.quadril && P.ombro) { // linha vertical de referência do tronco
        ctx.setLineDash([10 * e, 8 * e]); ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 2 * e;
        ctx.beginPath(); ctx.moveTo(P.quadril.x, P.quadril.y); ctx.lineTo(P.quadril.x, P.quadril.y - Math.hypot(P.ombro.x - P.quadril.x, P.ombro.y - P.quadril.y)); ctx.stroke(); ctx.setLineDash([]);
      }
      GONIO_PONTOS.forEach((pt, i) => { const p = P[pt.k]; if (!p) return;
        ctx.fillStyle = i === atual && !final ? '#ff5a5f' : '#ffffff'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2 * e;
        ctx.beginPath(); ctx.arc(p.x, p.y, 9 * e, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); });
      const a = calcularAngulos(P, frente);
      const rotulo = (k, ponto) => { if (a[k] === undefined || !P[ponto]) return; const t = Math.round(Math.abs(a[k])) + '°';
        ctx.font = 'bold ' + Math.round(22 * e) + 'px system-ui, sans-serif'; const w = ctx.measureText(t).width;
        const x = P[ponto].x + 14 * e, y = P[ponto].y - 14 * e;
        ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(x - 4 * e, y - 22 * e, w + 8 * e, 28 * e); ctx.fillStyle = '#fff'; ctx.fillText(t, x, y); };
      rotulo('tronco', 'quadril'); rotulo('braco', 'ombro'); rotulo('antebraco', 'cotovelo'); rotulo('punho', 'punho'); rotulo('pescoco', 'orelha');
      if (final) { // legenda na própria imagem (evidência)
        const f = faixasRULA(a);
        const linhas = Object.keys(GONIO_NOMES).filter(k => a[k] !== undefined).map(k => GONIO_NOMES[k] + ': ' + Math.round(Math.abs(a[k])) + '° ' + f[k].t + ' (RULA ' + f[k].n + ')');
        linhas.push('Medido em foto de perfil (2D) · ' + dataHoraBr(agoraIso()));
        const tam = Math.round(18 * e); ctx.font = tam + 'px system-ui, sans-serif';
        const larg = Math.max(...linhas.map(l => ctx.measureText(l).width)) + 20 * e, alt = linhas.length * (tam + 6 * e) + 14 * e;
        ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(10 * e, H - alt - 10 * e, larg, alt);
        ctx.fillStyle = '#fff'; linhas.forEach((l, i) => ctx.fillText(l, 20 * e, H - alt - 10 * e + 8 * e + (i + 1) * (tam + 6 * e) - 6 * e));
      }
      return a;
    }
    function atualizar() {
      const a = desenhar(g, false);
      instr.innerHTML = '';
      if (atual < GONIO_PONTOS.length) instr.append('Toque no ', h('strong', { text: GONIO_PONTOS[atual].n }), ' (' + GONIO_PONTOS[atual].d + '). Ponto ' + (atual + 1) + ' de ' + GONIO_PONTOS.length + '.');
      else instr.append('Pontos marcados. Arraste um ponto para ajustar, ou toque em Concluir.');
      const f = faixasRULA(a);
      res.innerHTML = '';
      Object.keys(GONIO_NOMES).forEach(k => { if (a[k] === undefined) return;
        res.appendChild(h('span', { class: 'gonio-chip' }, h('strong', { text: GONIO_NOMES[k] + ' ' + Math.round(Math.abs(a[k])) + '°' }), ' ' + f[k].t + ' → ' + f[k].n)); });
      btPular.hidden = atual >= GONIO_PONTOS.length;
    }
    const pos = e => { const r = cv.getBoundingClientRect(), k = escala(); return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }; };
    cv.addEventListener('pointerdown', e => {
      e.preventDefault();
      const p = pos(e), raio = (atual < GONIO_PONTOS.length ? 10 : 26) * escala(); // marcando: só pega um ponto se tocar bem em cima dele
      const perto = GONIO_PONTOS.map(pt => pt.k).filter(k => P[k]).find(k => Math.hypot(P[k].x - p.x, P[k].y - p.y) < raio);
      if (perto) { arrastando = perto; cv.setPointerCapture(e.pointerId); return; }
      if (atual >= GONIO_PONTOS.length) return;
      P[GONIO_PONTOS[atual].k] = p; atual++;
      while (atual < GONIO_PONTOS.length && P[GONIO_PONTOS[atual].k]) atual++;
      atualizar();
    });
    cv.addEventListener('pointermove', e => { if (!arrastando) return; P[arrastando] = pos(e); atualizar(); });
    cv.addEventListener('pointerup', () => { arrastando = null; });
    const btPular = h('button', { class: 'bt sec pequeno', text: 'Pular este ponto', onclick: () => { if (atual < GONIO_PONTOS.length) { atual++; atualizar(); } } });
    const lado = chips(['◀ Virada para a esquerda', 'Virada para a direita ▶'], frente === 1 ? 'Virada para a direita ▶' : '◀ Virada para a esquerda', false, v => { frente = /esquerda/.test(v) ? -1 : 1; atualizar(); });
    const fechar = modal(h('div', { class: 'gonio-box' },
      h('div', { class: 'gonio-topo' }, h('span', { class: 'peq', text: 'A pessoa na foto está' }), lado),
      instr, h('div', { class: 'gonio-area' }, cv), res,
      h('div', { class: 'linha-bts' }, btPular,
        h('button', { class: 'bt sec pequeno', text: 'Desfazer', onclick: () => {
          for (let i = GONIO_PONTOS.length - 1; i >= 0; i--) if (P[GONIO_PONTOS[i].k]) { delete P[GONIO_PONTOS[i].k]; atual = i; break; }
          atualizar();
        } }),
        h('button', { class: 'bt sec pequeno', text: 'Cancelar', onclick: () => { fechar(); resolve(null); } }),
        h('button', { class: 'bt pequeno', text: 'Concluir', onclick: async () => {
          const a = calcularAngulos(P, frente);
          if (!Object.keys(a).length) { toast('Marque ao menos dois pontos ligados (ex.: ombro e cotovelo).'); return; }
          const out = document.createElement('canvas'); out.width = W; out.height = H;
          desenhar(out.getContext('2d'), true);
          const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.88));
          const pontos = {}; Object.keys(P).forEach(k => { pontos[k] = { x: +(P[k].x / W).toFixed(4), y: +(P[k].y / H).toFixed(4) }; });
          const ang = {}; Object.keys(a).forEach(k => { ang[k] = Math.round(a[k] * 10) / 10; });
          fechar(); resolve({ angulos: ang, faixas: faixasRULA(a), frente, pontos, blob });
        } }))), { cheio: true });
    atualizar();
  });
}

CONTROLES.goniometro = function (c, esc, path) {
  const reg = S.editor.reg, f = S.editor.f;
  const box = h('div', { class: 'gonio-campo' });
  async function desenhar() {
    box.innerHTML = '';
    const v = esc[c.id];
    if (v && v.anexo) {
      const u = await urlDoAnexo(v.anexo);
      if (u) box.appendChild(h('img', { class: 'gonio-prev', src: u, alt: 'ângulos medidos', onclick: () => { let fx; fx = modal(h('div', null, h('img', { class: 'ver-img', src: u }), h('button', { class: 'bt larga', text: 'Fechar', onclick: () => fx() }))); } }));
      box.appendChild(h('p', { class: 'peq', text: textoAngulos(v) + (v.em ? ' · medido em ' + dataHoraBr(v.em) : '') }));
    }
    box.appendChild(h('div', { class: 'linha-bts' }, h('button', { type: 'button', class: 'bt' + (v && v.anexo ? ' sec' : ''), text: v && v.anexo ? '📐 Medir de novo' : '📐 Medir ângulos na foto ou no vídeo', onclick: medir })));
  }
  async function medir() {
    await salvarEditorAgora();
    const fonte = await escolherImagemGonio(reg);
    if (!fonte) return;
    const r = await marcarPontosGonio(fonte, null);
    if (!r) return;
    if (esc[c.id] && esc[c.id].anexo) await removerAnexo(reg, esc[c.id].anexo);
    const a = await adicionarAnexo(reg, path, c, r.blob, 'angulos', 'jpg');
    a.legenda = 'Ângulos medidos: ' + textoAngulos({ angulos: r.angulos });
    esc[c.id] = { anexo: a.id, angulos: r.angulos, frente: r.frente, pontos: r.pontos, em: agoraIso() };
    // preenche o RULA com a faixa de cada ângulo
    const feitos = [];
    Object.keys(r.faixas).forEach(k => {
      const campo = f.campos.find(x => x.id === k);
      if (!campo || !campo.opcoes) return;
      const op = campo.opcoes.find(o => o.startsWith(r.faixas[k].n + ' - '));
      if (!op) return;
      reg.valores[k] = op; feitos.push(GONIO_NOMES[k]);
      const ch = document.querySelector('.chips[data-campo="' + k + '"]'); if (ch && ch.definir) ch.definir(op);
    });
    alterou(); await salvarEditorAgora(); desenhar();
    toast(feitos.length ? 'Preenchido pelas medidas: ' + feitos.join(', ') + '. Confira e marque os ajustes (+1) à mão.' : 'Ângulos salvos.', 7000);
  }
  desenhar();
  return box;
};

/* ======================= TEMA E EFEITO DE CLIQUE ======================= */
function aplicarTema() {
  const t = S.ajustes.tema || 'auto';
  const escuro = t === 'escuro' || (t === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.tema = escuro ? 'escuro' : 'claro';
  try { localStorage.setItem('tema', t); } catch (e) { }
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = escuro ? '#10232a' : '#1f4e5f';
}
function ligarEfeitoClique() {
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest('.bt, .chip, .item-form, .item-reg, .tile, #nav a, .status');
    if (!el || el.disabled) return;
    const r = el.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2;
    const o = document.createElement('span');
    o.className = 'onda';
    o.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
    el.appendChild(o);
    setTimeout(() => o.remove(), 550);
  }, { passive: true });
}

async function iniciar() {
  S.ajustes = (await DB.kvGet('ajustes')) || S.ajustes;
  aplicarTema();
  ligarEfeitoClique();
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if ((S.ajustes.tema || 'auto') === 'auto') aplicarTema(); });
  S.ctx = (await DB.kvGet('ctx')) || S.ctx;
  S.extras = (await DB.kvGet('extras')) || S.extras;
  S.cfg = (await DB.kvGet('config')) || null;
  (await DB.all('registros')).forEach(r => S.regs.set(r.id, r));

  $('#voltar').addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#/'));
  $('#status').addEventListener('click', () => sincronizar(true));
  window.addEventListener('hashchange', rotear);
  window.addEventListener('online', () => { atualizarStatus(); setTimeout(() => sincronizar(false), 1500); });
  window.addEventListener('offline', atualizarStatus);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') salvarEditorAgora(); else if (navigator.onLine) setTimeout(() => sincronizar(false), 800); });
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.instalar = e; if (!location.hash || location.hash === '#/') rotear(); });
  setInterval(() => { if (navigator.onLine && !S.sinc && document.visibilityState === 'visible') sincronizar(false); }, 120000);

  if ('serviceWorker' in navigator && !window.SERVIDOR_DEMO) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      const avisar = w => {
        const av = $('#aviso');
        av.textContent = 'Nova versão do app disponível. Toque aqui para atualizar.';
        av.hidden = false;
        av.onclick = async () => { await salvarEditorAgora(); w.postMessage('pular'); };
      };
      if (reg.waiting && navigator.serviceWorker.controller) avisar(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) avisar(w); });
      });
      let recarregou = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (!recarregou) { recarregou = true; location.reload(); } });
    } catch (e) { }
  }

  if (window.SERVIDOR_DEMO && !S.ajustes.url) {
    S.ajustes = { url: 'demo', chave: 'demo', avaliador: 'IVANEY', carimbo: true };
    await DB.kvSet('ajustes', S.ajustes);
    await baixarConfig(true);
    if (!S.ctx.filial) { S.ctx.filial = (filiais()[0] || {}).codigo || ''; await DB.kvSet('ctx', S.ctx); }
  }
  atualizarStatus();
  rotear();
  if (navigator.onLine && S.ajustes.url && S.ajustes.chave) {
    const idade = S.cfg ? Date.now() - new Date(S.cfg.geradoEm).getTime() : Infinity;
    const versaoAnterior = await DB.kvGet('versaoApp');
    if (idade > 3600000 || versaoAnterior !== VERSAO_APP) {
      if (await baixarConfig(true)) await DB.kvSet('versaoApp', VERSAO_APP);
      if (!location.hash || location.hash === '#/' || location.hash.startsWith('#/r/')) rotear();
    }
    sincronizar(false);
    if (S.ctx.filial) baixarFuncionarios(S.ctx.filial, false);
  }
}

iniciar();
