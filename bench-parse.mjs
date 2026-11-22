// Замер CPU-времени парсинга: пригодность для бесплатного Cloudflare Workers (10 мс CPU).
import { performance } from 'node:perf_hooks';

import { parseMatchList, parseMatchPage } from './scripts/championat.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

async function text(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  return res.text();
}

const listHtml = await text('https://www.championat.com/hockey/_superleague.html');
const matchHtml = await text('https://www.championat.com/hockey/_superleague/tournament/7092/match/1316820/?text-all');

console.log('размер списка, КБ:', Math.round(listHtml.length / 1024));
console.log('размер страницы матча, КБ:', Math.round(matchHtml.length / 1024));

function bench(label, fn, runs = 20) {
  fn(); // прогрев
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p90 = samples[Math.floor(samples.length * 0.9)];
  console.log(`${label}: медиана ${median.toFixed(2)} мс, p90 ${p90.toFixed(2)} мс`);
  return median;
}

bench('парсинг списка матчей', () => parseMatchList(listHtml));
bench('парсинг страницы матча', () => parseMatchPage(matchHtml));
bench('оба сразу', () => {
  parseMatchList(listHtml);
  parseMatchPage(matchHtml);
});
