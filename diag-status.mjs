// Диагностика статуса матча: что реально лежит в разметке championat.com.
import { readFile } from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const MATCH_ID = process.argv[2] || '1316820';

async function text(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ru-RU,ru;q=0.9' } });
  return res.text();
}

function plain(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

const listHtml = await text('https://www.championat.com/hockey/_superleague.html');
const matchHtml = await text(
  `https://www.championat.com/hockey/_superleague/tournament/7092/match/${MATCH_ID}/?text-all`,
);

console.log('=== live-таблица (livetable-event) ===');
for (const m of listHtml.matchAll(/<li class="livetable-event">([\s\S]*?)<\/li>/g)) {
  const block = m[1];
  const href = /href="([^"]*match\/(\d+)\/[^"]*)"/.exec(block);
  const status = /livetable-event__status[^>]*>([\s\S]*?)<\/span>/.exec(block);
  const result = /livetable-event__result[^>]*>([\s\S]*?)<\/span>/.exec(block);
  const time = /livetable-event__time[^>]*>([\s\S]*?)<\/span>/.exec(block);
  console.log(
    `  id=${href?.[2]} статус="${plain(status?.[1] || '')}" счёт="${plain(result?.[1] || '')}" время="${plain(time?.[1] || '')}"`,
  );
}

console.log('\n=== все вхождения match-info__status на странице матча ===');
const re = /<(\w+)[^>]*class="([^"]*match-info__status[^"]*)"[^>]*>([\s\S]*?)<\/\1>/g;
let count = 0;
for (const m of matchHtml.matchAll(re)) {
  count += 1;
  console.log(`  [${count}] <${m[1]} class="${m[2]}"> → "${plain(m[3])}"`);
}
if (count === 0) console.log('  не найдено');

console.log('\n=== фрагменты вокруг match-info__status ===');
let idx = -1;
let n = 0;
while ((idx = matchHtml.indexOf('match-info__status', idx + 1)) !== -1 && n < 6) {
  n += 1;
  console.log(`  --- ${n} ---`);
  console.log('  ' + matchHtml.slice(Math.max(0, idx - 200), idx + 300).replace(/\s+/g, ' '));
}

console.log('\n=== строки статусов результатов (stat-results) ===');
for (const m of listHtml.matchAll(/<tr class="stat-results__row"([^>]*)>([\s\S]*?)<\/tr>/g)) {
  const block = m[2];
  const href = /href="([^"]*match\/(\d+)\/[^"]*)"/.exec(block);
  if (!href) continue;
  const status = /stat-results__status[^>]*>([\s\S]*?)<\/span>/.exec(block);
  const score = /stat-results__count-main[^>]*>([\s\S]*?)<\/span>/.exec(block);
  const dateTime = /stat-results__date-time[^>]*>([\s\S]*?)<\/td>/.exec(block);
  if (href[2] === MATCH_ID) {
    console.log(`  id=${href[2]} статус="${plain(status?.[1] || '')}" счёт="${plain(score?.[1] || '')}" время="${plain(dateTime?.[1] || '')}"`);
  }
}
