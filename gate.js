/* 公開サイトの入口: パスワードで辞書データと紙面の画像を復号してから、画面のプログラムを読み込む */
(function () {
  'use strict';
  var CFG = {"salt": "X/srLQ8lc44axKxxqtHmVw==", "iter": 600000, "v": "20261007043122", "check": "nK4sUxdtjYSKcx1OYUdkEjUHV5YGjwYlnX497palDlsYghBLLPhJbvs="};
  var SCRIPTS = ["vendor/kuromoji.js", "vendor/kuromoji-dict.js", "rules.js", "engine.js", "report-config.js", "app.js"];
  var STORE = 'kanji-checker-key';
  var key = null, cache = {};
  var $ = function (id) { return document.getElementById(id); };
  function unb64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) { a[i] = b.charCodeAt(i); } return a; }
  function b64(buf) { var a = new Uint8Array(buf), s = ''; for (var i = 0; i < a.length; i++) { s += String.fromCharCode(a[i]); } return btoa(s); }
  function derive(pw) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']).then(function (k) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(CFG.salt), iterations: CFG.iter, hash: 'SHA-256' },
        k, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
    });
  }
  function dec(buf, k) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(buf, 0, 12) }, k || key, new Uint8Array(buf, 12));
  }
  function get(url) {
    return fetch(url + '?v=' + CFG.v).then(function (r) {
      if (!r.ok) { throw new Error(url + ' を読めません(' + r.status + ')'); }
      return r.arrayBuffer();
    });
  }
  function load(src) {
    return new Promise(function (ok, ng) {
      var s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = function () { ng(new Error(src + ' を読めません')); };
      document.body.appendChild(s);
    });
  }
  // 紙面の画像(app.js が使う): 復号して blob の URL を返す。一度復号したものは使い回す
  window.KANJI_PAGE = function (p) {
    var n = 'pages/p' + ('000' + p).slice(-4) + '.enc';
    if (!cache[n]) {
      cache[n] = get(n).then(function (b) { return dec(b); })
        .then(function (b) { return URL.createObjectURL(new Blob([b], { type: 'image/jpeg' })); });
    }
    return cache[n];
  };
  function msg(t) { $('gatemsg').textContent = t; }
  // 鍵が正しいかを小さな確認用の暗号文で確かめてから、辞書データを読む
  function open(k, keep) {
    return dec(unb64(CFG.check).buffer, k).then(function () {
      key = k;
      msg('辞書データを読み込んでいます…');
      if (keep) { crypto.subtle.exportKey('raw', k).then(function (r) { try { localStorage.setItem(STORE, b64(r)); } catch (e) { } }); }
      return get('data.enc').then(function (b) { return dec(b); }).then(function (plain) {
        var chain = load(URL.createObjectURL(new Blob([plain], { type: 'text/javascript' })));
        SCRIPTS.forEach(function (s) { chain = chain.then(function () { return load(s + '?v=' + CFG.v); }); });
        return chain;
      }).then(function () { $('gate').remove(); });
    }, function () { throw new Error('パスワードが違います。'); });
  }
  $('gateform').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pw = $('gatepw').value;
    if (!pw) { return; }
    $('gatebtn').disabled = true; msg('確かめています…');
    derive(pw).then(function (k) { return open(k, $('gatekeep').checked); })
      .catch(function (e) { $('gatebtn').disabled = false; msg(e.message || String(e)); $('gatepw').select(); });
  });
  // 記憶した鍵があれば、パスワードを聞かずに開く(パスワードが変わっていたら記憶を消して聞く)
  var saved = null;
  try { saved = localStorage.getItem(STORE); } catch (e) { }
  if (saved) {
    $('gatebtn').disabled = true; msg('記憶したパスワードで開いています…');
    crypto.subtle.importKey('raw', unb64(saved), { name: 'AES-GCM' }, true, ['decrypt'])
      .then(function (k) { return open(k, false); })
      .catch(function () {
        try { localStorage.removeItem(STORE); } catch (e) { }
        $('gatebtn').disabled = false; msg('記憶したパスワードでは開けません。入れ直してください。');
      });
  }
})();
