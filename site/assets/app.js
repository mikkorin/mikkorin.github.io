/**
 * Клиент статической версии «Хоккей на Чемпионате».
 *
 * По умолчанию данные приходят из data/snapshot.json — его собирает
 * scripts/fetch-data.mjs на GitHub Actions. Браузер сам не может ходить на
 * championat.com: страницы не отдают CORS-заголовки, а Rambler Comments
 * принимает запросы только с Origin championat.com.
 *
 * Если перед подключением скрипта задать window.API_BASE (например,
 * https://example.com), клиент переключится на живой бэкенд по маршрутам
 * /api/matches, /api/match/:id, /api/comments/:id — это тот же контракт,
 * что у Mini App. Пустая строка означает «живой API на том же origin».
 */
(function () {
  'use strict';

  var DEFAULT_INTERVAL_MS = 60000;
  var SOON_WINDOW_MS = 60 * 60 * 1000;
  var MOSCOW = 'Europe/Moscow';
  // window.API_BASE не задан → статический снимок; задан (в том числе пустой) → живой API.
  var LIVE = typeof window !== 'undefined' && typeof window.API_BASE === 'string';
  var API_BASE = LIVE ? window.API_BASE : '';
  var SNAPSHOT_URL = 'data/snapshot.json';

  var state = {
    matches: [],
    today: '',
    details: {},
    matchId: null,
    userPickedMatch: false,
    detail: null,
    comments: null,
    generatedAt: null,
    updatedAt: null,
    intervals: {
      broadcast: DEFAULT_INTERVAL_MS,
      comments: DEFAULT_INTERVAL_MS,
    },
    timers: {
      broadcast: null,
      comments: null,
    },
  };

  var el = {
    globalMeta: document.getElementById('global-meta'),
    refreshAll: document.getElementById('refresh-all'),
    matchPicker: document.getElementById('match-picker'),
    matchSelect: document.getElementById('match-select'),
    matchStatus: document.getElementById('match-status'),
    matchLink: document.getElementById('match-link'),
    broadcastBody: document.getElementById('broadcast-body'),
    broadcastFoot: document.getElementById('broadcast-foot'),
    broadcastRefresh: document.getElementById('broadcast-refresh'),
    broadcastInterval: document.getElementById('broadcast-interval'),
    commentsBody: document.getElementById('comments-body'),
    commentsFoot: document.getElementById('comments-foot'),
    commentsRefresh: document.getElementById('comments-refresh'),
    commentsInterval: document.getElementById('comments-interval'),
  };

  /* ------------------------------------------------------------- helpers --- */

  function create(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function clockTime(date) {
    try {
      return new Intl.DateTimeFormat('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: MOSCOW,
      }).format(date);
    } catch (error) {
      return date.toLocaleTimeString('ru-RU');
    }
  }

  function relative(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    var minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return minutes + ' мин назад';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + ' ч назад';
    var days = Math.round(hours / 24);
    return days + ' дн назад';
  }

  function setBusy(button, busy) {
    button.classList.toggle('loading', busy);
    button.disabled = busy;
  }

  function showState(node, message, isError) {
    node.textContent = message || '';
    node.classList.toggle('error', Boolean(isError));
    node.hidden = !message;
  }

  function skeleton(node, count) {
    clear(node);
    for (var i = 0; i < count; i += 1) node.appendChild(create('div', 'skeleton'));
  }

  function getJson(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) {
          throw new Error(payload && payload.message ? payload.message : 'Ошибка запроса');
        }
        return payload;
      });
    });
  }

  /* -------------------------------------------------------------- hockey --- */

  /** Матч ещё не начался, но до старта меньше часа. */
  function startsSoon(match) {
    if (!match || !match.startsAt) return false;
    var diff = new Date(match.startsAt).getTime() - Date.now();
    return diff > 0 && diff <= SOON_WINDOW_MS;
  }

  function isLive(match) {
    if (!match) return false;
    if (match.live) return true;
    return /период|тайм/i.test(match.status || '');
  }

  /** Статус матча с учётом окна «скоро начнётся». */
  function statusOf(match) {
    if (!match) return '';
    if (isLive(match)) return match.status || 'Идёт';
    if (startsSoon(match)) return 'Скоро начнется';
    return match.status || '';
  }

  function matchLabel(match) {
    var score = match.score && match.score !== '– : –' ? ' ' + match.score : '';
    var status = statusOf(match);
    return (
      match.date +
      ' ' +
      match.time +
      ' · ' +
      match.home +
      ' — ' +
      match.away +
      score +
      (status ? ' (' + status + ')' : '')
    );
  }

  /** Предпочитает идущий матч, затем ближайший сегодняшний, затем последний. */
  function preferredMatch() {
    var todays = state.matches.filter(function (m) {
      return m.date === state.today;
    });
    var live = todays.filter(isLive);
    if (live.length) return live[0];
    var upcoming = todays.filter(function (m) {
      return !m.played;
    });
    if (upcoming.length) return upcoming[0];
    if (todays.length) return todays[todays.length - 1];
    return state.matches[state.matches.length - 1];
  }

  function currentMatch() {
    for (var i = 0; i < state.matches.length; i += 1) {
      if (state.matches[i].id === state.matchId) return state.matches[i];
    }
    return null;
  }

  /** Сигнатура текущего списка матчей — чтобы не пересобирать select заново. */
  var renderedMatchIds = '';

  function renderMatchOptions() {
    if (!state.matches.length) {
      clear(el.matchSelect);
      var empty = create('option', null, 'Матчи не найдены');
      empty.value = '';
      el.matchSelect.appendChild(empty);
      el.matchSelect.disabled = true;
      renderedMatchIds = '';
      return;
    }

    var resolved =
      state.matchId && state.matches.some(function (m) { return m.id === state.matchId; })
        ? state.matchId
        : preferredMatch().id;
    state.matchId = resolved;

    var signature = state.matches
      .map(function (m) {
        return m.id;
      })
      .join(',');

    if (signature === renderedMatchIds) {
      // Состав матчей не изменился — обновляем подписи на месте, чтобы не сбрасывать выбор.
      for (var i = 0; i < state.matches.length; i += 1) {
        if (el.matchSelect.options[i]) {
          el.matchSelect.options[i].textContent = matchLabel(state.matches[i]);
        }
      }
      el.matchSelect.value = resolved;
      return;
    }

    renderedMatchIds = signature;
    clear(el.matchSelect);
    el.matchSelect.disabled = false;
    state.matches.forEach(function (match) {
      var option = create('option', null, matchLabel(match));
      option.value = match.id;
      el.matchSelect.appendChild(option);
    });
    el.matchSelect.value = resolved;
  }

  /* ----------------------------------------------------------- rendering --- */

  function renderBroadcast() {
    var match = currentMatch();
    var detail = state.detail;
    var body = el.broadcastBody;
    clear(body);

    if (!match) {
      showState(body, 'Матч не выбран', false);
      el.broadcastFoot.textContent = '';
      return;
    }

    if (!detail) {
      var missing = create('p', 'state');
      missing.textContent =
        'Подробности этого матча попадут в следующую сборку. Пока можно смотреть трансляцию на Championat.com.';
      body.appendChild(missing);
    } else {
      var lines = detail.broadcast || [];
      if (!lines.length) {
        var note = create('p', 'state');
        note.textContent = detail.preview
          ? detail.preview
          : 'Текстовая трансляция пока не появилась — трансляция начнётся перед матчем.';
        body.appendChild(note);
      } else {
        lines.forEach(function (line) {
          var row = create('div', 'line');
          if (line.goal) row.classList.add('line-goal');
          row.appendChild(create('div', 'line-minute', line.minute || ''));
          var lineBody = create('div', 'line-body');
          var text = create('p', 'line-text');
          text.appendChild(document.createTextNode(line.text));
          if (line.score) text.appendChild(create('span', 'line-score', line.score));
          if (line.name) text.appendChild(create('span', 'line-score', line.name));
          lineBody.appendChild(text);
          row.appendChild(lineBody);
          body.appendChild(row);
        });
      }
    }

    // Статус со страницы матча точнее, чем в списке: там «1-й период», «2-й период»,
    // «Овертайм», а в списке — только «Не начался» или «Завершён».
    var status = (detail && detail.status) || statusOf(match);
    var liveNow = isLive(match) || /период|тайм|овертайм/i.test(status || '');
    var parts = [];
    if (status) parts.push('Статус: ' + status);
    if (detail && detail.score) parts.push('Счёт: ' + detail.score);
    parts.push('Обновлено в ' + clockTime(new Date(state.updatedAt || state.generatedAt || Date.now())));
    el.broadcastFoot.textContent = parts.join(' · ');

    el.matchLink.href = (detail && detail.url) || match.url || '#';
    el.matchStatus.textContent = liveNow
      ? 'Идёт: ' + (status || '')
      : status || 'матч не выбран';
    el.matchStatus.classList.toggle('badge-live', liveNow);
    el.matchStatus.classList.toggle('badge-soon', !liveNow && startsSoon(match));
  }

  function renderComments() {
    var match = currentMatch();
    var comments = state.comments;
    var body = el.commentsBody;
    clear(body);

    function renderNode(comment) {
      var node = create('div', 'comment');
      var head = create('div', 'comment-head');
      head.appendChild(create('span', 'comment-author', comment.author));
      head.appendChild(create('span', null, relative(comment.createdAt)));
      head.appendChild(create('span', null, clockTime(new Date(comment.createdAt))));
      node.appendChild(head);
      node.appendChild(create('p', 'comment-text', comment.text));
      if (comment.children && comment.children.length) {
        var children = create('div', 'comment-children');
        comment.children.forEach(function (child) {
          children.appendChild(renderNode(child));
        });
        node.appendChild(children);
      }
      return node;
    }

    var roots = (comments && comments.roots) || [];
    if (!comments) {
      var missing = create('p', 'state');
      missing.textContent =
        'Комментарии к этому матчу появятся в следующей сборке. Пока их можно читать на Championat.com.';
      body.appendChild(missing);
    } else if (!roots.length) {
      var empty = create('p', 'state');
      empty.textContent = 'Комментариев к этому матчу пока нет.';
      body.appendChild(empty);
    } else {
      roots.forEach(function (comment) {
        body.appendChild(renderNode(comment));
      });
    }

    el.commentsFoot.textContent = '';
    if (comments) {
      el.commentsFoot.appendChild(
        document.createTextNode(
          'Всего комментариев: ' +
            (comments.total || roots.length) +
            ' · обновлено в ' +
            clockTime(new Date(state.updatedAt || state.generatedAt || Date.now())) +
            ' · ',
        ),
      );
    }
    var link = create('a', null, 'Открыть комментарии на Championat.com');
    link.href = (comments && comments.sourceUrl) || (match && match.url) || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    el.commentsFoot.appendChild(link);
  }

  /* -------------------------------------------------------------- loading --- */

  /** Загружает список матчей: с бэкенда или из снимка. */
  function loadMatches(force) {
    if (LIVE) {
      return getJson(API_BASE + '/api/matches').then(function (payload) {
        state.matches = payload.matches || [];
        state.today = payload.today || '';
        state.updatedAt = payload.updatedAt || null;
      });
    }
    var url = SNAPSHOT_URL;
    if (force) url += '?t=' + Date.now(); // обходим кэш CDN GitHub Pages
    return getJson(url).then(function (snapshot) {
      state.matches = snapshot.matches || [];
      state.today = snapshot.today || '';
      state.details = snapshot.details || {};
      state.generatedAt = snapshot.generatedAt || null;
    });
  }

  /** Загружает трансляцию выбранного матча. */
  function loadDetail(matchId, force) {
    if (LIVE) {
      return getJson(API_BASE + '/api/match/' + matchId + (force ? '?refresh=1' : '')).then(function (
        payload,
      ) {
        state.detail = payload.match || null;
        state.updatedAt = payload.updatedAt || state.updatedAt;
      });
    }
    state.detail = state.details[matchId] || null;
    return Promise.resolve();
  }

  /** Загружает комментарии выбранного матча. */
  function loadComments(matchId, force) {
    if (LIVE) {
      return getJson(
        API_BASE + '/api/comments/' + matchId + (force ? '?refresh=1' : ''),
      ).then(function (payload) {
        state.comments = {
          roots: payload.roots || [],
          total: payload.total || 0,
          sourceUrl: payload.sourceUrl || null,
        };
        state.updatedAt = payload.updatedAt || state.updatedAt;
      });
    }
    var detail = state.details[matchId] || null;
    state.comments = detail
      ? { roots: detail.comments || [], total: detail.commentsTotal || 0, sourceUrl: detail.url || null }
      : null;
    return Promise.resolve();
  }

  /** Полное обновление: список, трансляция и комментарии. */
  function refreshAll(force) {
    return loadMatches(force).then(function () {
      renderMatchOptions();
      el.globalMeta.textContent =
        'Данные обновлены в ' + clockTime(new Date(state.generatedAt || state.updatedAt || Date.now()));
      return Promise.all([loadDetail(state.matchId, force), loadComments(state.matchId, force)]).then(
        function () {
          renderBroadcast();
          renderComments();
        },
      );
    });
  }

  function refreshBroadcast(force) {
    return loadMatches(force)
      .then(function () {
        renderMatchOptions();
        return loadDetail(state.matchId, force);
      })
      .then(function () {
        renderBroadcast();
      });
  }

  function refreshComments(force) {
    return loadMatches(force)
      .then(function () {
        return loadComments(state.matchId, force);
      })
      .then(function () {
        renderComments();
      });
  }

  /* -------------------------------------------------------- auto refresh --- */

  function scheduleAuto(key, loader) {
    if (state.timers[key]) {
      clearInterval(state.timers[key]);
      state.timers[key] = null;
    }
    if (!state.intervals[key]) return; // автообновление выключено
    state.timers[key] = setInterval(function () {
      if (document.hidden) return;
      loader();
    }, state.intervals[key]);
  }

  function applyInterval(key, value, loader) {
    state.intervals[key] = Number(value) || 0;
    scheduleAuto(key, loader);
  }

  /* -------------------------------------------------------------- events --- */

  // Перестройка списка матчей заставляет браузер подставить соседний пункт и
  // прислать change. Переключать матч можно только по явному действию пользователя.
  el.matchSelect.addEventListener('pointerdown', function () {
    state.userPickedMatch = true;
  });
  el.matchSelect.addEventListener('keydown', function () {
    state.userPickedMatch = true;
  });
  el.matchSelect.addEventListener('change', function () {
    if (!state.userPickedMatch) {
      el.matchSelect.value = state.matchId;
      return;
    }
    state.userPickedMatch = false;
    state.matchId = el.matchSelect.value;
    try {
      window.location.hash = 'match-' + state.matchId;
    } catch (error) {
      /* хеш не критичен */
    }
    renderBroadcast();
    renderComments();
  });

  el.broadcastRefresh.addEventListener('click', function () {
    setBusy(el.broadcastRefresh, true);
    refreshBroadcast(true)
      .catch(function (error) {
        showState(el.broadcastBody, 'Не удалось обновить трансляцию: ' + error.message, true);
      })
      .then(function () {
        setBusy(el.broadcastRefresh, false);
      });
  });

  el.commentsRefresh.addEventListener('click', function () {
    setBusy(el.commentsRefresh, true);
    refreshComments(true)
      .catch(function (error) {
        showState(el.commentsBody, 'Не удалось обновить комментарии: ' + error.message, true);
      })
      .then(function () {
        setBusy(el.commentsRefresh, false);
      });
  });

  el.broadcastInterval.addEventListener('change', function () {
    applyInterval('broadcast', el.broadcastInterval.value, function () {
      refreshBroadcast(false);
    });
  });

  el.commentsInterval.addEventListener('change', function () {
    applyInterval('comments', el.commentsInterval.value, function () {
      refreshComments(false);
    });
  });

  el.refreshAll.addEventListener('click', function () {
    setBusy(el.refreshAll, true);
    refreshAll(true)
      .catch(function (error) {
        showState(el.broadcastBody, 'Не удалось обновить данные: ' + error.message, true);
      })
      .then(function () {
        setBusy(el.refreshAll, false);
      });
  });

  /* --------------------------------------------------------------- start --- */

  function matchIdFromHash() {
    var match = /match-(\d+)/.exec(window.location.hash || '');
    return match ? match[1] : null;
  }

  skeleton(el.broadcastBody, 3);
  skeleton(el.commentsBody, 3);

  loadMatches(false)
    .then(function () {
      var hashed = matchIdFromHash();
      if (hashed && state.matches.some(function (m) { return m.id === hashed; })) {
        state.matchId = hashed;
      }
      renderMatchOptions();
      el.globalMeta.textContent =
        'Данные обновлены в ' + clockTime(new Date(state.generatedAt || Date.now()));
      return Promise.all([loadDetail(state.matchId, false), loadComments(state.matchId, false)]).then(
        function () {
          renderBroadcast();
          renderComments();
        },
      );
    })
    .then(function () {
      scheduleAuto('broadcast', function () {
        refreshBroadcast(false);
      });
      scheduleAuto('comments', function () {
        refreshComments(false);
      });
    })
    .catch(function (error) {
      clear(el.broadcastBody);
      clear(el.commentsBody);
      showState(el.broadcastBody, 'Не удалось загрузить матчи КХЛ: ' + error.message, true);
    });
})();
