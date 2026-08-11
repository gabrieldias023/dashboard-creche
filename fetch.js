// scripts/fetch.js
// Puxa métricas ORGÂNICAS da conta do Instagram e grava um snapshot diário em
// docs/data/snapshots_ig.json, sem duplicar a data.
//
// Caminho: "Instagram API com login do Instagram" (host graph.instagram.com),
// que NÃO exige Página do Facebook. Permissões usadas no token:
//   instagram_business_basic, instagram_business_manage_insights
//
// Uso local:  node scripts/fetch.js
//   (lê META_TOKEN e IG_USER_ID de um arquivo .env na raiz, que fica no
//    .gitignore, OU de variáveis de ambiente já exportadas)
//
// No GitHub Actions os valores vêm dos Secrets, injetados como env var.
// NUNCA hardcode token/IDs aqui.

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const GRAPH_HOST = process.env.GRAPH_HOST || 'https://graph.instagram.com';
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v23.0';
const BASE = `${GRAPH_HOST}/${GRAPH_VERSION}`;
const TZ = 'America/Sao_Paulo'; // fuso pra definir "o dia" do snapshot
// Fica dentro de docs/ para o GitHub Pages conseguir servir o JSON junto do front.
const SNAPSHOT_PATH = path.join(__dirname, 'snapshots_ig.json');

// ---------------------------------------------------------------------------
// Carrega .env local (sem dependência externa). Se não existir, ignora e
// usa as env vars que já estiverem no ambiente (caso do Actions).
// ---------------------------------------------------------------------------
function loadDotenv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function todayInTZ(tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

function isoToLocalDate(iso, tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

async function graphGet(pathAndQuery) {
  const token = process.env.META_TOKEN;
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${BASE}${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = body.error || {};
    console.error(
      `[Graph API] HTTP ${res.status} em ${pathAndQuery}\n` +
        `  message: ${err.message || '(sem mensagem)'}\n` +
        `  type:    ${err.type || '-'}  code: ${err.code ?? '-'}`
    );
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Coletores
// ---------------------------------------------------------------------------
async function getFollowers(igUserId) {
  const data = await graphGet(`/${igUserId}?fields=followers_count`);
  return typeof data.followers_count === 'number' ? data.followers_count : null;
}

async function getAccountInsights(igUserId) {
  const metrics = ['reach', 'views', 'total_interactions'];
  const out = { reach: null, views: null, total_interactions: null };
  let body;
  try {
    body = await graphGet(
      `/${igUserId}/insights` +
        `?metric=${metrics.join(',')}` +
        `&period=day&metric_type=total_value`
    );
  } catch (e) {
    console.error('[insights] falhou, gravando insights como null:', e.message);
    return out;
  }
  for (const item of body.data || []) {
    const val =
      item?.total_value?.value ??
      (Array.isArray(item?.values) ? item.values[0]?.value : undefined) ??
      null;
    if (item?.name in out) out[item.name] = typeof val === 'number' ? val : null;
  }
  return out;
}

async function getComentariosDoDia(igUserId, dataAlvo) {
  let total = 0;
  let encontrouAlgum = false;
  // Se a coleta de mídias falhar (permissão, endpoint etc.), NÃO derrubamos o
  // snapshot do dia: apenas gravamos comentários como 0 e seguimos.
  try {
    let next = `/${igUserId}/media?fields=timestamp,comments_count&limit=50`;
    for (let page = 0; page < 20 && next; page++) {
      const body = await graphGet(next);
      const items = body.data || [];
      let passouDoDia = false;
      for (const m of items) {
        if (!m.timestamp) continue;
        const d = isoToLocalDate(m.timestamp);
        if (d === dataAlvo) {
          total += typeof m.comments_count === 'number' ? m.comments_count : 0;
          encontrouAlgum = true;
        } else if (d < dataAlvo) {
          passouDoDia = true;
          break;
        }
      }
      if (passouDoDia) break;
      const nextUrl = body?.paging?.next;
      if (nextUrl) {
        const u = new URL(nextUrl);
        u.searchParams.delete('access_token');
        next = u.pathname.replace(`/${GRAPH_VERSION}`, '') + '?' + u.searchParams.toString();
      } else {
        next = null;
      }
    }
  } catch (e) {
    console.error('[comentarios] falhou, gravando 0:', e.message);
    return 0;
  }
  return encontrouAlgum ? total : 0;
}

// ---------------------------------------------------------------------------
// Persistência (sem duplicar data)
// ---------------------------------------------------------------------------
function upsertSnapshot(snapshot) {
  let arr = [];
  if (fs.existsSync(SNAPSHOT_PATH)) {
    try {
      arr = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = [];
    }
  }
  arr = arr.filter((it) => it.data !== snapshot.data);
  arr.push(snapshot);
  arr.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(arr, null, 2) + '\n', 'utf8');
  return arr.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  loadDotenv();
  const token = process.env.META_TOKEN;
  if (!token) {
    console.error('Falta a variável de ambiente META_TOKEN (via .env local ou GitHub Secrets).');
    process.exit(1);
  }
  // Com o token de "Instagram Login", "me" resolve a conta autenticada.
  const igUserId = process.env.IG_USER_ID || 'me';
  const dataAlvo = todayInTZ();
  console.log(`Coletando snapshot para ${dataAlvo} (${TZ})...`);
  const [seguidores, insights, comentarios] = await Promise.all([
    getFollowers(igUserId),
    getAccountInsights(igUserId),
    getComentariosDoDia(igUserId, dataAlvo),
  ]);
  const snapshot = {
    data: dataAlvo,
    seguidores,
    alcance: insights.reach,
    visualizacoes: insights.views,
    comentarios,
    engajamento: insights.total_interactions,
  };
  console.log('Snapshot:', JSON.stringify(snapshot));
  const n = upsertSnapshot(snapshot);
  console.log(`Gravado em snapshots_ig.json (${n} dias no total).`);
}

main().catch((e) => {
  console.error('Erro fatal:', e.message);
  process.exit(1);
});
