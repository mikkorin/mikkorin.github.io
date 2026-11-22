# Хоккей на Чемпионате

Статическая версия Mini App «Хоккей на Чемпионате»: выбор матча КХЛ, текстовая
трансляция и комментарии с Championat.com.

Сайт: <https://mikkorin.github.io/>

## Как это устроено

GitHub Pages умеет только отдавать статику, а страницы championat.com не
отдают CORS-заголовки — браузер не может забрать их напрямую. Поэтому данные
заранее собираются на сервере:

1. `scripts/fetch-data.mjs` ходит на championat.com, разбирает список матчей КХЛ,
   текстовую трансляцию и комментарии (Rambler Comments API).
2. Результат складывается в `public/data/snapshot.json`.
3. `site/` копируется в `public/`, и GitHub Actions публикует `public/` на Pages.

Снимок обновляется по расписанию — раз в 15 минут (GitHub запускает cron с
задержкой, так что фактически данные обновляются примерно раз в 15–30 минут;
при смене сектора трансляции это особенно заметно).

Кнопка «Обновить» и автообновление в браузере перечитывают `snapshot.json` с
обходом кэша CDN (`?t=<время>`) — то есть они подхватывают новый снимок, как
только он появился.

### Почему комментарии в статике только из снимка

Rambler Comments API отклоняет запросы с чужим Origin (ответ 405 «The origin is
not allowed!»), а championat.com отдаёт страницы без CORS. Обойти это можно
только серверной стороной — то есть сборкой снимка.

## Живой режим (бэкенд)

Если сайт переехать за Node-бэкенд, клиент умеет работать с ним без правок
разметки: достаточно задать `window.API_BASE` перед подключением `assets/app.js`.

```
<script>window.API_BASE = 'https://example.com';</script>
<script src="assets/app.js" defer></script>
```

Ожидаются те же маршруты, что у Mini App:

| Маршрут                | Ответ                                                        |
| ---------------------- | ------------------------------------------------------------ |
| `GET /api/matches`     | `{ matches: [...], today, updatedAt }`                        |
| `GET /api/match/:id`   | `{ match: { status, score, url, broadcast, preview }, updatedAt }` |
| `GET /api/comments/:id`| `{ roots: [...], total, sourceUrl, updatedAt }`                |

## Локальный запуск

```bash
npm install
npm run build     # соберёт снимок и скопирует site/ в public/
npm run serve     # локальный статический сервер на public/
```

## Синхронизация с Mini App

`scripts/championat.mjs` — копия парсера из Mini App
(`miniapps/championat-news/miniapp/node/championat.mjs`). При изменении правил
разбора страниц championat.com правки нужно переносить в оба места.

## Источники данных

- Список матчей КХЛ: <https://www.championat.com/hockey/_superleague.html>
- Страница матча с трансляцией: `.../match/<id>/?text-all`
- Комментарии: Rambler Comments API (`appId=5`, `xid=match_<id>`)

## Структура

```
site/            — исходники сайта (index.html, assets/)
scripts/         — сборщик снимка данных и парсер championat.com
public/          — результат сборки (в репозиторий не коммитится)
.github/workflows/pages.yml — сборка и деплой на GitHub Pages
```
