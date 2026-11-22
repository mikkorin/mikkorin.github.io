// @ts-check
/**
 * Data access for the "Новости Чемпионата" Mini App.
 *
 * Every source below is public championat.com content:
 *  - The KHL section page for the match picker (schedule + live table).
 *  - A single match page rendered with `?text-all` for the text broadcast.
 *  - The Rambler Comments widget API that championat.com embeds for match comments.
 */

import { request as nodeHttpRequest } from 'node:http';
import { request as nodeHttpsRequest } from 'node:https';

export const USER_AGENT =
  'ChampionatNewsMiniApp/1.0 (Mini App reading public championat.com pages)';

const KHL_SECTION_URL = 'https://www.championat.com/hockey/_superleague.html';
const KHL_TOURNAMENT_ID = '7092';
const KHL_TOURNAMENT_PATH = `/hockey/_superleague/tournament/${KHL_TOURNAMENT_ID}/`;
const COMMENTS_URL = 'https://comments.rambler.ru/api/v2/json/get_comments';
const COMMENTS_APP_ID = 5;

const REQUEST_TIMEOUT_MS = 20000;

/* ------------------------------------------------------------------ HTTP --- */

function rawRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Некорректный URL: ${url}`));
      return;
    }
    const library = target.protocol === 'http:' ? nodeHttpRequest : nodeHttpsRequest;
    const request = library(
      target,
      { method, headers: { 'user-agent': USER_AGENT, ...headers }, timeout: timeoutMs },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('Истекло время ожидания ответа')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function httpRequest(url, options = {}, redirectsLeft = 4) {
  const response = await rawRequest(url, options);
  const status = response.status;
  if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirectsLeft > 0) {
    const next = new URL(response.headers.location, url).toString();
    const keepBody = status === 307 || status === 308;
    return httpRequest(
      next,
      keepBody ? options : { ...options, method: 'GET', body: null },
      redirectsLeft - 1,
    );
  }
  return response;
}

async function fetchText(url, options = {}) {
  const response = await httpRequest(url, options);
  const text = response.body.toString('utf8');
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Источник ответил кодом ${response.status}`);
  }
  return text;
}

/* --------------------------------------------------------------- parsing --- */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  deg: '°',
  laquo_ru: '«',
};

/** Decodes XML/HTML entities, including numeric ones. */
export function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, code) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const numeric = Number.parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(numeric) || numeric <= 0) return match;
      try {
        return String.fromCodePoint(numeric);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named ?? match;
  });
}

/** Removes markup and collapses whitespace, then decodes entities. */
export function plainText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[\s ]+/g, ' '),
  ).trim();
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? plainText(match[1]) : '';
}

/* --------------------------------------------------------- HTML scanning --- */

/** Yields every opening tag of `tagName` together with its class tokens. */
function* elements(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'g');
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0];
    const classAttr = /class="([^"]*)"/.exec(tag)?.[1] ?? '';
    yield {
      tokens: classAttr.split(/\s+/).filter(Boolean),
      dataType: /data-type="([^"]*)"/.exec(tag)?.[1] ?? '',
      start: match.index,
      contentStart: match.index + tag.length,
    };
  }
}

