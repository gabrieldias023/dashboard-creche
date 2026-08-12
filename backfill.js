'use strict';
// backfill.js — puxa o histórico de 2026 (uma vez) e enche snapshots_ig.json.
// Métricas diárias: alcance (reach), visualizações (views), engajamento
// (total_interactions) via insights com since/until em BRT; comentários por dia
// via /me/media. Seguidores NÃO tem histórico na API (fica null nos dias antigos).
// Roda no GitHub Actions com o secret META_TOKEN. Não sobrescreve dados reais.

const fs = require('fs');
const path = require('path');

const GRAPH_HOST = process.env.GRAPH_HOST || 'https://graph.instagram.com';
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v23.0';
const BASE = `${GRAPH_HOST}/${GRAPH_VERSION}`;
const TZ = 'America/Sao_Paulo';
const OFFSET = '-03:00'; // BRT o ano todo (Brasil não tem horário de verão)
const SNAPSHOT_PATH = path.join(__dirname, 'snapshots_ig.json');
const START = process.env.BACKFILL_START || '2026-01-01';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fmtTZ(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function todayInTZ() { return fmtTZ(new Date()); }
function isoToLocalDate(iso) { return fmtTZ(new Date(iso)); }
function dayUnix(dateStr) { return Math.floor(Date.parse(`${dateStr}T00:00:00${OFFSET}`) / 1000); }
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00${OFFSET}`);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtTZ(d);
}

async function graphGet(pathAndQuery) {
  const token = process.env.META_TOKEN;
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${BASE}${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (res.ok && !body.error) return body;
    const err = body.error || {};
    const rateLimited =
      res.status === 429 || [4, 17, 32, 613].includes(err.code);
    if (rateLimited) {
      const wait = Math.min(60000, (attempt + 1) * 15000);
      console.error(`  rate limit (code ${err.code}); esperando ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} ${err.message || ''} (code ${err.code ?? '-'})`);
  }
  throw new Error('rate limit persistente');
}

async function dayInsights(dateStr) {
  const since = dayUnix(dateStr);
  const until = dayUnix(addDays(dateStr, 1));
  const out = { reach: null, views: null, total_interactions: null };
  try {
    const body = await graphGet(
      `/me/insights?metric=reach,views,total_interactions` +
      `&period=day&metric_type=total_value&since=${since}&until=${until}`
    );
    for (const item of body.data || []) {
      const val =
        item?.total_value?.value ??
        (Array.isArray(item?.values) ? item.values[0]?.value : undefined) ??
        null;
      if (item?.name in out) out[item.name] = typeof val === 'number' ? val : null;
    }
  } catch (e) {
    console.error(`  [${dateStr}] insights falhou: ${e.message}`);
  }
  return out;
}

async function commentsByDay() {
  const map = {};
  try {
    let next = `/me/media?fields=timestamp,comments_count&limit=50`;
    for (let page = 0; page < 200 && next; page++) {
      const body = await graphGet(next);
      for (const m of body.data || []) {
        if (!m.timestamp) continue;
        const d = isoToLocalDate(m.timestamp);
        map[d] = (map[d] || 0) + (typeof m.comments_count === 'number' ? m.comments_count : 0);
      }
      const nextUrl = body?.paging?.next;
      if (nextUrl) {
        const u = new URL(nextUrl);
        u.searchParams.delete('access_token');
        next = u.pathname.replace(`/${GRAPH_VERSION}`, '') + '?' + u.searchParams.toString();
      } else {
        next = null;
      }
      await sleep(200);
    }
  } catch (e) {
    console.error('  [comentarios] parou:', e.message);
  }
  return map;
}

function loadSnapshots() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return [];
  try {
    const a = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function save(arr) {
  arr.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

async function main() {
  if (!process.env.META_TOKEN) {
    console.error('Falta META_TOKEN (secret do GitHub).');
    process.exit(1);
  }
  const hoje = todayInTZ();
  const dias = [];
  let d = START;
  while (d < hoje) { dias.push(d); d = addDays(d, 1); } // vai só até ontem; hoje é do job diário
  console.log(`Backfill de ${dias.length} dias: ${dias[0]} .. ${dias[dias.length - 1]}`);

  const comentarios = await commentsByDay();
  const byDate = {};
  for (const s of loadSnapshots()) byDate[s.data] = s;

  let novos = 0;
  for (const dia of dias) {
    if (byDate[dia] && byDate[dia].alcance != null) continue; // já tem dado real, pula
    const ins = await dayInsights(dia);
    byDate[dia] = {
      data: dia,
      seguidores: null, // API não devolve seguidores histórico
      alcance: ins.reach,
      visualizacoes: ins.views,
      comentarios: comentarios[dia] || 0,
      engajamento: ins.total_interactions,
    };
    novos++;
    if (novos % 10 === 0) console.log(`  ...${novos} dias processados`);
    await sleep(300);
  }

  const arr = Object.values(byDate);
  save(arr);
  console.log(`Pronto. ${novos} dias preenchidos; ${arr.length} no total em snapshots_ig.json.`);
}

main().catch((e) => { console.error('Erro fatal:', e.message); process.exit(1); });
