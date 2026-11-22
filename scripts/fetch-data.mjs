// @ts-check
/**
 * Сборка статического снимка данных для сайта «Хоккей на Чемпионате».
 *
 * GitHub Pages не умеет исполнять серверный код, а страницы championat.com
 * не отдают CORS-заголовки, поэтому браузер не может забрать их сам.
 * Скрипт заранее ходит на championat.com, разбирает страницы теми же
 * парсерами, что использует Mini App, и складывает результат в
 * public/data/snapshot.json. Сайт затем читает этот файл.
 *
 * Запуск: node scripts/fetch-data.mjs
 */

import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchComments, fetchMatch, fetchMatches } from './championat.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const PUBLIC = join(ROOT, 'public');

/** Сколько матчей получают полную трансляцию и комментарии. */
const MAX_DETAIL = 4;
/** Сколько последних завершённых матчей добавлять к сегодняшним. */
const RECENT_COUNT = 2;

/** Сегодняшняя дата по московскому времени, в формате dd.mm.yyyy. */
function moscowToday() {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Europe/Moscow',
    }).format(new Date());
  } catch {
    return '';
  }
}

async function main() {
  const startedAt = Date.now();
  const matches = await fetchMatches();
  const today = moscowToday();

  // Сегодняшние матчи, идущий матч и пара последних завершённых —
  // это то, что реально смотрят чаще всего.
  const todays = matches.filter((m) => m.date === today);
  const live = matches.filter((m) => m.live);
  const recent = matches
    .filter((m) => m.played && m.date < today)
    .slice(-RECENT_COUNT);

  const chosen = [];
  for (const match of [...live, ...todays, ...recent]) {
    if (!chosen.some((m) => m.id === match.id)) chosen.push(match);
  }
  const detailed = chosen.slice(0, MAX_DETAIL);

  console.log(`матчей в списке: ${matches.length}, деталей собираем: ${detailed.length}`);

  const details = {};
  for (const match of detailed) {
    try {
      const detail = await fetchMatch(match.id);
      const comments = await fetchComments(match.id);
      details[match.id] = {
        id: match.id,
        url: detail.url,
        home: detail.home,
        away: detail.away,
        status: detail.status,
        score: detail.score,
        broadcast: detail.broadcast,
        preview: detail.preview,
        comments: comments.roots,
        commentsTotal: comments.total,
      };
      console.log(
        `  ${match.id} ${detail.home} — ${detail.away}: событий ${detail.broadcast.length}, комментариев ${comments.total}`,
      );
    } catch (error) {
      console.warn(`  ${match.id}: не удалось собрать данные — ${error.message}`);
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    today,
    matches,
    details,
  };

  await mkdir(join(PUBLIC, 'data'), { recursive: true });
  await cp(SITE, PUBLIC, { recursive: true });
  await writeFile(
    join(PUBLIC, 'data', 'snapshot.json'),
    JSON.stringify(snapshot, null, 0),
    'utf8',
  );

  console.log(
    `снимок готов за ${Math.round((Date.now() - startedAt) / 1000)} с → public/data/snapshot.json`,
  );
}

main().catch((error) => {
  console.error('Сборка не удалась:', error);
  process.exitCode = 1;
});
