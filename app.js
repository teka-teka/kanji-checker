/* 漢字チェッカー 画面の処理 */
(function () {
  'use strict';
  var DATA = window.KANJI_DATA;
  var KIND = KanjiEngine.KIND;
  var engine = new KanjiEngine(DATA);
  var tokenizer = null;
  var findings = [];
  var enabled = {};
  Object.keys(KIND).forEach(function (k) { enabled[k] = true; });

  var $ = function (id) { return document.getElementById(id); };
  $('ver').textContent = '辞書データ ' + DATA.version;

  // 上部(見出し・凡例)は常に表示している。表の見出し行をそのすぐ下に止めるため、高さを CSS に渡す
  var header = document.querySelector('header');
  var fitHeader = function () { document.documentElement.style.setProperty('--hh', header.offsetHeight + 'px'); };
  fitHeader();
  window.addEventListener('resize', fitHeader);

  // ---- 形態素解析器の準備(辞書はページに埋め込み済み) ----
  var t0 = Date.now();
  kuromoji.builder({ dicPath: 'dict/' }).build(function (err, tk) {
    if (err) {
      $('status').textContent = '解析器の準備に失敗しました(活用形・送りがなの一部は判定できません): ' + err;
      $('run').disabled = false;
      return;
    }
    tokenizer = tk;
    $('status').textContent = '準備できました(' + ((Date.now() - t0) / 1000).toFixed(1) + '秒)';
    $('run').disabled = false;
  });

  // ---- .txt の読み込み(UTF-8 / Shift_JIS を自動判別) ----
  $('file').addEventListener('change', function (ev) {
    var f = ev.target.files[0];
    if (!f) { return; }
    var r = new FileReader();
    r.onload = function () {
      var buf = r.result, text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch (e) {
        text = new TextDecoder('shift_jis').decode(buf);
      }
      $('text').value = text;
      $('filename').textContent = f.name;
    };
    r.readAsArrayBuffer(f);
    ev.target.value = '';
  });

  $('clear').addEventListener('click', function () {
    $('text').value = ''; $('filename').textContent = '';
    $('result').hidden = true; findings = [];
  });

  // エンターでチェック、SHIFT+エンターで改行(2026-10-07 ユーザー指示)。
  // 日本語入力の変換確定のエンター(isComposing / keyCode 229)ではチェックしない
  $('text').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || ev.keyCode === 229) { return; }
    ev.preventDefault();
    if (!$('run').disabled) { $('run').click(); }
  });

  $('run').addEventListener('click', function () {
    var text = $('text').value.replace(/\r\n?/g, '\n');
    if (!text.trim()) { return; }
    var tokens = tokenizer ? tokenizer.tokenize(text) : null;
    findings = engine.check(text, tokens);
    render();
  });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function dicHtml(id) {
    var e = DATA.entries[id];
    return esc(e.d).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>') + pageCrop(id);
  }

  // ---- 辞書のページ画像(語の部分の切り抜き。クリックでページ全体) ----
  var PX = 3, SHOW = 2;   // 画像は 1pt = 3px。表示は 1pt = 2px
  function pageCrop(id) {
    var g = DATA.entries[id].g;
    if (!g) { return ''; }
    var w = (g[3] - g[1]) * SHOW, h = (g[4] - g[2]) * SHOW;
    return '<div class="crop' + (g[5] === 2 ? ' guess' : '') + '" data-id="' + id + '" title="クリックでページ全体を表示" style="width:' + w.toFixed(0) +
      'px;height:' + h.toFixed(0) + 'px;background-size:' + (315 * SHOW) + 'px ' + (450 * SHOW) + 'px;background-position:-' +
      (g[1] * SHOW).toFixed(1) + 'px -' + (g[2] * SHOW).toFixed(1) + 'px"></div>' +
      (g[5] === 2 ? '<div class="guessnote">原本の位置は推定です(ずれていることがあります)</div>' : '');
  }
  function pageFile(p) { return 'pages/p' + ('000' + p).slice(-4) + '.jpg'; }
  // 紙面の画像の URL を渡す。公開サイト(暗号化版)では gate.js の KANJI_PAGE が復号して渡す
  function withPage(p, cb) {
    if (window.KANJI_PAGE) { window.KANJI_PAGE(p).then(cb, function () {}); } else { cb(pageFile(p)); }
  }
  var lazy = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
    es.forEach(function (en) {
      if (!en.isIntersecting) { return; }
      var el = en.target;
      withPage(DATA.entries[el.dataset.id].g[0], function (u) { el.style.backgroundImage = 'url(' + u + ')'; });
      lazy.unobserve(el);
    });
  }, { rootMargin: '400px' }) : null;
  function watchCrops() {
    Array.prototype.forEach.call(document.querySelectorAll('.crop'), function (el) {
      if (lazy) { lazy.observe(el); } else { withPage(DATA.entries[el.dataset.id].g[0], function (u) { el.style.backgroundImage = 'url(' + u + ')'; }); }
    });
  }
  // ---- 見出しの検索(ひらがな、1行)。2026-10-07 ユーザー指示 ----
  // よみの前方一致を先に、続けて部分一致を並べる。カタカナはひらがなに直して探す
  var MAXQ = 200, qTimer = null;
  function toHira(s) {
    return s.replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); }).replace(/[\s　]/g, '');
  }
  function searchHeads() {
    var q = toHira($('q').value);
    if (!q) { $('qresult').hidden = true; $('qresult').innerHTML = ''; $('qcount').textContent = ''; return; }
    if (!/^[ぁ-ゖー]+$/.test(q)) { $('qresult').hidden = true; $('qcount').textContent = 'ひらがなで入力してください'; return; }
    var pre = [], part = [];
    DATA.entries.forEach(function (e, id) {
      if (!e.y) { return; }
      var at = e.y.indexOf(q);
      if (at === 0) { pre.push(id); } else if (at > 0) { part.push(id); }
    });
    var all = pre.concat(part);
    $('qcount').textContent = '前方一致 ' + pre.length + ' 件・部分一致 ' + part.length + ' 件' + (all.length > MAXQ ? '(先頭の ' + MAXQ + ' 件を表示)' : '');
    $('qresult').innerHTML = all.length ? all.slice(0, MAXQ).map(function (id, k) {
      var e = DATA.entries[id];
      return (k === pre.length ? '<div class="qsep">部分一致</div>' : '') +
        '<div class="qrow"><span class="qpg">p.' + e.p + '</span><div class="qdic">' + dicHtml(id) + '</div>' +
        '<div class="qrep" data-id="' + id + '">' + qRepCell(id) + '</div></div>';
    }).join('') : '<div class="muted">見つかりませんでした。</div>';
    $('qresult').hidden = false;
    watchCrops();
  }
  $('q').addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(searchHeads, 150); });
  $('q').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); clearTimeout(qTimer); searchHeads(); }
    if (ev.key === 'Escape') { $('q').value = ''; searchHeads(); }
  });
  $('q').addEventListener('search', searchHeads);   // 消去ボタン(×)で消したとき

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest && ev.target.closest('.crop');
    if (el) {
      var e = DATA.entries[el.dataset.id], g = e.g;
      $('pvimg').removeAttribute('src');
      withPage(g[0], function (u) { $('pvimg').src = u; });
      var box = $('pvbox');
      box.style.left = (g[1] / 315 * 100) + '%'; box.style.top = (g[2] / 450 * 100) + '%';
      box.style.width = ((g[3] - g[1]) / 315 * 100) + '%'; box.style.height = ((g[4] - g[2]) / 450 * 100) + '%';
      $('pvcap').textContent = '辞書 p.' + e.p + '　' + e.d.replace(/\*\*/g, '') + (g[5] === 2 ? '(位置は推定)' : '');
      $('pageview').hidden = false;
      return;
    }
    if (ev.target.closest && ev.target.closest('#pageview')) { $('pageview').hidden = true; }
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { $('pageview').hidden = true; } });

  function render() {
    $('result').hidden = false;
    // 種別の切り替え
    var counts = {};
    findings.forEach(function (f) { counts[f.kind] = (counts[f.kind] || 0) + 1; });
    var html = '';
    Object.keys(KIND).sort(function (a, b) { return KIND[a].order - KIND[b].order; }).forEach(function (k) {
      if (k === 'kana') { return; }   // 出力では「使わない漢字」(ng)にまとめている
      html += '<label><input type="checkbox" data-k="' + k + '"' + (enabled[k] ? ' checked' : '') + '> ' +
        '<span class="lv lv-' + KIND[k].level + '">' + esc(KIND[k].label) + '</span> ' + (counts[k] || 0) + '</label>';
    });
    $('filters').innerHTML = html;
    Array.prototype.forEach.call($('filters').querySelectorAll('input'), function (cb) {
      cb.addEventListener('change', function () { enabled[cb.dataset.k] = cb.checked; renderRows(); });
    });
    renderRows();
  }

  function visible() { return findings.filter(function (f) { return enabled[f.kind]; }); }

  function renderRows() {
    var rows = visible();
    var lv = { '要修正': 0, '要確認': 0, '参考': 0, '使用可': 0, '辞書に語なし': 0 };
    findings.forEach(function (f) { lv[KIND[f.kind].level]++; });
    $('summary').textContent = '漢字を含む箇所 ' + findings.length + ' 件:要修正(使用不可) ' + lv['要修正'] + '・要確認 ' + lv['要確認'] +
      '・参考 ' + lv['参考'] + '・使用可 ' + lv['使用可'] + '・辞書に語なし ' + lv['辞書に語なし'] + '／表示中 ' + rows.length + ' 件';
    var tb = $('table').querySelector('tbody');
    tb.innerHTML = rows.map(function (f, ri) {
      var k = KIND[f.kind];
      var dic = f.entries.length ? f.entries.map(function (id) { return '<div class="one">' + dicHtml(id) + '</div>'; }).join('') : esc(f.note);
      if (f.okEntries && f.okEntries.length) {
        var hd = f.heads || ['使える見出し', '使わない(または確認が要る)見出し'];
        dic = '<div class="head ok">' + esc(hd[0]) + '</div>' + f.okEntries.map(function (id) { return '<div class="one">' + dicHtml(id) + ' <span class="pg">p.' + DATA.entries[id].p + '</span></div>'; }).join('') +
          '<div class="head ng' + (hd[1] === 'そのほかの見出し' ? ' other' : '') + '">⚠ ' + esc(hd[1]) + '</div>' + f.entries.filter(function (id) { return f.okEntries.indexOf(id) < 0; })
            .map(function (id) { return '<div class="one">' + dicHtml(id) + ' <span class="pg">p.' + DATA.entries[id].p + '</span></div>'; }).join('');
      }
      var pages = f.entries.map(function (id) { return 'p.' + DATA.entries[id].p; })
        .filter(function (x, i, a) { return a.indexOf(x) === i; }).join(' ');
      return '<tr class="k-' + f.kind + ' row-' + k.level + '"><td>' + f.line + '</td>' +
        '<td class="hit"><span class="ctx">' + esc(f.before) + '</span><mark>' + esc(f.text) + '</mark><span class="ctx">' + esc(f.after) + '</span></td>' +
        '<td class="lv-' + k.level + '">' + esc(k.label) + '</td>' +
        '<td>' + esc(f.suggest) + (f.note && f.entries.length ? '<div class="muted">' + esc(f.note) + '</div>' : '') + '</td><td class="dic">' + dic + '</td><td>' + esc(pages) + '</td>' +
        '<td class="rep" data-i="' + ri + '">' + repCell(f) + '</td></tr>';
    }).join('');
    $('table').hidden = rows.length === 0;
    watchCrops();
    $('none').hidden = rows.length !== 0;
  }

  // 辞書の項目・ページを文字で(CSV と報告で使う)
  function dicText(f) {
    var dic = f.entries.length ? f.entries.map(function (id) { return DATA.entries[id].d.replace(/\*\*/g, ''); }).join(' ／ ') : f.note;
    if (f.okEntries && f.okEntries.length) {
      var hc = f.heads || ['使える', '使わない・要確認'];
      dic = '【' + hc[0] + '】' + f.okEntries.map(function (id) { return DATA.entries[id].d.replace(/\*\*/g, '') + '(p.' + DATA.entries[id].p + ')'; }).join(' ／ ') +
        ' 【' + hc[1] + '】' + f.entries.filter(function (id) { return f.okEntries.indexOf(id) < 0; }).map(function (id) { return DATA.entries[id].d.replace(/\*\*/g, '') + '(p.' + DATA.entries[id].p + ')'; }).join(' ／ ');
    }
    return dic;
  }
  function pagesText(f) { return f.entries.map(function (id) { return 'p.' + DATA.entries[id].p; }).join(' '); }

  // ---- 誤った結果を報告(送り先は report-config.js。Google スプレッドシートに1行ずつたまる) ----
  var REP_LABEL = '誤った結果を<br>報告';   // ボタンの文字は「を」で改行(2026-10-07 ユーザー指示)
  function sendReport(body, btn, msg, done) {
    var url = (window.KANJI_REPORT || {}).url;
    if (!url) { msg.textContent = '送り先が未設定です(report-config.js)。'; return; }
    btn.disabled = true; msg.textContent = '送っています…';
    // 送り先は別のサイトなので返事は読めない(no-cors)。送信できれば報告済みとする
    fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(done)
      .catch(function (e) { btn.disabled = false; msg.textContent = '送れませんでした(ネット接続を確かめてください): ' + e; });
  }
  var REP_FORM = '<textarea class="rep-cm" placeholder="どこが誤りか(任意)"></textarea>' +
    '<button class="rep-send">送る</button> <button class="rep-cancel ghost">やめる</button><div class="rep-msg muted"></div>';
  $('table').addEventListener('click', function (ev) {
    var t = (ev.target.closest && ev.target.closest('button')) || ev.target, cell = t.closest && t.closest('td.rep');   // ボタン内の改行(br)を押しても効くように
    if (!cell) { return; }
    var f = visible()[+cell.dataset.i];
    if (t.classList.contains('rep-open')) {
      cell.innerHTML = REP_FORM;
      cell.querySelector('textarea').focus();
    } else if (t.classList.contains('rep-cancel')) {
      cell.innerHTML = repCell(f);
    } else if (t.classList.contains('rep-send')) {
      var body = {
        time: new Date().toLocaleString('ja-JP'), version: DATA.version, file: $('filename').textContent || '',
        line: f.line, text: f.text, before: f.before, after: f.after, kind: KIND[f.kind].label, level: KIND[f.kind].level,
        suggest: f.suggest || '', note: f.note || '', dic: dicText(f), pages: pagesText(f),
        comment: cell.querySelector('textarea').value
      };
      sendReport(body, t, cell.querySelector('.rep-msg'), function () { f.reported = true; cell.innerHTML = repCell(f); });
    }
  });

  // 見出しの検索の結果からの報告(項目ごと)。種別は「見出しの検索」、ファイル名の欄は「(見出しの検索)」
  var qReported = {};
  function qRepCell(id) {
    return qReported[id] ? '<span class="rep-done">報告済み</span>' : '<button class="rep-open ghost">' + REP_LABEL + '</button>';
  }
  $('qresult').addEventListener('click', function (ev) {
    var t = ev.target.closest ? ev.target.closest('button') : null, cell = t && t.closest('.qrep');
    if (!cell) { return; }
    var id = +cell.dataset.id, e = DATA.entries[id];
    if (t.classList.contains('rep-open')) {
      cell.innerHTML = REP_FORM;
      cell.querySelector('textarea').focus();
    } else if (t.classList.contains('rep-cancel')) {
      cell.innerHTML = qRepCell(id);
    } else if (t.classList.contains('rep-send')) {
      var body = {
        time: new Date().toLocaleString('ja-JP'), version: DATA.version, file: '(見出しの検索)',
        line: '', text: $('q').value, before: '', after: '', kind: '見出しの検索', level: '',
        suggest: '', note: '', dic: e.d.replace(/\*\*/g, ''), pages: 'p.' + e.p,
        comment: cell.querySelector('textarea').value
      };
      sendReport(body, t, cell.querySelector('.rep-msg'), function () { qReported[id] = true; cell.innerHTML = qRepCell(id); });
    }
  });
  function repCell(f) {
    return f.reported ? '<span class="rep-done">報告済み</span>' : '<button class="rep-open ghost">' + REP_LABEL + '</button>';
  }

  // ---- CSV(Excel で開けるよう BOM 付き UTF-8) ----
  $('csv').addEventListener('click', function () {
    var q = function (s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; };
    var lines = [['行', '該当箇所', '前後の文脈', '種別', '推奨表記', '辞書の項目', '辞書のページ'].map(q).join(',')];
    visible().forEach(function (f) {
      lines.push([f.line, f.text, f.before + '【' + f.text + '】' + f.after, KIND[f.kind].label, f.suggest, dicText(f), pagesText(f)].map(q).join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var name = ($('filename').textContent || '原稿').replace(/\.txt$/i, '');
    a.download = name + '_漢字チェック.csv';
    document.body.appendChild(a); a.click(); a.remove();
  });
})();
