/* 漢字チェッカー 判定エンジン
 * 辞書(window.KANJI_DATA)と形態素解析の結果(kuromoji のトークン)から、原稿の指摘を作る。
 * ブラウザでもテスト用ページでも同じものを使う。
 */
(function (global) {
  'use strict';

  var KIND = {
    ng:      { label: '使わない漢字', level: '要修正', order: 1 },
    kana:    { label: '使わない漢字', level: '要修正', order: 2 },   // 出力では ng にまとめる
    okuri:   { label: '送りがな', level: '要修正', order: 3 },
    hyogai:  { label: '表外字', level: '要修正', order: 4 },
    kansuji: { label: '漢数字', level: '要修正', order: 5 },
    mean:    { label: '要確認(意味で分かれる)', level: '要確認', order: 6 },
    read:    { label: '要確認(読みで分かれる)', level: '要確認', order: 7 },
    single:  { label: '要確認(1字)', level: '要確認', order: 8 },
    second:  { label: '参考(①が原則)', level: '参考', order: 9 },
    yomi:    { label: '参考(読みがな推奨)', level: '参考', order: 10 },
    ctx:     { label: '使用不可(注記の指示)', level: '要修正', order: 5.5 },
    ctxc:    { label: '要確認(限定用語など)', level: '要確認', order: 8.5 },
    ok:      { label: '使用可(辞書の太字どおり)', level: '使用可', order: 11 },
    charrd:  { label: '要確認(常用の音訓にない読みの疑い)', level: '要確認', order: 8.7 },
    charok:  { label: '使用可(語は辞書になし・常用の音訓で読める)', level: '使用可', order: 11.5 },
    char:    { label: '辞書に語なし(読みは確かめられず)', level: '辞書に語なし', order: 12 }
  };
  var FLAG_KINDS = ['ng', 'kana', 'okuri', 'hyogai', 'mean', 'read', 'single', 'second', 'yomi'];

  var KANSUJI = '〇一二三四五六七八九十百千万億兆';
  var KDIGIT = { '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  // 漢数字の後ろにこれが来たら「数量」とみなす(長いものから照合する)
  var COUNTERS = [
    'か所', 'カ所', 'ヵ所', 'ケ所', 'ヶ所', 'か月', 'カ月', 'ヵ月', 'ケ月', 'ヶ月', 'か国', 'カ国', 'ヵ国', 'ケ国',
    'か年', 'カ年', 'パーセント', 'キロ', 'メートル', 'センチ', 'ミリ', 'グラム', 'トン', 'リットル', 'ドル', 'ユーロ',
    '時間', '日間', '週間', '年間', '年生', '世紀', '世帯', '家族', '選手',
    '人', '個', '回', '日', '月', '年', '円', '本', '枚', '台', '件', '歳', '才', '時', '分', '秒', '度', '階', '番',
    '位', '倍', '割', '匹', '頭', '羽', '冊', '軒', '社', '校', '点', '票', '戸', '隻', '機', '両', '着', '足', '杯',
    '通', '期', '代', '周', '区', '条', '項', '号', '巻', '話', '部', '章', '版', '名', '勝', '敗', '段', '級', '局',
    '週', '夜', '泊', '食', '粒', '滴', '株', '箱', '袋', '缶', '錠', '面', '種', '例', '問', '年度', '％', '%'
  ];

  function cpOf(ch) { return ch.codePointAt(0); }
  function isKanjiCp(c) {
    return (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x4E00 && c <= 0x9FFF) ||
      (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x20000 && c <= 0x3FFFF);
  }
  function isKanji(ch) { return isKanjiCp(cpOf(ch)); }
  function isHira(ch) { var c = cpOf(ch); return c >= 0x3041 && c <= 0x309F; }
  function isDigit(ch) { return ch >= '0' && ch <= '9'; }
  function looseYomi(r) {
    if (!r) { return ''; }
    var h = r.replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); }).replace(/づ/g, 'ず').replace(/ぢ/g, 'じ');
    h = h.normalize('NFD').replace(/[\u3099\u309A]/g, '').normalize('NFC');
    return h.replace(/[ぁぃぅぇぉっゃゅょゎ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 1); }).replace(/ー/g, '');
  }

  function Engine(data) {
    this.data = data;
    this.entries = data.entries;
    this.vmap = data.variants || {};
    this.joyo = new Set(Array.from(data.joyo));
    this.map = new Map();
    this.stemMap = new Map();
    this.maxLen = 0;
    this.maxStem = 0;
    var self = this;
    data.patterns.forEach(function (p) {
      var chars = Array.from(p.s);
      // かなだけの文字列は指摘を生まないので照合しない(かなの並びを食べて他の一致を邪魔しないように)
      if (!chars.some(function (ch) { return isKanji(ch) || isDigit(ch) || ch === '〆'; })) { return; }
      self.map.set(p.s, p);
      if (chars.length > self.maxLen) { self.maxLen = chars.length; }
      if (p.c != null && p.c < chars.length) {
        var stem = chars.slice(0, p.c).join('');
        if (!self.stemMap.has(stem)) { self.stemMap.set(stem, []); }
        self.stemMap.get(stem).push(p);
        if (p.c > self.maxStem) { self.maxStem = p.c; }
      }
    });
    if (this.maxLen > 30) { this.maxLen = 30; }
    this.rules = global.KanjiRules ? new global.KanjiRules(data, this) : null;
    // よみ(かな化・濁点などを落としたもの)→ 項目番号(解析器の読みから辞書の項目を引く用)
    this.byLoose = {};
    data.entries.forEach(function (e, id) {
      var k = looseYomi(e.y);
      (self.byLoose[k] = self.byLoose[k] || []).push(id);
    });
    this.rd = {};
    var rdd = data.rd || {};
    Object.keys(rdd).forEach(function (c) { self.rd[c] = new Set(rdd[c].split('|')); });
  }

  Engine.KIND = KIND;

  /** 原稿の字形・数字をそろえる(照合用。1字 → 1字なので位置は変わらない) */
  Engine.prototype.normChar = function (ch) {
    if (this.vmap[ch]) { return this.vmap[ch]; }
    var c = cpOf(ch);
    if (c >= 0xFF10 && c <= 0xFF19) { return String.fromCharCode(c - 0xFF10 + 0x30); }   // ０-９
    return ch;
  };

  /**
   * text: 原稿、tokens: kuromoji のトークン(null なら品詞の確認をしない)
   * 戻り値: 指摘の配列 {start, end, line, text, kind, suggest, entries, note}
   */
  Engine.prototype.check = function (text, tokens) {
    var self = this;
    var chars = Array.from(text);
    var n = chars.length;
    var norm = chars.map(function (ch) { return self.normChar(ch); });
    var line = new Array(n);
    var ln = 1;
    for (var i = 0; i < n; i++) { line[i] = ln; if (chars[i] === '\n') { ln++; } }
    // UTF-16 の位置 → 字(コードポイント)の位置
    var u16 = [];
    for (i = 0; i < n; i++) { u16.push(i); if (chars[i].length === 2) { u16.push(i); } }
    var tokAt = new Array(n);
    if (tokens) {
      // 位置は kuromoji の word_position を使わず、表層形を先頭から順に照らして求める
      // (「[1][2]」などの後で word_position が1字ずれることがあるため)
      var cur = 0;
      tokens.forEach(function (t) {
        var at = text.indexOf(t.surface_form, cur);
        if (at < 0 || at - cur > 8) { at = t.word_position - 1; }
        cur = at + t.surface_form.length;
        var s = u16[at];
        var len = Array.from(t.surface_form).length;
        t._s = s; t._e = s + len;
        for (var k = s; k < s + len && k < n; k++) { tokAt[k] = t; }
      });
    }
    var out = [];

    function sub(a, b) { return norm.slice(a, b).join(''); }

    function verbHere(p, i, L) {
      // 語幹の最後の字を含むトークンが、照合した語(動詞・形容詞)そのものか
      if (!tokens) { return false; }
      var t = tokAt[i + L - 1];
      if (!(t && (t.pos === '動詞' || t.pos === '形容詞'))) { return false; }
      var bf = t.basic_form;
      if (!bf || bf === '*') { return false; }
      var nb = Array.from(bf).map(function (ch) { return self.normChar(ch); }).join('');
      return p.s.slice(-nb.length) === nb || nb.slice(-p.s.length) === p.s;
    }

    // 五段動詞の語尾 → 活用で次に来うるかな
    var INFL = { 'う': 'わいうえおっ', 'く': 'かきくけこい', 'ぐ': 'がぎぐげごい', 'す': 'さしすせそ', 'つ': 'たちつてとっ',
      'ぬ': 'なにぬねのん', 'ぶ': 'ばびぶべぼん', 'む': 'まみむめもん', 'る': 'らりるれろっ' };
    var EI = 'えけげせぜてでねへべぺめれいきぎしじちぢにひびぴみり';
    function stemOk(p, i, L) {
      // 活用形の語幹の一致: 次がひらがなで、その語が動詞・形容詞であること
      var nx = i + L;
      var sf = p.s, last = sf.slice(-1), stemLast = chars[i + L - 1];
      var ichidan = last === 'る' && EI.indexOf(sf.slice(-2, -1)) >= 0;
      if (nx >= n || !isHira(chars[nx])) {
        // 一段動詞の連用形(剝れ、灼け)の後に読点・漢字などが来る形。語幹2字以上でかなで終わるとき
        if (ichidan && L >= 2 && isHira(stemLast) && !(p.k.ok && Object.keys(p.k).length === 1)) { return true; }
        return false;
      }
      if (ichidan && L >= 2 && isHira(stemLast) && 'をがにのはもとでやへ'.indexOf(chars[nx]) >= 0 &&
          (p.k.okuri || p.k.ng || p.k.kana)) { return true; }    // 剝れを・灼けが(連用形の名詞)
      if (!tokens) { return true; }
      // 使わない書き方・かな書きの語(正しい表記ではない)は、解析器が動詞と認めなくても、後ろのかなが
      // その語の活用として合えば採る(剝いた・了った・倒めた・倹しかった: 解析器が知らない字・別の読みの字)。
      // 読みが合わなければ下で要確認(読み)に下がる。2026-09-29「微笑み」の件の全体点検で見つけた見逃し
      // ただし解析器が別の動詞・形容詞と確かめた所(経て=経る、愛され=愛す)は、下の解析器の判定に任せる
      var tS = tokAt[i + L - 1];
      var knownOther = tS && tS === tokAt[i] && (tS.pos === '動詞' || tS.pos === '形容詞') && tS.basic_form && tS.basic_form !== '*';
      if (knownOther && tS._e <= i + L) {
        // 解析器の語が字だけで、後ろが助詞・助動詞でない(悪|ん|だ、焦|し|た)ときは、解析器の読み違いとみなす
        var tN = tokAt[tS._e];
        knownOther = !!(tN && (tN.pos === '助詞' || tN.pos === '助動詞'));
      }
      if (!knownOther && ((p.k.ng || p.k.kana) && !p.k.ok && isKanji(stemLast) || (p.k.ng || p.k.kana) && !p.k.ok && L >= 2)) {
        var nc = chars[nx];
        if (ichidan && 'まためなよられろさずて'.indexOf(nc) >= 0) { return true; }
        if (ichidan && last === 'る' && 'りっら'.indexOf(nc) >= 0) { return true; }   // い段＋る の五段(いじる・弄じる)
        if (!ichidan && INFL[last] && INFL[last].indexOf(nc) >= 0 && !/する$/.test(sf)) { return true; }
        if (last === 'い' && 'かくけさ'.indexOf(nc) >= 0) { return true; }
      }
      if (!/する$/.test(sf) && !ichidan && L >= 2 && INFL[last] && INFL[last].indexOf(chars[nx]) >= 0 &&
          (p.k.okuri || p.k.ng || p.k.kana) && isHira(stemLast)) {
        return true;    // 行な＋っ(行なって): 解析器の区切りがずれても、語尾の活用が合えば採る
      }
      var sForm = p.s;
      if (/する$/.test(sForm)) {
        var tn = tokAt[nx];
        return !!(tn && tn.basic_form === 'する');
      }
      var t = tokAt[i + L - 1];
      if (!(t && (t.pos === '動詞' || t.pos === '形容詞'))) { return false; }
      // 基本形が照合した語の終わりと合うこと(腐った=腐る は「腐す」の活用ではない)
      var bf = t.basic_form;
      if (!bf || bf === '*') { return true; }
      var nb = Array.from(bf).map(function (ch) { return self.normChar(ch); }).join('');
      return sForm.slice(-nb.length) === nb || nb.slice(-sForm.length) === sForm;
    }

    // 読みの照合用: かな化・濁点/半濁点・小書き・長音を落として比べる
    function looseKana(r) {
      if (!r) { return ''; }
      var h = r.replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); }).replace(/づ/g, 'ず').replace(/ぢ/g, 'じ');
      h = h.normalize('NFD').replace(/[\u3099\u309A]/g, '').normalize('NFC');
      return h.replace(/[ぁぃぅぇぉっゃゅょゎ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 1); }).replace(/ー/g, '');
    }
    /** 範囲 [a, b) の読み(トークンの境目とそろっているときだけ。そろわなければ null) */
    function spanReading(a, b) {
      if (!tokens) { return null; }
      var ta = tokAt[a], tb = tokAt[b - 1];
      if (!ta || !tb || ta._s !== a) { return null; }
      var r = '', k = a;
      while (k < b) {
        var t = tokAt[k];
        if (!t || !t.reading || t.reading === '*') { return null; }
        r += t.reading; k = t._e;
      }
      return { r: looseKana(r), end: k };
    }
    /** 指摘の読みが、辞書のよみと合うか(合わない = 別の語の可能性) */
    function readingFits(ids, a, b, stem) {
      var sr = spanReading(a, stem ? (tokAt[b - 1] ? tokAt[b - 1]._e : b) : b);
      if (!sr) { return true; }
      var partial = !stem && sr.end !== b;
      return ids.some(function (id) {
        var y = looseKana(self.entries[id].y);
        if (stem) { return sr.r.slice(0, y.length - 1) === y.slice(0, -1); }
        if (partial) {
          // 範囲が解析器の語の途中で終わる(手作業 = 手|作業 の「手作」): 読みの頭が辞書のよみと合うかで見る
          var m = Math.max(1, y.length - 1);
          return sr.r.slice(0, m) === y.slice(0, m);
        }
        return sr.r === y;
      });
    }

    i = 0;
    while (i < n) {
      if (/\s/.test(chars[i])) { i++; continue; }
      var best = 0, cands = [];
      var maxL = Math.min(this.maxLen, n - i);
      for (var L = maxL; L >= 1; L--) {
        var p = this.map.get(sub(i, i + L));
        if (p) { if (L > best) { best = L; cands = []; } if (L === best) { cands.push({ p: p, stem: false }); } break; }
      }
      var maxS = Math.min(this.maxStem, n - i);
      var okLiteral = 0;   // 正しい動詞・形容詞の語幹が当たる長さ(述べる → 「述べ、」)。品詞と基本形で確かめる
      for (L = maxS; L >= 1; L--) {
        var lst = this.stemMap.get(sub(i, i + L));
        if (lst && lst.some(function (pp) { return pp.k.ok && verbHere(pp, i, L); })) { okLiteral = L; break; }
      }
      for (L = maxS; L >= 1 && L >= best; L--) {
        var list = this.stemMap.get(sub(i, i + L));
        if (!list) { continue; }
        var okList = list.filter(function (pp) { return stemOk(pp, i, L); });
        if (!okList.length) { continue; }
        if (L > best) { best = L; cands = []; }
        okList.forEach(function (pp) { cands.push({ p: pp, stem: true }); });
        break;
      }
      var readOnly = false;   // 正しい動詞の語幹と同じ長さで当たった送りがなは、要確認(読み)に下げて出す
      if (okLiteral > 0 && okLiteral >= best && cands.length &&
          cands.every(function (c) { return !c.stem && Object.keys(c.p.k).every(function (k) { return k === 'okuri'; }); })) {
        cands = cands.map(function (c) { return { p: { s: c.p.s, k: { read: c.p.k.okuri }, c: c.p.c }, stem: false }; });
        readOnly = true;
      }
      if (okLiteral > best) {
        // 指摘の候補より長く、正しい動詞・形容詞に当たっている → 使用可として一覧に出す
        var te = tokAt[i + okLiteral - 1];
        var okEnd = te && te._e > i + okLiteral ? te._e : i + okLiteral;
        var okp = this.stemMap.get(sub(i, i + okLiteral)).filter(function (pp) { return pp.k.ok; });
        this._emit(out, okp.map(function (pp) { return { p: pp, stem: true }; }), i, okEnd, chars, line);
        i += okLiteral;
        continue;
      }
      // 漢数字: 辞書の2字以上の語(一人一人・一般 など)に当たらなければ、数量かどうかを先に見る
      if (KANSUJI.indexOf(chars[i]) >= 0 && best <= 1) {
        var j0 = i;
        while (j0 < n && KANSUJI.indexOf(chars[j0]) >= 0) { j0++; }
        var ks0 = this._kansuji(chars, i, j0, n);
        if (ks0) { ks0.line = line[i]; out.push(ks0); i = j0 + (ks0.counterLen || 0); continue; }
      }
      if (best > 0) {
        var ix = i, bx = best;
        cands = cands.map(function (c) {
          var x = c.p.x;
          if (!x) { return c; }
          var hit = x.filter(function (e) {
            return sub(ix - Array.from(e[0]).length, ix) === e[0] && sub(ix + bx, ix + bx + Array.from(e[1]).length) === e[1] &&
              ix - Array.from(e[0]).length >= 0;
          }).map(function (e) { return e[2]; });
          // 辞書が用例・複合語でこの書き方を使う(売上高・取引所・現物取引)→ 要確認(意味)。使える語を並べる(Q38)
          var same = hit.length > 0;
          if (!hit.length) { hit = x.map(function (e) { return e[2]; }); }
          var k = c.p.k, nk = {}, src = [];
          Object.keys(k).forEach(function (x2) {
            if (['ng', 'kana', 'okuri'].indexOf(x2) >= 0) { src = src.concat(k[x2]); } else { nk[x2] = k[x2]; }
          });
          nk.mean = (nk.mean || []).concat(src, hit).filter(function (v, q, a) { return a.indexOf(v) === q; });
          return { p: { s: c.p.s, k: nk, c: c.p.c, xw: c.p.xw || [], xsrc: src, xsame: same }, stem: c.stem };
        });
      }
      if (best > 0 && tokens) {
        // 同音の使い分け(川/河、修行/修業)は、固有名詞(香川・川西)の中では出さない
        var properHere = true;
        for (var q0 = i; q0 < i + best; q0++) { if (!(tokAt[q0] && tokAt[q0].pos_detail_1 === '固有名詞')) { properHere = false; break; } }
        if (properHere) {
          cands = cands.map(function (c) {
            if (!c.p.h || !c.p.k.mean || !c.p.k.ok) { return c; }
            var nk3 = {};
            Object.keys(c.p.k).forEach(function (x3) { if (x3 !== 'mean') { nk3[x3] = c.p.k[x3]; } });
            return { p: Object.assign({}, c.p, { k: nk3 }), stem: c.stem };
          });
        }
        var i0 = i, b0 = best;
        var okVerb = false;   // この位置が正しい動詞・形容詞の活用形か
        var okVerbIds = [];
        for (var L2 = Math.min(this.maxStem, n - i); L2 >= 1 && !okVerb; L2--) {
          var l2 = this.stemMap.get(sub(i, i + L2));
          if (l2 && l2.some(function (pp) { return pp.k.ok && verbHere(pp, i0, L2); })) {
            // 動詞・形容詞1語が、指摘の範囲をまるごと覆うときだけ(乾いた の「乾い」)。滞荷・怖れる は対象外
            var tv = tokAt[i + L2 - 1];
            if (tv && tv._s === i && tv._e >= i + b0) {
              okVerb = true;
              l2.forEach(function (pp) { if (pp.k.ok && verbHere(pp, i0, L2)) { okVerbIds = okVerbIds.concat(pp.k.ok); } });
            }
          }
        }
        cands = cands.map(function (c) {
          var k = c.p.k;
          // 参考(②・読みがな)は、解析器の読みが その項目のよみと合わなければ外す(他社=たしゃ は ①ほか に当たらない。来た=く も ①きたる でない)
          ['second', 'yomi'].forEach(function (x) {
            if (!k[x]) { return; }
            var keepIds = k[x].filter(function (id) { return readingFits([id], i0, i0 + b0, c.stem); });
            if (keepIds.length === k[x].length) { return; }
            var nk1 = {};
            Object.keys(k).forEach(function (x2) { if (x2 !== x) { nk1[x2] = k[x2]; } });
            if (keepIds.length) { nk1[x] = keepIds; }
            k = nk1;
            c = { p: Object.assign({}, c.p, { k: nk1 }), stem: c.stem };
          });
          var flagged = ['ng', 'kana', 'okuri'].filter(function (x) { return k[x]; });
          if (!flagged.length) { return c; }
          var ids = [];
          flagged.forEach(function (x) { ids = ids.concat(k[x]); });
          // 解析器がこの範囲を1語と見ていない(微笑み = 微|笑み の接頭詞＋名詞)ときは、解析器の読みを別の語の根拠にしない
          // (読みが合わなくても要確認に下げず、辞書の指摘のまま)。2026-09-29「微笑み」
          var tA = tokAt[i0], tB = tokAt[i0 + b0 - 1];
          var oneWord = !!(tA && tA === tB) || c.stem;
          if (!oneWord && !k.okuri && tA && tB && tA !== tB && (tA.pos === '接頭詞' || tB._e > i0 + b0)) {
            return c;
          }
          if (readingFits(ids, i0, i0 + b0, c.stem)) {
            // 読みの合う項目だけに絞る(綺麗: きれい〔×綺麗〕は合う、身ぎれい〔×綺麗〕は合わない)
            var fit = ids.filter(function (id) { return readingFits([id], i0, i0 + b0, c.stem); });
            var sr0 = spanReading(i0, i0 + b0);
            if (sr0 && fit.length && fit.length < ids.length) {
              var nk0 = {};
              Object.keys(k).forEach(function (x) {
                var v = flagged.indexOf(x) >= 0 ? k[x].filter(function (id) { return fit.indexOf(id) >= 0; }) : k[x];
                if (v.length) { nk0[x] = v; }
              });
              return { p: { s: c.p.s, k: nk0, c: c.p.c }, stem: c.stem };
            }
            // 表外字1字で、読みを確かめられないもの(灼け の「灼」)は表外字として出す
            if (!sr0 && Array.from(c.p.s).length === 1 && !self.joyo.has(c.p.s) && !k.okuri) {
              return { p: { s: c.p.s, k: { hyogai: ids }, c: c.p.c }, stem: c.stem };
            }
            return c;
          }
          // 見逃しゼロの方針: 正しい動詞の活用形(乾いた)に当たっていても消さず、下で要確認(読み)にする
          if (!k.okuri && Array.from(c.p.s).some(function (ch) { return isKanji(ch) && !self.joyo.has(ch); })) {
            // 表外字を含む書き方は、読みに関係なく不適切 → 表外字として要修正(辞書の項目は参考に付ける)
            var nk2 = {};
            Object.keys(k).forEach(function (x) { if (flagged.indexOf(x) < 0) { nk2[x] = k[x]; } });
            nk2.hyogai = ids;
            return { p: { s: c.p.s, k: nk2, c: c.p.c }, stem: c.stem };
          }
          var nk = {};
          Object.keys(k).forEach(function (x) { if (flagged.indexOf(x) < 0) { nk[x] = k[x]; } });
          // 読みが合わない: 消さずに要確認(読み)へ下げる(見逃しゼロの方針)
          var keep = [];
          ['ng', 'kana', 'okuri'].forEach(function (x) { if (k[x]) { keep = keep.concat(k[x]); } });
          if (keep.length) { nk.read = (nk.read || []).concat(keep); }
          if (okVerb && okVerbIds.length) { nk.ok = (nk.ok || []).concat(okVerbIds); }   // 使える見出し(乾く)を並べる
          // 解析器の読みでは別の語(何の=なんの。辞書の〔▲何〕は どの): 頭の字の正しい見出し(何=なに・なん)も並べ、
          // 「なんの と読む場合は このまま」と示す(2026-09-29 ユーザー指摘「何の」)
          var altR = '', chs = Array.from(c.p.s);
          if (!okVerb && !c.stem && tA && tA._s === i0) {
            for (var q0 = i0; q0 < i0 + b0 && tokAt[q0]; q0 = tokAt[q0]._e) {
              var tq = tokAt[q0];
              altR += tq.reading && tq.reading !== '*' ? tq.reading : tq.surface_form;
            }
            altR = altR.replace(/[ァ-ヶ]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0x60); });
            for (var L0 = chs.length - 1; L0 >= 1; L0--) {
              var pp0 = self.map.get(chs.slice(0, L0).join(''));
              if (pp0 && pp0.k.ok) {
                nk.ok = (nk.ok || []).concat(pp0.k.ok);
                // 後ろがかなだけなら、辞書にある頭の字の読み(何{カ／なに・なん}・なに 何)でも読みを並べる(なにの・なんの)
                var rest = chs.slice(L0).join(''), pre = chs.slice(0, L0).join('');
                if (/^[ぁ-ん]+$/.test(rest)) {
                  var rs = [altR];
                  pp0.k.ok.forEach(function (id) {
                    var e0 = self.entries[id], m0 = /\{[^}／]*／([^}]*)\}/.exec(e0.d);
                    if (m0 && e0.f.some(function (f) { return f.t === pre; })) {
                      m0[1].split('・').forEach(function (r) { if (/^[ぁ-ん]+$/.test(r)) { rs.push(r + rest); } });
                    } else if (e0.f.some(function (f) { return f.t === pre; })) { rs.push(e0.y + rest); }
                  });
                  altR = rs.filter(function (v, q, a) { return v && a.indexOf(v) === q; }).join('・');
                }
                break;
              }
            }
          }
          return { p: { s: c.p.s, k: nk, c: c.p.c, ar: altR }, stem: c.stem };
        }).filter(function (c) { return c; });
      }
      // 同じ漢字の並びで別の語(微笑=びしょう の字で「微笑む=ほほえむ」を書いている): 辞書の太字どおりでも、
      // 解析器の読みがその語のよみと合わなければ要確認(読み)にし、解析器の読みの項目を並べる(2026-09-29 ユーザー指摘)
      var numHere = i > 0 && /[0-9０-９]/.test(chars[i - 1]) && /[万億兆]/.test(chars[i]);   // 1万人 の「万人」は数
      if (best >= 2 && tokens && !numHere && cands.length && cands.every(function (c) {
        return c.p.k.ok && !Object.keys(c.p.k).some(function (x) { return FLAG_KINDS.indexOf(x) >= 0; });
      }) && Array.from(sub(i, i + best)).filter(function (ch) { return isKanji(ch); }).length >= 2) {
        var okIds2 = [], anyStem = cands.some(function (c) { return c.stem; });
        cands.forEach(function (c) { okIds2 = okIds2.concat(c.p.k.ok); });
        // 解析器がこの範囲を1語(固有名詞でない)と見て、その読みが違うときだけ(字ごとの読み 一歩=イチホ、固有名詞 高山=たかやま は除く)
        var tw0 = tokAt[i], tw1 = tokAt[i + best - 1];
        var oneTok = tw0 && tw0 === tw1 && tw0.pos_detail_1 !== '固有名詞' && tw0.word_type !== 'UNKNOWN';
        if (oneTok && !readingFits(okIds2, i, i + best, anyStem)) {
          var t0 = tokAt[i], t1 = tokAt[i + best - 1];
          var endT = t1 && t1._e > i + best && t1._e - (i + best) <= 4 ? t1._e : i + best;
          var an = '', q = t0 ? t0._s : i;
          while (q < endT && tokAt[q]) { an += tokAt[q].reading && tokAt[q].reading !== '*' ? tokAt[q].reading : tokAt[q].surface_form; q = tokAt[q]._e; }
          // 1語なら基本形の読み(微笑ん=ホホエン → ほほえむ)で辞書を引く
          var found = [], baseR = '';
          if (t0 && t0 === t1 && t0.reading && t0.reading !== '*') {
            var sf = t0.surface_form, bf = t0.basic_form && t0.basic_form !== '*' ? t0.basic_form : sf;
            var tailS = (sf.match(/[ぁ-ん]*$/) || [''])[0], tailB = (bf.match(/[ぁ-ん]*$/) || [''])[0];
            var hr = t0.reading.replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); });
            baseR = hr.slice(0, hr.length - tailS.length) + tailB;
            found = (self.byLoose[looseYomi(baseR)] || []).filter(function (id) { return okIds2.indexOf(id) < 0; });
          }
          var yk = okIds2.map(function (id) { return self.entries[id].y; }).filter(function (v, q2, a) { return a.indexOf(v) === q2; });
          var ft = found.map(function (id) { return self.formsText(id); }).filter(function (v, q2, a) { return a.indexOf(v) === q2; });
          out.push({ start: i, end: endT, line: line[i], text: chars.slice(i, endT).join(''), kind: 'read',
            suggest: '読みが辞書と違う(辞書: ' + sub(i, i + best) + '＝' + yk.join('・') + ' ／ 解析器: ' + (baseR || an) + ')' +
              (ft.length ? ' → ' + (baseR || an) + ' は ' + ft.join(' ／ ') : ''),
            entries: found.concat(okIds2), okEntries: okIds2,
            heads: ['この字の並びの見出し(辞書の読み)', '解析器の読み「' + (baseR || an) + '」の見出し'],
            note: '同じ漢字の並びで別の語の疑い。読みは解析器の推定' });
          i += best;
          continue;
        }
      }
      if (best > 0) {
        var end = i + best;
        var shownEnd = end;
        if (cands.some(function (c) { return c.stem; })) {
          var tk = tokAt[end - 1];
          if (tk && tk._e > end && tk._e - end <= 4) { shownEnd = tk._e; }
          while (shownEnd < n && shownEnd - end < 4 && isHira(chars[shownEnd]) && !tk) { shownEnd++; }
        }
        this._emit(out, cands, i, shownEnd, chars, line);
        i = end;
        continue;
      }
      // 辞書の語に当たらない字: 漢数字・表外字
      if (KANSUJI.indexOf(chars[i]) >= 0) {
        var j = i;
        while (j < n && KANSUJI.indexOf(chars[j]) >= 0) { j++; }
        var ks = this._kansuji(chars, i, j, n);
        if (ks) { ks.line = line[i]; out.push(ks); i = j; continue; }
      }
      if (isKanji(chars[i]) && !this.joyo.has(norm[i])) {
        out.push({
          start: i, end: i + 1, line: line[i], text: chars[i], kind: 'hyogai',
          suggest: 'かな書き、または言い換え', entries: [],
          note: '放送で使わない字(常用漢字表と、辞書が使ってよいとする字にない字)'
        });
      } else if (isKanji(chars[i]) || chars[i] === '々') {
        this._pushChar(out, i, chars, line);
      }
      i++;
    }
    // 注記の文脈ルール(2番目の版): 当たった範囲の 使用可・辞書に語なし・1字/読み/意味の要確認 を置き換える
    if (this.rules && tokens) {
      var found = this.rules.find(chars, tokens, tokAt), seen = {};
      found.forEach(function (r) {
        var key = r.start + ':' + r.end + ':' + r.kind;
        if (seen[key]) { return; }
        seen[key] = 1;
        // 辞書の太字どおりの語が、規則に当たった所を含んで前から始まる(つかみ出す・やって来る・航程)なら、規則は当てない
        // (注記は「歩きだす」「寒くなってくる」「3日ほど」の使い方で、辞書に太字で載る語は別。2026-09-29 全文字列の試験)
        // 限定用語など(要確認)は見逃しゼロの方針で残す(人混み)
        if (r.kind === 'ctx' && out.some(function (f) {
          return ['ok', 'mean', 'read', 'single', 'second', 'yomi'].indexOf(f.kind) >= 0 && f.entries.length &&
            f.start < r.start && f.end >= r.end;
        })) { return; }
        if (r.kind === 'ctx') {
          out = out.filter(function (f) {
            var overlap = f.start < r.end && r.start < f.end;
            return !(overlap && ['ok', 'char', 'single', 'read', 'mean'].indexOf(f.kind) >= 0);
          });
        }
        r.line = line[r.start];
        r.text = chars.slice(r.start, r.end).join('');
        out.push(r);
      });
    }
    // 「辞書に語なし」の字は、続いているものを1つにまとめる(特撮 など)
    var merged = [];
    out.forEach(function (f) {
      var last = merged[merged.length - 1];
      if (f.kind === 'char' && last && last.kind === 'char' && last.end === f.start && last.line === f.line) {
        last.end = f.end; last.text += f.text; last.entries = last.entries.concat(f.entries);
      } else { merged.push(f); }
    });
    out = merged;
    out.forEach(function (f) {
      if (f.kind !== 'char') { return; }
      var chk = self._charReading(f, chars, norm, tokens, tokAt);
      if (chk && chk.ok) {
        f.kind = 'charok';
        f.suggest = 'そのまま(' + chk.detail + ')';
        f.note = '語としては辞書に載っていないが、各字を常用の音訓で読める(読みは解析器による)';
      } else if (chk && !chk.ok) {
        f.kind = 'charrd';
        f.suggest = '読みを確認(' + chk.detail + ')';
        f.note = '常用の音訓にない読み(辞書の▲=表外音訓)に当たる疑い。読みは解析器の推定';
      } else {
        f.suggest = 'そのまま(各字は放送で使える字)';
        f.note = '語としては辞書に載っていない。読みを確かめられなかった';
      }
    });
    // ×・▲・〔 〕内の字は、推奨表記がかなの語でも「使わない漢字」として出す(2026-09-29 ユーザー指示)。
    // 同じ箇所に ng と kana の両方があれば1行にまとめる
    var byPos = {};
    out = out.filter(function (f) {
      if (f.kind !== 'kana' && f.kind !== 'ng') { return true; }
      f.kind = 'ng';
      var key = f.start + ':' + f.end;
      if (byPos[key]) {
        var g = byPos[key];
        f.entries.forEach(function (id) { if (g.entries.indexOf(id) < 0) { g.entries.push(id); } });
        if (f.suggest && g.suggest.indexOf(f.suggest) < 0) { g.suggest += ' ／ ' + f.suggest; }
        return false;
      }
      byPos[key] = f;
      return true;
    });
    out.sort(function (a, b) { return a.start - b.start || KIND[a.kind].order - KIND[b.kind].order; });
    out.forEach(function (f) { f.before = chars.slice(Math.max(0, f.start - 10), f.start).join('').replace(/\n/g, ' '); f.after = chars.slice(f.end, f.end + 10).join('').replace(/\n/g, ' '); });
    return out;
  };

  Engine.prototype._emit = function (out, cands, s, e, chars, line) {
    var byKind = {};
    cands.forEach(function (c) {
      Object.keys(c.p.k).forEach(function (k) {
        if (FLAG_KINDS.indexOf(k) < 0) { return; }
        if (!byKind[k]) { byKind[k] = new Set(); }
        c.p.k[k].forEach(function (id) { byKind[k].add(id); });
      });
    });
    var self = this;
    var text = chars.slice(s, e).join('');
    if (!Object.keys(byKind).length) {
      if (!Array.from(text).some(function (ch) { return isKanji(ch) || ch === '々' || ch === '〆'; })) { return; }
      var okIds = new Set(), unitOnly = true;
      cands.forEach(function (c) {
        (c.p.k.ok || []).forEach(function (id) { okIds.add(id); });
        if (!c.p.u || c.stem) { unitOnly = false; }
      });
      if (unitOnly) { for (var q = s; q < e; q++) { if (isKanji(chars[q])) { self._pushChar(out, q, chars, line); } } return; }
      var ids0 = Array.from(okIds);
      out.push({ start: s, end: e, line: line[s], text: text, kind: 'ok',
        suggest: 'そのまま(辞書の太字どおり)', entries: ids0, note: '' });
      // 正しい表記の語の頭の部分が、使わない書き方でもある(細々と=ほそぼそ ／ 細々=こまごま〔細々〕)→ 要確認を足す
      var nt = Array.from(text).map(function (ch) { return self.normChar(ch); });
      for (var L = nt.length - 1; L >= 2; L--) {
        var pp = self.map.get(nt.slice(0, L).join(''));
        if (pp && (pp.k.ng || pp.k.kana) && !pp.x) {   // 辞書が用例で使う文字列(拭き=黒板拭き)は除く
          var pids = (pp.k.ng || []).concat(pp.k.kana || []);
          out.push({ start: s, end: s + L, line: line[s], text: chars.slice(s, s + L).join(''), kind: 'read',
            suggest: self._suggest('read', pids), entries: pids,
            note: '「' + text + '」は辞書の太字どおりだが、読みによっては使わない書き方' });
          break;
        }
      }
      return;
    }
    // 1字の要確認だけで、解析器が正しい動詞・形容詞(限る・行う)と確かめたもの → 使用可(根拠つき)
    var ks = Object.keys(byKind);
    var verbOk = cands.filter(function (c) { return c.stem && c.p.k.ok; });
    if (ks.length === 1 && ks[0] === 'single' && verbOk.length) {
      var vids = [];
      verbOk.forEach(function (c) { vids = vids.concat(c.p.k.ok); });
      var alt = Array.from(byKind.single).map(function (id) { return self.entries[id].y; });
      out.push({ start: s, end: e, line: line[s], text: text, kind: 'ok',
        suggest: 'そのまま(動詞・形容詞「' + verbOk[0].p.s + '」として)', entries: vids,
        note: '1字の要確認(' + alt.join('・') + ' など)は、解析器が動詞・形容詞と判定したので当たらないとみなした' });
      return;
    }
    // 要確認(1字・読み・意味)には、その字・語を使える見出し(辞書の太字)も全部付ける
    var okAll = new Set();
    cands.forEach(function (c) { (c.p.k.ok || []).forEach(function (id) { okAll.add(id); }); });
    var okList = Array.from(okAll);
    Object.keys(byKind).forEach(function (k) {
      var ids = Array.from(byKind[k]);
      var f = { start: s, end: e, line: line[s], text: chars.slice(s, e).join(''), kind: k,
        suggest: self._suggest(k, ids), entries: ids, note: '' };
      var xc = k === 'mean' ? cands.filter(function (c) { return c.p.xsrc; })[0] : null;
      if (xc) {
        // この書き方をしてよい語(用例・複合語)と、それ以外の書き方を示す(売上 → 売上高・売上金… ／ それ以外は 売り上げ)
        var words = xc.p.xw.map(function (w) { return w[0]; }).filter(function (v, q, a) { return a.indexOf(v) === q; });
        var wids = xc.p.xw.map(function (w) { return w[1]; });
        f.okEntries = wids.concat(ids.filter(function (id) { return xc.p.xsrc.indexOf(id) < 0; }))
          .filter(function (v, q, a) { return a.indexOf(v) === q; });
        f.entries = ids.concat(f.okEntries).filter(function (v, q, a) { return a.indexOf(v) === q; });
        f.suggest = 'この書き方をするのは: ' + words.join('・') + ' ／ それ以外は ' +
          xc.p.xsrc.map(function (id) { return self.formsText(id); }).filter(function (v, q, a) { return a.indexOf(v) === q; }).join('・');
        f.note = xc.p.xsame ? 'この箇所は辞書の用例と同じ前後' : '辞書の用例・複合語とは前後が違う';
        f.heads = ['この書き方をする見出し', 'それ以外の場合の書き方'];
        out.push(f);
        return;
      }
      if (k === 'mean') {
        // 同じ読みで意味により字が分かれる(修行/修業)・送りがなの組(受付/受け付け): 表記と注記・用例を並べる
        var okOther = okList.filter(function (id) { return ids.indexOf(id) < 0; });
        if (okOther.length) {
          f.okEntries = ids.slice();
          f.entries = ids.concat(okOther);
          f.heads = ['意味・用法で使い分ける見出し', 'そのほかの見出し'];
        }
        // 並べるのは要確認の項目と、使える語の項目(単字エントリ 川[1]{セン／かわ} は字の説明なので除く)
        var shown = ids.concat(okOther.filter(function (id) { return !/^[^　]*　\*\*[^*]\*\*(\[\d\])?\{/.test(self.entries[id].d); }));
        f.suggest = '使い分け: ' + shown.map(function (id) {
          return self.formsText(id) + (self._usage(id) ? '：' + self._usage(id) : '');
        }).filter(function (v, q, a) { return a.indexOf(v) === q; }).join(' ／ ');
        out.push(f);
        return;
      }
      var arC = k === 'read' && cands.filter(function (c) { return c.p.ar && c.p.k.read; })[0];
      if (arC && okList.length) {
        f.okEntries = okList.filter(function (id) { return ids.indexOf(id) < 0; });
        f.entries = ids.concat(f.okEntries);
        f.suggest = arC.p.ar + ' と読む場合は このまま ／ ' + ids.map(function (id) { return self.entries[id].y; })
          .filter(function (y, q, a) { return a.indexOf(y) === q; }).join('・') + ' と読む場合は ' +
          ids.map(function (id) { return self.formsText(id); }).filter(function (x, q, a) { return a.indexOf(x) === q; }).join('・');
        f.heads = ['使える見出し(' + arC.p.ar + ' と読む場合)', '使わない書き方の見出し'];
        f.note = '読みは解析器の推定';
        out.push(f);
        return;
      }
      if (['single', 'read', 'mean'].indexOf(k) >= 0 && okList.length) {
        var okNot = okList.filter(function (id) { return ids.indexOf(id) < 0; });
        f.okEntries = okNot;
        var ys = okNot.map(function (id) { return self.entries[id].y; }).filter(function (y, i, a) { return a.indexOf(y) === i; });
        var ns = ids.filter(function (id) { return okNot.indexOf(id) < 0; })
          .map(function (id) { return self.entries[id].y; }).filter(function (y, i, a) { return a.indexOf(y) === i; });
        var sameYomi = k === 'mean' && ns.some(function (y) { return ys.indexOf(y) >= 0; });
        if (ys.length && sameYomi) {
          // 同じ読みで意味・用法により分かれる(過ぎない ／ …にすぎない): 表記と用例を並べる
          f.suggest = '使い分け: ' + ids.concat(okNot).filter(function (v, q, a) { return a.indexOf(v) === q; }).map(function (id) {
            return self.formsText(id) + (self._usage(id) ? '：' + self._usage(id) : '');
          }).filter(function (v, q, a) { return a.indexOf(v) === q; }).join(' ／ ');
        } else if (ys.length) {
          f.suggest = '使える: ' + ys.join('・') + (ns.length ? ' と読む場合 ／ ' + ns.join('・') + ' と読む場合は ' +
            ids.filter(function (id) { return okNot.indexOf(id) < 0; }).map(function (id) { return self.formsText(id); })
              .filter(function (x, i, a) { return a.indexOf(x) === i; }).join('・') : '');
        }
      }
      out.push(f);
    });
  };

  /** 「辞書に語なし」の範囲の読みを字ごとに割り振り、常用の音訓と照らす。
   *  戻り値: null(割り振れない) / {ok: true|false, detail: '撮(さつ)影(えい)'} */
  Engine.prototype._charReading = function (f, chars, norm, tokens, tokAt) {
    if (!tokens) { return null; }
    var ta = tokAt[f.start], tb = tokAt[f.end - 1];
    if (!ta || !tb) { return null; }
    var a = ta._s, b = tb._e, r = '', k = a;
    while (k < b) {
      var t = tokAt[k];
      if (!t || !t.reading || t.reading === '*') { return null; }
      r += t.reading; k = t._e;
    }
    var hira = r.replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); });
    var sc = chars.slice(a, b), sn = norm.slice(a, b), self = this;
    var n = sc.length, memo = {};
    // 字ごとに割り振る。かなはそのまま一致、漢字は1〜4かな。常用の読みに入る字の数が最大の割り振りを採る
    function rec(i, p) {
      var key = i + ':' + p;
      if (key in memo) { return memo[key]; }
      var best = null;
      if (i === n) { best = p === hira.length ? { score: 0, parts: [] } : null; }
      else if (!isKanji(sc[i]) && sc[i] !== '々') {
        var h = sc[i].replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); });
        if (hira.substr(p, h.length) === h) {
          var r1 = rec(i + 1, p + h.length);
          if (r1) { best = { score: r1.score, parts: [[sc[i], h, true]].concat(r1.parts) }; }
        }
      } else {
        for (var L = 1; L <= 4 && p + L <= hira.length; L++) {
          var piece = hira.substr(p, L);
          var set = self.rd[sn[i]];
          var inSet = !!(set && set.has(piece)) || sc[i] === '々';
          var r2 = rec(i + 1, p + L);
          if (r2 && (!best || r2.score + (inSet ? 1 : 0) > best.score)) {
            best = { score: r2.score + (inSet ? 1 : 0), parts: [[sc[i], piece, inSet]].concat(r2.parts) };
          }
        }
      }
      memo[key] = best;
      return best;
    }
    var res = rec(0, 0);
    if (!res) { return null; }
    var inRange = res.parts.slice(f.start - a, f.end - a);
    var ok = inRange.every(function (x) { return x[2]; });
    return {
      ok: ok,
      detail: inRange.map(function (x) { return x[0] + '(' + x[1] + (x[2] ? '' : '?') + ')'; }).join('')
    };
  };

  /** 語としては辞書にない字(単字エントリだけ)を「辞書に語なし」として出す */
  Engine.prototype._pushChar = function (out, q, chars, line) {
    var p = this.map.get(this.normChar(chars[q]));
    var ids = p && p.k.ok ? p.k.ok.filter(function (id) { return true; }) : [];
    out.push({ start: q, end: q + 1, line: line[q], text: chars[q], kind: 'char', suggest: '', entries: ids, note: '' });
  };

  /** 項目の用例・注記を短く(推奨表記の欄の「使い分け」用) */
  Engine.prototype._usage = function (id) {
    var d = this.entries[id].d.replace(/\*\*[^*]+\*\*|〔[^〕]*〕|\{[^}]*\}|【[^】]*】|\[\d\]|\(p\.\d+参照\)/g, '')
      .replace(/^[ぁ-ん]+　*/, '').replace(/[　 ]+/g, '');
    return d.length > 30 ? d.slice(0, 30) + '…' : d;
  };

  /** 項目の推奨表記を文字列にする */
  Engine.prototype.formsText = function (id) {
    var e = this.entries[id];
    var main = e.f.filter(function (f) { return f.r !== '2'; });
    var two = e.f.filter(function (f) { return f.r === '2'; });
    if (two.length) {
      return '①' + main.map(function (f) { return f.t; }).join('・') + '　②' + two.map(function (f) { return f.t; }).join('・');
    }
    return e.f.map(function (f) { return f.t; }).join('・');
  };

  Engine.prototype._suggest = function (k, ids) {
    var self = this;
    var uniq = function (arr) { return arr.filter(function (x, i) { return arr.indexOf(x) === i; }); };
    if (k === 'ng' || k === 'kana' || k === 'okuri') {
      return uniq(ids.map(function (id) { return self.formsText(id); })).join(' ／ ');
    }
    if (k === 'hyogai') {
      return 'かな書き、または言い換え(参考: ' + uniq(ids.map(function (id) { return self.entries[id].y; })).join('・') + ')';
    }
    if (k === 'second') {
      return uniq(ids.map(function (id) {
        return self.entries[id].f.filter(function (f) { return f.r === '1'; }).map(function (f) { return '①' + f.t; }).join('・');
      })).join(' ／ ');
    }
    if (k === 'yomi') {
      return uniq(ids.map(function (id) {
        var m = /\{([^}／]*)\}/.exec(self.entries[id].d);
        return m ? '読みがな「' + m[1] + '」を付ける' : '読みがなを付ける';
      })).join(' ／ ');
    }
    // 要確認: 候補の項目を並べる
    return uniq(ids.map(function (id) { return self.entries[id].y + '→' + self.formsText(id); })).join(' ／ ');
  };

  /** 漢数字の数量を見つけてアラビア数字の案を作る */
  Engine.prototype._kansuji = function (chars, i, j, n) {
    var run = chars.slice(i, j).join('');
    var after = chars.slice(j, Math.min(n, j + 6)).join('');
    var counter = null;
    for (var c = 0; c < COUNTERS.length; c++) {
      if (after.indexOf(COUNTERS[c]) === 0) { counter = COUNTERS[c]; break; }
    }
    if (/^[万億兆]+$/.test(run) && i > 0 && /[0-9０-９]/.test(chars[i - 1])) { return null; }
    var prefixDai = i > 0 && chars[i - 1] === '第';
    var numeric = run.length >= 2 && /[十百千万億兆〇]/.test(run) || /^[〇一二三四五六七八九]{2,}$/.test(run);
    if (!counter && !prefixDai && !numeric) { return null; }
    var arabic = kansujiToArabic(run);
    if (arabic == null) { return null; }
    return {
      start: i, end: j, line: null, text: run, kind: 'kansuji',
      suggest: arabic + (counter || ''), entries: [],
      note: '数字は原則アラビア数字', counterLen: counter ? Array.from(counter).length : 0
    };
  };

  function kansujiToArabic(s) {
    if (/^[〇一二三四五六七八九]+$/.test(s)) {
      return s.split('').map(function (ch) { return KDIGIT[ch]; }).join('');
    }
    // 万・億・兆はそのまま残す(3万人、1億2000万)
    var parts = [], cur = '';
    for (var k = 0; k < s.length; k++) {
      var ch = s[k];
      if (ch === '万' || ch === '億' || ch === '兆') {
        var v = small(cur);
        if (v == null) { return null; }
        parts.push((cur === '' ? '1' : String(v)) + ch);
        cur = '';
      } else { cur += ch; }
    }
    if (cur !== '') {
      var w = small(cur);
      if (w == null) { return null; }
      parts.push(String(w));
    }
    return parts.join('');
  }

  function small(s) {
    // 千・百・十と一〜九からなる4桁までの数
    if (s === '') { return 0; }
    if (/^[〇一二三四五六七八九]+$/.test(s)) { return Number(s.split('').map(function (ch) { return KDIGIT[ch]; }).join('')); }
    var total = 0, num = null;
    var units = { '十': 10, '百': 100, '千': 1000 };
    for (var k = 0; k < s.length; k++) {
      var ch = s[k];
      if (KDIGIT.hasOwnProperty(ch)) { num = KDIGIT[ch]; }
      else if (units[ch]) { total += (num == null ? 1 : num) * units[ch]; num = null; }
      else { return null; }
    }
    return total + (num || 0);
  }

  Engine.kansujiToArabic = kansujiToArabic;
  global.KanjiEngine = Engine;
})(typeof window !== 'undefined' ? window : this);