/** Returns the inner HTML of the element that opens at `contentStart`, honouring nesting. */
function innerOf(html, contentStart, tagName) {
  const re = new RegExp(`<(/)?${tagName}\\b[^>]*>`, 'g');
  re.lastIndex = contentStart;
  let depth = 1;
  let match;
  while ((match = re.exec(html)) !== null) {
    if (match[1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(contentStart, match.index);
    } else {
      depth += 1;
    }
  }
  return html.slice(contentStart);
}

/** Finds the first element carrying `className` and returns its inner HTML. */
function innerByClass(html, className, from = 0) {
  for (const tagName of ['div', 'span', 'p', 'td', 'li']) {
    for (const element of elements(html, tagName)) {
      if (element.start < from) continue;
      if (element.tokens.includes(className)) return innerOf(html, element.contentStart, tagName);
    }
  }
  return '';
}

/** Finds every element carrying `className` and returns their inner HTML. */
function allInnerByClass(html, className) {
  const found = [];
  for (const tagName of ['div', 'span']) {
    for (const element of elements(html, tagName)) {
      if (element.tokens.includes(className)) found.push(innerOf(html, element.contentStart, tagName));
    }
  }
  return found;
}


/** Reads "21.11.2026 14:00" (Moscow time) as an ISO timestamp. */
export function moscowTimestamp(dateText, timeText) {
  const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(dateText ?? '');
  const time = /^(\d{1,2}):(\d{2})$/.exec((timeText ?? '').trim());
  if (!date || !time) return null;
  const [, day, month, year] = date;
  const [, hour, minute] = time;
  return `${year}-${month}-${day}T${hour.padStart(2, '0')}:${minute}:00+03:00`;
}

/* ---------------------------------------------------------------- matches --- */

/** Parses the KHL section page into a match list. */
export function parseMatchList(html) {
  const live = new Map();
  for (const match of html.matchAll(/<li class="livetable-event">([\s\S]*?)<\/li>/g)) {
    const block = match[1];
    const href = /href="([^"]*match\/(\d+)\/[^"]*)"/.exec(block);
    if (!href) continue;
    const teams = [...block.matchAll(/team-name">([\s\S]*?)<\/span>/g)].map((m) => plainText(m[1]));
    live.set(href[2], {
      url: href[1].startsWith('http') ? href[1] : `https://www.championat.com${href[1]}`,
      teams,
      score: tagText(block, 'livetable-event__result').replace(/–/g, '–').trim(),
      status: tagText(block, 'livetable-event__status'),
      time: tagText(block, 'livetable-event__time'),
    });
  }

  const matches = [];
  const seen = new Set();
  for (const match of html.matchAll(
    /<tr class="stat-results__row"([^>]*)>([\s\S]*?)<\/tr>/g,
  )) {
    const attributes = match[1] ?? '';
    const block = match[2];
    const href = /href="([^"]*match\/(\d+)\/[^"]*)"/.exec(block);
    if (!href || !href[1].includes(KHL_TOURNAMENT_PATH)) continue;
    const id = href[2];
    if (seen.has(id)) continue;
    seen.add(id);

    const dateTimeCell = /stat-results__date-time[^>]*>([\s\S]*?)<\/td>/.exec(block);
    const rawDateTime = dateTimeCell ? plainText(dateTimeCell[1]) : '';
    const [dateText, timeText] = rawDateTime.split(' ').filter(Boolean);
    const teams = [...block.matchAll(/table-item__name">([\s\S]*?)<\/span>/g)].map((m) =>
      plainText(m[1]),
    );
    const scoreCell = /stat-results__count-main">([\s\S]*?)<\/span>/.exec(block);
    const score = scoreCell ? plainText(scoreCell[1]) : '';
    const played = /data-played="1"/.test(attributes);
    const liveEntry = live.get(id);

    let status = liveEntry?.status || '';
    if (!status) {
      if (!played) status = 'Не начался';
      else if (score && score !== '– : –') status = 'Завершён';
      else status = 'Не начался';
    }

    matches.push({
      id,
      url: `https://www.championat.com${href[1]}`,
      home: teams[0] ?? '',
      away: teams[1] ?? '',
      time: timeText ?? '',
      date: dateText ?? '',
      startsAt: moscowTimestamp(dateText, timeText),
      score: liveEntry?.score && liveEntry.score.replace(/\s+/g, ' ') || score,
      status,
      live: /период|тайм/i.test(status),
      played,
    });
  }

  matches.sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''));
  return matches;
}

/** Fetches the KHL match list (schedule plus live table). */
export async function fetchMatches() {
  const html = await fetchText(KHL_SECTION_URL);
  const matches = parseMatchList(html);
  if (matches.length === 0) throw new Error('Список матчей КХЛ не удалось разобрать');
  return matches;
}

/* ------------------------------------------------------------- broadcast --- */

/** Parses a match page rendered with `?text-all`. */
export function parseMatchPage(html) {
  const teams = allInnerByClass(html, 'match-info__team-name').map((inner) => plainText(inner));
  const status = plainText(innerByClass(html, 'match-info__status'));
  const score = plainText(innerByClass(html, 'match-info__score-total'));

  // The broadcast tab body is filled server-side when the page is requested with ?text-all.
  let scope = '';
  for (const element of elements(html, 'div')) {
    if (element.dataType === 'text-all' && element.tokens.includes('js-tournament-tab-content')) {
      scope = innerOf(html, element.contentStart, 'div');
      break;
    }
  }

  const broadcast = [];
  const rows = scope.split(/<div class="match__live-row/).slice(1);
  for (const row of rows) {
    const text = plainText(innerByClass(row, 'match__live-text'));
    if (!text) continue;
    const minute = plainText(innerByClass(row, 'match__live-time'));
    const scoreCell = plainText(innerByClass(row, 'match__live-score'));
    const name = plainText(innerByClass(row, 'match__live-name'));
    broadcast.push({
      minute,
      score: scoreCell,
      name,
      text,
      goal: /^ГОЛ!/i.test(text),
    });
  }
  // Страница отдаёт события от новых к старым — так они и показываются:
  // самое свежее событие всегда сверху.

  let preview = '';
  if (broadcast.length === 0) {
    preview = allInnerByClass(html, 'match-text')
      .flatMap((inner) => [...inner.matchAll(/<p>([\s\S]*?)<\/p>/g)])
      .map((m) => plainText(m[1]))
      .filter(Boolean)
      .join(' ');
  }

  return {
    home: teams[0] ?? '',
    away: teams[1] ?? '',
    status,
    score: score.replace(/\s+/g, ' ').trim(),
    broadcast,
    preview,
  };
}

/** Fetches the text broadcast of one match. */
export async function fetchMatch(matchId, tournamentId = KHL_TOURNAMENT_ID) {
  const url = `https://www.championat.com/hockey/_superleague/tournament/${tournamentId}/match/${matchId}/?text-all`;
  const html = await fetchText(url);
  const parsed = parseMatchPage(html);
  return {
    id: matchId,
    url: `https://www.championat.com/hockey/_superleague/tournament/${tournamentId}/match/${matchId}/`,
    ...parsed,
  };
}

/* -------------------------------------------------------------- comments --- */

/** Fetches the match comments thread from the Rambler Comments widget API. */
export async function fetchComments(matchId) {
  const payload = JSON.stringify({
    appId: COMMENTS_APP_ID,
    xid: `match_${matchId}`,
    comments_sorting: 'most_popular',
  });
  const text = await fetchText(COMMENTS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: payload,
  });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Ответ сервиса комментариев не удалось разобрать');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Некорректный ответ сервиса комментариев');
  if (parsed.status && parsed.status !== 200) {
    throw new Error(parsed.message || 'Сервис комментариев вернул ошибку');
  }
  const raw = Array.isArray(parsed.result) ? parsed.result : [];
  return buildCommentTree(raw);
}

/** Turns the flat comment list into a threaded tree. */
export function buildCommentTree(raw) {
  const byId = new Map();
  for (const item of raw) {
    if (!item || typeof item.id !== 'number') continue;
    byId.set(item.id, {
      id: item.id,
      text: plainText(item.text || item.html || ''),
      author: plainText(item.displayName || item.username || 'Аноним'),
      createdAt: item.createdAt ?? null,
      parentId: item.parentId ?? null,
      level: Number.isFinite(item.level) ? item.level : 0,
      verified: Boolean(item.isVerified),
      children: [],
    });
  }

  const roots = [];
  for (const comment of byId.values()) {
    const parent = comment.parentId ? byId.get(comment.parentId) : undefined;
    if (parent) parent.children.push(comment);
    else roots.push(comment);
  }

  const byTime = (a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0);
  const sortTree = (list) => {
    list.sort(byTime);
    for (const item of list) sortTree(item.children);
  };
  sortTree(roots);
  return { roots, total: byId.size };
}
