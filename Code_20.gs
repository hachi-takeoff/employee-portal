/**
 * ============================================================
 * 従業員ポータル ゲートウェイ（LIFF + GAS）
 * ------------------------------------------------------------
 * リッチメニューの各ボタンは、この Web アプリの URL に
 * ?page=xxx を付けてリンクしてください。
 *   例）マニュアル       : https://script.google.com/macros/s/xxx/exec?page=manual
 *       従業員クーポン    : https://script.google.com/macros/s/xxx/exec?page=coupon
 *       freee            : https://script.google.com/macros/s/xxx/exec?page=freee
 *       シフト希望提出    : https://script.google.com/macros/s/xxx/exec?page=shift
 *       引き継ぎ掲示板    : https://script.google.com/macros/s/xxx/exec?page=board
 *       要望・質問箱      : https://script.google.com/macros/s/xxx/exec?page=suggest
 *
 * 従業員名簿の「所属店舗」を「本部」に設定したスタッフは、本部権限として
 * 扱われ、全員の要望/質問閲覧ができるようになります（掲示板は、I列「閲覧可能店舗」が
 * 空欄であれば本部以外のスタッフも全店舗を閲覧・投稿できます）。
 *
 * 事前にスクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）に
 * 以下を設定してください。
 *   SPREADSHEET_ID         … 従業員名簿シートを持つスプレッドシートのID
 *   LIFF_ID                … LINE DevelopersのLIFFアプリID
 *   LINE_LOGIN_CHANNEL_ID  … LINEログインチャネルのChannel ID
 *   LINK_FREEE             … freee人事労務のログインURL
 *   LINK_MANUAL            … マニュアル格納先（Googleドライブ等）のURL
 *   ※従業員クーポンはポータル内の画面（?page=coupon）で表示するため、
 *     LINK_COUPON の設定は不要です。
 *
 * シフト希望の対象期間は毎月自動で切り替わります（手動設定不要）。
 *   毎月1〜15日   … 今月後半（16日〜月末）分が対象。締切は毎月10日
 *   毎月16日〜月末 … 来月前半（1〜15日）分が対象。締切は毎月25日
 *   締切を過ぎても提出はできます（画面に注意書きが出ます）。
 *   締切日を変えたい場合はスクリプトプロパティ
 *   SHIFT_WINDOW1_END_DAY / SHIFT_WINDOW2_END_DAY を設定してください。
 *
 * 定休日はスクリプトプロパティ CLOSED_WEEKDAYS で設定します（未設定時は「木」）。
 *   例）木,日 と設定すると木曜と日曜が入力不可になります。
 *       定休日をなくす場合は空欄を設定してください。
 * ============================================================
 */

const SHEET_NAME = '従業員名簿';

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function getDestinations_() {
  return {
    freee: getProp_('LINK_FREEE'),
    manual: getProp_('LINK_MANUAL'),
    coupon: getProp_('LINK_COUPON'),
  };
}

/**
 * ============================================================
 * JSON API（GitHub Pages等、外部ホストのLIFF入口ページから fetch() で呼び出す）
 * ------------------------------------------------------------
 * GAS のウェブアプリURLは内部で別ドメインへリダイレクトされる仕様があり、
 * これが LIFF のログイン処理と競合するため、LIFF のエンドポイントURLには
 * GAS のURLを直接使わず、外部ホスト（GitHub Pages等）に置いた入口ページを使う。
 * その入口ページは、この doGet / doPost を fetch() で呼び出してデータを取得・送信する。
 *
 * 読み取り系（GET） … ?action=xxx&idToken=...&...
 * 書き込み系（POST） … body: JSON.stringify({ action: 'xxx', idToken, ... })
 *                       ※プリフライトを避けるため Content-Type: text/plain で送ること
 * ============================================================
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action) {
    return jsonApi_(params.action, params);
  }
  // action指定がない場合。画面はGitHub Pages側のindex.htmlが担当するため、
  // ここではJSON APIとして稼働中であることと、コードのバージョンだけを返す。
  return jsonOutput_({ ok: true, api: 'employee-portal', codeVersion: CODE_VERSION });
}

/** デプロイされているコードの版を確認するための目印。コードを更新したらここも上げる。 */
const CODE_VERSION = '2026-09-16-notion';

/**
 * 外部通信（LINE APIへの接続）の権限を承認するための確認用関数。
 * 「UrlFetchApp.fetch を呼び出す権限がありません」と出た場合に、
 * Apps Scriptエディタから手動で1回実行して、表示される承認画面で許可する。
 */
function authorizeExternalRequest() {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/profile', {
    method: 'get',
    headers: { Authorization: 'Bearer dummy' },
    muteHttpExceptions: true,
  });
  Logger.log('外部通信の権限OK（応答コード: ' + res.getResponseCode() + '）');
  return res.getResponseCode();
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOutput_({ ok: false, error: 'invalid_body' });
  }
  return jsonApi_(body.action, body);
}

/** action名に応じて既存のサーバー関数を呼び分け、JSONで返す共通ディスパッチャ
 *  ※動作確認用に、実行数（Executions）のログへ action と結果を記録する。 */
function jsonApi_(action, p) {
  let result;
  try {
    switch (action) {
      case 'checkStatus':
        result = checkStatus(p.idToken); break;
      case 'registerUser':
        result = registerUser(p.idToken, p.name, p.store); break;
      case 'resolveDestination':
        result = resolveDestination(p.idToken, p.page); break;
      case 'getCoupon':
        result = getCoupon(p.idToken); break;
      case 'getShiftForm':
        result = getShiftForm(p.idToken); break;
      case 'submitShift':
        result = submitShift(p.idToken, p.periodLabel, p.entries); break;
      case 'getBoardPosts':
        result = getBoardPosts(p.idToken, p.store, p.includeResolved); break;
      case 'postBoard':
        result = postBoard(p.idToken, p.store, p.body, p.image, p.notify, p.toManual); break;
      case 'deleteBoardPost':
        result = deleteBoardPost(p.idToken, p.postId); break;
      case 'setBoardPostStatus':
        result = setBoardPostStatus(p.idToken, p.postId, p.status); break;
      case 'postBoardComment':
        result = postBoardComment(p.idToken, p.postId, p.body); break;
      case 'requestStoreAccess':
        result = requestStoreAccess(p.idToken, p.store); break;
      case 'getSuggestions':
        result = getSuggestions(p.idToken); break;
      case 'postSuggestion':
        result = postSuggestion(p.idToken, p.body, p.category); break;
      default:
        result = { ok: false, error: 'unknown_action' };
    }
    Logger.log('action=%s result=%s', action, JSON.stringify(result));
    return jsonOutput_(result);
  } catch (err) {
    Logger.log('action=%s ERROR=%s', action, String(err));
    return jsonOutput_({ ok: false, error: 'server_error', message: String(err) });
  }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** HTML内から他ファイルを読み込むためのヘルパー（現状未使用だが拡張用に残す） */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * クライアントから送られてきたLINEのトークンをLINE側で検証し、
 * { sub: LINEユーザーID, name: 表示名 } を返す。
 * クライアントから送られてきた userId をそのまま信用しないためのチェック。
 *
 * トークンは2種類のどちらでも受け付ける。
 *   - アクセストークン（現行のindex.htmlが送るもの。LIFFが自動更新するため期限切れになりにくい）
 *   - IDトークン（旧版のindex.html互換用。JWT形式なのでドットが2つある）
 */
function verifyIdToken_(token) {
  if (!token) {
    throw new Error('LINEのログイン情報が送られてきませんでした。');
  }
  // まずアクセストークンとして扱う（現行のindex.htmlはこちらを送る）。
  // 失敗した場合のみ、旧版クライアント互換としてIDトークン検証を試す。
  const byAccess = tryVerifyLineAccessToken_(token);
  if (byAccess) return byAccess;
  return verifyLineIdToken_(token);
}

/** アクセストークンとして検証を試す。失敗したら null を返す（例外は投げない） */
function tryVerifyLineAccessToken_(accessToken) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/profile', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return null;
  const profile = JSON.parse(res.getContentText()); // { userId, displayName, pictureUrl }
  return { sub: profile.userId, name: profile.displayName, picture: profile.pictureUrl };
}

/** LINEのIDトークンを検証する（旧版クライアント互換） */
function verifyLineIdToken_(idToken) {
  const channelId = getProp_('LINE_LOGIN_CHANNEL_ID');
  if (!channelId) {
    throw new Error('LINE_LOGIN_CHANNEL_ID が未設定です。');
  }
  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: {
      id_token: idToken,
      client_id: channelId,
    },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('IDトークンの検証に失敗しました: ' + res.getContentText());
  }
  return JSON.parse(res.getContentText()); // { sub, name, picture, exp, ... }
}

function getSheet_() {
  const spreadsheetId = getProp_('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('SPREADSHEET_ID が未設定です。');
  }
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。Setup.gs の initializeSheet() を先に実行してください。');
  }
  return sheet;
}

/** LINEユーザーIDで従業員名簿から該当行を探す */
function findRowByUserId_(userId) {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === userId) {
      return { rowIndex: i + 1, row: values[i] };
    }
  }
  return null;
}

/**
 * 【クライアントから呼び出し】現在の登録・承認・在籍状況を返す。
 */
function checkStatus(idToken) {
  const payload = verifyIdToken_(idToken);
  const found = findRowByUserId_(payload.sub);
  if (!found) {
    return { ok: true, status: 'not_registered' };
  }
  const [, name, store, approval, active] = found.row;
  return { ok: true, status: 'found', name, store, approval, active };
}

/**
 * 【クライアントから呼び出し】初回登録。氏名・所属店舗を受け取り、
 * 「未承認・在籍」の状態で従業員名簿に追加する。
 */
function registerUser(idToken, name, store) {
  const payload = verifyIdToken_(idToken);
  const userId = payload.sub;

  if (!name || !store) {
    return { ok: false, error: 'missing_fields' };
  }
  const existing = findRowByUserId_(userId);
  if (existing) {
    return { ok: false, error: 'already_registered' };
  }

  const sheet = getSheet_();
  sheet.appendRow([userId, name, store, '未承認', '在籍', new Date(), '', '', '']); // I列(閲覧可能店舗)は空欄＝制限なし
  return { ok: true };
}

/**
 * 承認済み・在籍中かどうかを判定する共通処理。
 * resolveDestination / getShiftForm / submitShift / 掲示板系 から呼び出す。
 */
function checkAccess_(userId) {
  const found = findRowByUserId_(userId);
  if (!found) {
    return { allowed: false, reason: 'not_registered' };
  }
  const row = found.row;
  const name = row[1];
  const store = row[2];
  const approval = row[3];
  const active = row[4];
  const viewableStoresRaw = row[8] || ''; // I列「閲覧可能店舗」（カンマ区切り。空欄なら制限なし＝全店舗閲覧可）
  if (active !== '在籍') {
    return { allowed: false, reason: 'inactive' };
  }
  if (approval !== '承認済み') {
    return { allowed: false, reason: 'not_approved' };
  }
  const viewableStores = viewableStoresRaw
    ? String(viewableStoresRaw).split(/[,、]/).map((s) => s.trim()).filter(Boolean)
    : null; // null = 制限なし
  return { allowed: true, name, store, viewableStores };
}

/**
 * 【クライアントから呼び出し】リッチメニューの各ボタン用。
 * 承認済み・在籍中の場合のみ、実際の遷移先URLを返す。
 * それ以外は理由（reason）だけを返し、URLは渡さない。
 */
function resolveDestination(idToken, page) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: true, allowed: false, reason: access.reason };
  }

  const url = getDestinations_()[page];
  if (!url) {
    return { ok: true, allowed: false, reason: 'unknown_page' };
  }
  return { ok: true, allowed: true, url };
}

/* ============================================================
 * 従業員クーポン
 * ------------------------------------------------------------
 * LINE公式アカウントの純正クーポン機能は「友だち全員」が対象になり、
 * 退職者を個別に除外できないため、ポータル内の画面として実装している。
 * 承認済み・在籍中のスタッフしか開けず、退職者は在籍状態を「退職」に
 * 変更した時点で画面自体が開けなくなる。
 *
 * 画面には氏名・所属店舗と、サーバー側で発行した現在時刻を表示する。
 * スクリーンショットでは時刻が止まるため、店頭で「今その場で開いた画面か」を
 * 確認できる（使い回し・転送の防止）。
 *
 * 文言はスクリプトプロパティで変更できる（未設定時は下記の既定値）。
 *   COUPON_STAFF_TITLE / COUPON_STAFF_RATE / COUPON_STAFF_CONDITIONS
 *   COUPON_GUEST_TITLE / COUPON_GUEST_RATE / COUPON_GUEST_CONDITIONS
 *   ※CONDITIONS は「｜」区切りで複数行を指定する
 * ============================================================ */

const COUPON_DEFAULTS = {
  staffTitle: 'スタッフ特別割引（30%）クーポン',
  staffRate: '30%OFF',
  staffConditions: [
    'ご家族・お友達とのご会食にご利用ください。',
    'スタッフ本人のご同席が必要です。',
    '使用回数に上限はありません。',
    '八のグループ店舗全店でご利用いただけます。',
    '他のクーポン、割引、サービスとの併用はできません。',
    'この画面をご来店時にスタッフへご提示ください。',
  ],
  guestTitle: 'ご家族お友達特別割引（20%）クーポン',
  guestRate: '20%OFF',
  guestConditions: [
    'ご利用にはスタッフ本人からの事前予約が必要です。',
    'ご予約時に、予約者名とあわせて紹介スタッフ（ご本人）の氏名をお伝えください。',
    'スタッフ本人の同席は問いません。',
    '八のグループ店舗全店でご利用いただけます。',
    'お客様から直接ご予約いただいた場合、およびご予約なしでのご来店では利用できません。',
    '使用回数に上限はありません。',
    '他のクーポン、割引、サービスとの併用はできません。',
  ],
};

/** スクリプトプロパティの値を「｜」区切りで配列にする。未設定なら既定値を返す。 */
function couponLines_(key, fallback) {
  const raw = getProp_(key);
  if (!raw) return fallback;
  return String(raw).split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 【クライアントから呼び出し】従業員クーポン画面の表示データを返す。
 * 承認済み・在籍中でない場合はクーポンを見せず、理由だけ返す。
 */
function getCoupon(idToken) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: true, allowed: false, reason: access.reason };
  }

  const now = new Date();
  return {
    ok: true,
    allowed: true,
    name: access.name,
    store: access.store,
    // サーバー側で発行した時刻。画面ではこれを起点に秒を進めて表示する。
    issuedAt: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy年M月d日(E) HH:mm:ss'),
    issuedEpoch: now.getTime(),
    staff: {
      title: getProp_('COUPON_STAFF_TITLE') || COUPON_DEFAULTS.staffTitle,
      rate: getProp_('COUPON_STAFF_RATE') || COUPON_DEFAULTS.staffRate,
      conditions: couponLines_('COUPON_STAFF_CONDITIONS', COUPON_DEFAULTS.staffConditions),
    },
    guest: {
      title: getProp_('COUPON_GUEST_TITLE') || COUPON_DEFAULTS.guestTitle,
      rate: getProp_('COUPON_GUEST_RATE') || COUPON_DEFAULTS.guestRate,
      conditions: couponLines_('COUPON_GUEST_CONDITIONS', COUPON_DEFAULTS.guestConditions),
    },
  };
}

/* ============================================================
 * シフト希望
 * ============================================================ */

const SHIFT_SHEET_NAME = 'シフト希望';

function getShiftSheet_() {
  const spreadsheetId = getProp_('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('SPREADSHEET_ID が未設定です。');
  }
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(SHIFT_SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHIFT_SHEET_NAME + '」が見つかりません。Setup.gs の initializeShiftSheet() を先に実行してください。');
  }
  return sheet;
}

/** シフト希望の選択肢。「昼」「夜」は複数選択可（例：「昼・夜」）。「不可」は単独。 */
const SHIFT_AVAILABILITY_OPTIONS = ['昼', '夜', '不可'];

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** 月をまたぐ加算（m: 1〜12） */
function addMonth_(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year: year, month: month + 1 };
}

function lastDayOfMonth_(year, month) {
  // Dateのmonthは0始まりなので、month(1〜12)をそのまま渡すと「翌月の0日目」=当月末日になる
  return new Date(year, month, 0).getDate();
}

/**
 * シフト希望の対象期間は毎月自動で切り替わる（手動設定不要）。
 *   毎月1〜15日  … 今月後半（16日〜月末）分が対象。締切は WINDOW1_END 日
 *   毎月16〜月末 … 来月前半（1〜15日）分が対象。締切は WINDOW2_END 日
 * 締切日を過ぎても提出はできる（overdue = true になり、画面に注意書きが出る）。
 * 締切日はスクリプトプロパティ SHIFT_WINDOW1_END_DAY / SHIFT_WINDOW2_END_DAY で変更可能。
 */
function getShiftWindow_() {
  const prop = PropertiesService.getScriptProperties();
  const w1End = Number(prop.getProperty('SHIFT_WINDOW1_END_DAY')) || 10;
  const w2End = Number(prop.getProperty('SHIFT_WINDOW2_END_DAY')) || 25;

  const now = new Date();
  const tz = 'Asia/Tokyo';
  const day = Number(Utilities.formatDate(now, tz, 'd'));
  const year = Number(Utilities.formatDate(now, tz, 'yyyy'));
  const month = Number(Utilities.formatDate(now, tz, 'M'));

  if (day <= 15) {
    // 今月後半（16日〜月末）分
    const lastDay = lastDayOfMonth_(year, month);
    return {
      open: true,
      label: year + '年' + month + '月後半（16〜' + lastDay + '日）',
      start: year + '-' + pad2_(month) + '-16',
      end: year + '-' + pad2_(month) + '-' + pad2_(lastDay),
      deadline: year + '年' + month + '月' + w1End + '日',
      overdue: day > w1End,
    };
  }

  // 来月前半（1〜15日）分
  const next = addMonth_(year, month);
  return {
    open: true,
    label: next.year + '年' + next.month + '月前半（1〜15日）',
    start: next.year + '-' + pad2_(next.month) + '-01',
    end: next.year + '-' + pad2_(next.month) + '-15',
    deadline: year + '年' + month + '月' + w2End + '日',
    overdue: day > w2End,
  };
}

/**
 * 定休日の曜日を返す（例：['木']）。
 * スクリプトプロパティ CLOSED_WEEKDAYS で変更可能（カンマ区切り。例：木,日）。
 * 「なし」または空文字を設定すると定休日なしになる。
 */
function getClosedWeekdays_() {
  const raw = PropertiesService.getScriptProperties().getProperty('CLOSED_WEEKDAYS');
  if (raw === null || raw === undefined) return ['木']; // 未設定時の既定値
  return String(raw)
    .replace(/[　\s]/g, '')
    .split(',')
    .map((s) => s.replace(/曜日?$/, ''))
    .filter((s) => ['日', '月', '火', '水', '木', '金', '土'].indexOf(s) >= 0);
}

/** Dateオブジェクトでも文字列でも 'yyyy-MM-dd' 形式の文字列に揃える */
function normalizeDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return String(v);
}

/** start〜end の範囲を1日ずつ列挙する（例: [{date:'2026-09-01', weekday:'火'}, ...]） */
function enumerateDates_(startStr, endStr) {
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const closed = getClosedWeekdays_();
  const start = new Date(startStr);
  const end = new Date(endStr);
  const result = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const wd = weekdays[d.getDay()];
    result.push({
      date: Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd'),
      weekday: wd,
      closed: closed.indexOf(wd) >= 0, // 定休日は入力不可
    });
  }
  return result;
}

/** 指定ユーザー・指定期間の既存提出を { 'yyyy-MM-dd': {availability, timePref} } の形で返す */
function getExistingSubmission_(userId, periodLabel) {
  const sheet = getShiftSheet_();
  const values = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row[1] === userId && row[4] === periodLabel) {
      map[normalizeDate_(row[5])] = {
        availability: row[6],
        timePref: row[7],
      };
    }
  }
  return map;
}

/** 指定ユーザー・指定期間の最終提出日時を返す（未提出なら空文字） */
function getSubmittedAt_(userId, periodLabel) {
  const sheet = getShiftSheet_();
  const values = sheet.getDataRange().getValues();
  let latest = null;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row[1] === userId && row[4] === periodLabel && row[0]) {
      const t = new Date(row[0]);
      if (!latest || t > latest) latest = t;
    }
  }
  return latest ? Utilities.formatDate(latest, 'Asia/Tokyo', 'yyyy年M月d日 HH:mm') : '';
}

/** 指定ユーザー・指定期間の既存提出行をすべて削除する（再提出時の上書き用） */
function removeExistingSubmission_(sheet, userId, periodLabel) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return;
  const header = values[0];
  const kept = values.slice(1).filter((row) => !(row[1] === userId && row[4] === periodLabel));

  sheet.getRange(2, 1, values.length - 1, header.length).clearContent();
  if (kept.length) {
    sheet.getRange(2, 1, kept.length, header.length).setValues(kept);
  }
}

/**
 * 【クライアントから呼び出し】シフト希望フォームの初期表示用データを返す。
 * 承認済み・在籍中でない場合はフォームを見せず、理由だけ返す。
 */
function getShiftForm(idToken) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: true, allowed: false, reason: access.reason };
  }

  const win = getShiftWindow_();
  const period = {
    label: win.label, start: win.start, end: win.end,
    deadline: win.deadline, overdue: !!win.overdue,
  };

  return {
    ok: true,
    allowed: true,
    name: access.name,
    store: access.store,
    period: period,
    availabilityOptions: SHIFT_AVAILABILITY_OPTIONS,
    dates: enumerateDates_(period.start, period.end),
    existing: getExistingSubmission_(payload.sub, period.label),
    submittedAt: getSubmittedAt_(payload.sub, period.label), // 提出済みなら最終提出日時
  };
}

/**
 * 【クライアントから呼び出し】シフト希望を提出する。
 * 同じ人・同じ期間の既存提出があれば削除してから新しい内容を書き込む
 * （締切前であれば何度でも提出し直せる）。
 * entries: [{ date, availability, timePref }, ...]
 */
function submitShift(idToken, periodLabel, entries) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: false, error: access.reason };
  }
  if (!periodLabel || !entries || !entries.length) {
    return { ok: false, error: 'missing_fields' };
  }

  const win = getShiftWindow_();
  if (win.label !== periodLabel) {
    // 画面を開いたまま日付が変わり、対象期間がずれた場合
    return { ok: false, error: 'period_changed', currentLabel: win.label };
  }

  // 全ての日付が入力されているかを確認する（定休日を除き、1日でも未入力なら受け付けない）
  const requiredDates = enumerateDates_(win.start, win.end)
    .filter((d) => !d.closed)
    .map((d) => d.date);
  const filledDates = {};
  entries.forEach((e) => {
    if (e && e.date && String(e.availability || '').trim()) filledDates[e.date] = true;
  });
  const missingDates = requiredDates.filter((d) => !filledDates[d]);
  if (missingDates.length > 0) {
    return { ok: false, error: 'incomplete', missingDates: missingDates };
  }

  const sheet = getShiftSheet_();
  removeExistingSubmission_(sheet, payload.sub, periodLabel);

  const now = new Date();
  const rows = entries.map((e) => [
    now, payload.sub, access.name, access.store, periodLabel,
    e.date, e.availability || '', e.timePref || '',
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

  // 提出内容の控えを返す（スタッフが自分の画面で確認できるようにするため）
  return {
    ok: true,
    submittedAt: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy年M月d日 HH:mm'),
    periodLabel: periodLabel,
    entries: entries.map((e) => ({
      date: e.date, availability: e.availability || '', timePref: e.timePref || '',
    })),
  };
}

/* ============================================================
 * 共通：日時の表示整形／本部判定
 * ============================================================ */

/** 従業員名簿の「所属店舗」がこの値のスタッフを本部（全店舗閲覧できる立場）として扱う */
const HQ_STORE_NAME = '本部';

function isHq_(store) {
  return store === HQ_STORE_NAME;
}

function normalizeDateTime_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  }
  return String(v);
}

/* ============================================================
 * 引き継ぎ掲示板（店舗ごと。従業員名簿I列「閲覧可能店舗」が空欄なら
 * 承認済み・在籍中のスタッフは誰でも全店舗を閲覧・投稿できる。
 * 制限したい場合はI列に店舗名をカンマ区切りで設定する）
 * ============================================================ */

const BOARD_SHEET_NAME = '引き継ぎ掲示板';
const BOARD_COMMENT_SHEET_NAME = '掲示板コメント';
/** 引き継ぎ掲示板の投稿・閲覧に使う店舗一覧（本部を除く）。複数店舗で勤務するスタッフがいるため、
 *  承認済み・在籍中であれば誰でもどの店舗の掲示板も閲覧・投稿できる（全体／店舗別で絞り込み可能）。 */
const BOARD_STORES = ['下高井戸店', '千歳烏山店', '仙川店'];
/** 投稿時に選べる「全店舗向け」の特別な投稿先。この投稿先で投稿すると、
 *  店舗の絞り込み（全体／各店舗）のどれを選んでいても一覧に表示される。 */
const BOARD_ALL_STORES_LABEL = '全店舗対象';

function getBoardSheet_() {
  const spreadsheetId = getProp_('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('SPREADSHEET_ID が未設定です。');
  }
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(BOARD_SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + BOARD_SHEET_NAME + '」が見つかりません。Setup.gs の initializeBoardSheet() を先に実行してください。');
  }
  return sheet;
}

function getBoardCommentSheet_() {
  const spreadsheetId = getProp_('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('SPREADSHEET_ID が未設定です。');
  }
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(BOARD_COMMENT_SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + BOARD_COMMENT_SHEET_NAME + '」が見つかりません。Setup.gs の initializeBoardCommentSheet() を先に実行してください。');
  }
  return sheet;
}

/**
 * 【クライアントから呼び出し】引き継ぎ掲示板の投稿一覧を取得する。
 * 複数店舗で勤務するスタッフがいるため、承認済み・在籍中であれば誰でも全店舗の投稿を閲覧できる。
 * storeFilter … '全体' または未指定なら全件、店舗名を指定するとその店舗の投稿のみ。
 * 各投稿には、紐づくコメント一覧も comments として含める。
 */
function getBoardPosts(idToken, storeFilter, includeResolved) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: true, allowed: false, reason: access.reason };
  }

  const permittedStores = access.viewableStores || BOARD_STORES; // 閲覧可能店舗（未設定なら制限なし＝全店舗）
  const restricted = !!access.viewableStores;
  const filter = (storeFilter && storeFilter !== '全体') ? storeFilter : '';
  const showResolved = includeResolved === true || includeResolved === 'true';
  const isHq = isHq_(access.store);

  const sheet = getBoardSheet_();
  const values = sheet.getDataRange().getValues();
  const posts = [];
  const postIndexById = {};
  let resolvedHidden = 0;
  for (let i = values.length - 1; i >= 1; i--) { // 新しい投稿が先頭に来るよう逆順に読む
    const row = values[i];
    const postId = row[0];
    const store = row[4];
    const status = row[7] === '解決済み' ? '解決済み' : '未解決';
    // 閲覧可能店舗が設定されているスタッフには、対象外店舗の投稿は見せない（全店舗対象は除く）
    if (store !== BOARD_ALL_STORES_LABEL && permittedStores.indexOf(store) === -1) continue;
    // 画面上の絞り込み。「全店舗対象」の投稿は、どの店舗で絞り込んでいても表示する
    if (filter && store !== filter && store !== BOARD_ALL_STORES_LABEL) continue;
    // 解決済みは初期表示では隠す（件数だけ画面に伝える）
    if (status === '解決済み' && !showResolved) { resolvedHidden++; continue; }
    const post = {
      postId: postId,
      postedAt: normalizeDateTime_(row[1]),
      name: row[3],
      store: store,
      body: row[5],
      imageUrl: row[6] || '',
      status: status,
      // 自分の投稿、または本部のスタッフだけが削除・状態変更できる
      canManage: row[2] === payload.sub || isHq,
      comments: [],
    };
    posts.push(post);
    postIndexById[postId] = post;
  }

  // 掲示板コメントシートの列：
  // 0:投稿ID 1:元投稿の店舗 2:元投稿者 3:元投稿の内容 4:コメント日時 5:LINEユーザーID 6:氏名 7:所属店舗 8:本文
  const commentSheet = getBoardCommentSheet_();
  const commentValues = commentSheet.getDataRange().getValues();
  for (let i = 1; i < commentValues.length; i++) {
    const row = commentValues[i];
    const post = postIndexById[row[0]];
    if (post) {
      post.comments.push({
        commentedAt: normalizeDateTime_(row[4]),
        name: row[6],
        body: row[8],
      });
    }
  }

  return {
    ok: true,
    allowed: true,
    stores: permittedStores, // 絞り込み用（全体／閲覧可能な店舗のみ）
    postTargets: [BOARD_ALL_STORES_LABEL].concat(permittedStores), // 投稿先の選択肢（全店舗対象を先頭に）
    allStores: BOARD_STORES, // 全店舗一覧（追加申請の選択肢を作るのに使う）
    restricted: restricted, // 閲覧可能店舗が制限されているか
    filter: filter || '全体',
    includeResolved: showResolved,
    resolvedHidden: resolvedHidden, // 非表示にした解決済み投稿の件数
    posts: posts,
  };
}

/**
 * 掲示板に添付された写真を保存するGoogleドライブのフォルダを返す。
 * スクリプトプロパティ BOARD_IMAGE_FOLDER_ID があればそれを使い、
 * なければ「引き継ぎ掲示板_画像」フォルダを作成してIDを記録する。
 */
function getBoardImageFolder_() {
  const prop = PropertiesService.getScriptProperties();
  const id = prop.getProperty('BOARD_IMAGE_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 消えていた場合は作り直す */ }
  }
  const folder = DriveApp.createFolder('引き継ぎ掲示板_画像');
  prop.setProperty('BOARD_IMAGE_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * 画像をGoogleドライブに保存し、表示用のURLを返す。
 * image … { data: 'data:image/jpeg;base64,...', mimeType: 'image/jpeg' }
 * 画像はリンクを知っていれば閲覧できる設定にする（<img>で表示するため）。
 */
function saveBoardImage_(image, postId) {
  if (!image || !image.data) return '';
  const base64 = String(image.data).replace(/^data:[^;]+;base64,/, '');
  const mimeType = image.mimeType || 'image/jpeg';
  const ext = mimeType.indexOf('png') >= 0 ? 'png' : 'jpg';
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mimeType, postId + '.' + ext);
  const file = getBoardImageFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1200';
}

/**
 * 【クライアントから呼び出し】投稿を削除する。
 * 削除できるのは投稿した本人か、本部のスタッフのみ。
 * 紐づくコメントもあわせて削除する。
 */
function deleteBoardPost(idToken, postId) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: false, error: access.reason };
  }
  if (!postId) {
    return { ok: false, error: 'missing_post_id' };
  }

  const sheet = getBoardSheet_();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) !== String(postId)) continue;
    if (values[i][2] !== payload.sub && !isHq_(access.store)) {
      return { ok: false, error: 'not_allowed' };
    }
    sheet.deleteRow(i + 1);
    deleteBoardCommentsOfPost_(postId);
    return { ok: true };
  }
  return { ok: false, error: 'post_not_found' };
}

/** 指定した投稿に紐づくコメント行をすべて削除する */
function deleteBoardCommentsOfPost_(postId) {
  const sheet = getBoardCommentSheet_();
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === String(postId)) {
      sheet.deleteRow(i + 1);
    }
  }
}

/**
 * 【クライアントから呼び出し】投稿の状態を「解決済み」「未解決」に切り替える。
 * 変更できるのは投稿した本人か、本部のスタッフのみ。
 */
function setBoardPostStatus(idToken, postId, status) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: false, error: access.reason };
  }
  const newStatus = status === '解決済み' ? '解決済み' : '未解決';

  const sheet = getBoardSheet_();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) !== String(postId)) continue;
    if (values[i][2] !== payload.sub && !isHq_(access.store)) {
      return { ok: false, error: 'not_allowed' };
    }
    sheet.getRange(i + 1, 8).setValue(newStatus);
    sheet.getRange(i + 1, 9).setValue(newStatus === '解決済み' ? new Date() : '');
    return { ok: true, status: newStatus };
  }
  return { ok: false, error: 'post_not_found' };
}

/**
 * 【クライアントから呼び出し】引き継ぎ掲示板へ投稿する。
 * 複数店舗で勤務するスタッフがいるため、誰でも投稿先の店舗（BOARD_STORESのいずれか）を選んで投稿できる。
 * 「全店舗対象」を選ぶと、全社共通のお知らせとしてどの店舗の一覧にも表示される。
 */
function postBoard(idToken, store, body, image, notify, toManual) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: false, error: access.reason };
  }
  const targetStore = String(store || '').trim();
  const permittedStores = access.viewableStores || BOARD_STORES;
  const validTargets = permittedStores.concat([BOARD_ALL_STORES_LABEL]);
  if (validTargets.indexOf(targetStore) === -1) {
    return { ok: false, error: 'invalid_store' };
  }
  if (!body || !body.trim()) {
    return { ok: false, error: 'missing_body' };
  }

  const postId = Utilities.getUuid();
  let imageUrl = '';
  if (image && image.data) {
    try {
      imageUrl = saveBoardImage_(image, postId);
    } catch (err) {
      // 画像の保存に失敗しても、本文の投稿自体は成立させる
      Logger.log('画像保存に失敗: %s', String(err));
    }
  }

  const sheet = getBoardSheet_();
  sheet.appendRow([
    postId, new Date(), payload.sub, access.name, targetStore, body.trim(),
    imageUrl, '未解決', '',
  ]);

  // 「通知する」にチェックが入っていたときだけ、対象店舗のスタッフへLINEで通知する。
  // LINE公式アカウントは「配信回数×人数」で通数を消費するため、既定では送らない。
  let notified = null;
  if (notify === true || notify === 'true') {
    try {
      notified = notifyBoardPost_(targetStore, payload.sub, access.name, body.trim());
    } catch (err) {
      Logger.log('通知の送信に失敗: %s', String(err));
      notified = { sent: 0, error: String(err) };
    }
  }

  // 「マニュアルに追加する」にチェックが入っていたら、Notionのデータベースにも登録する
  let manual = null;
  if (toManual === true || toManual === 'true') {
    try {
      manual = sendToNotion_({
        body: body.trim(),
        store: targetStore,
        name: access.name,
        imageUrl: imageUrl,
        postedAt: new Date(),
      });
    } catch (err) {
      Logger.log('Notionへの登録に失敗: %s', String(err));
      manual = { ok: false, error: String(err) };
    }
  }

  return { ok: true, imageSaved: !!imageUrl, notified: notified, manual: manual };
}

/* ============================================================
 * Notion連携（マニュアル素材の蓄積）
 * ------------------------------------------------------------
 * 掲示板の投稿のうち「マニュアルに追加する」を選んだものを、
 * Notionの「マニュアル素材（掲示板から収集）」データベースに1件追加する。
 *
 * 必要な設定（スクリプトプロパティ）：
 *   NOTION_TOKEN       … Notionインテグレーションのシークレット（ntn_ で始まる文字列）
 *   NOTION_DATABASE_ID … 送り先データベースのID
 * ※Notion側で、そのデータベースにインテグレーションを接続しておく必要があります。
 * ============================================================ */

/** Notionのプロパティ名。Notion側で列名を変えたらここも合わせる。 */
const NOTION_PROPS = {
  title: 'タイトル',
  body: '内容',
  store: '対象店舗',
  name: '投稿者',
  postedAt: '投稿日',
  image: '写真',
  status: 'ステータス',
};

function sendToNotion_(post) {
  const token = getProp_('NOTION_TOKEN');
  const databaseId = getProp_('NOTION_DATABASE_ID');
  if (!token || !databaseId) {
    return { ok: false, error: 'NOTION_TOKEN または NOTION_DATABASE_ID が未設定です。' };
  }

  // タイトルは本文の先頭40文字（改行は空白に置き換える）
  const flat = post.body.replace(/\s+/g, ' ').trim();
  const title = flat.length > 40 ? flat.slice(0, 40) + '…' : flat;

  const properties = {};
  properties[NOTION_PROPS.title] = { title: [{ text: { content: title } }] };
  properties[NOTION_PROPS.body] = { rich_text: [{ text: { content: post.body.slice(0, 1900) } }] };
  properties[NOTION_PROPS.store] = { select: { name: post.store } };
  properties[NOTION_PROPS.name] = { rich_text: [{ text: { content: String(post.name || '') } }] };
  properties[NOTION_PROPS.postedAt] = {
    date: { start: Utilities.formatDate(post.postedAt, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX") },
  };
  properties[NOTION_PROPS.status] = { select: { name: '未整理' } };
  if (post.imageUrl) {
    properties[NOTION_PROPS.image] = { url: post.imageUrl };
  }

  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': '2022-06-28',
    },
    payload: JSON.stringify({
      parent: { database_id: databaseId },
      properties: properties,
    }),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    Logger.log('Notion APIエラー(%s): %s', res.getResponseCode(), res.getContentText());
    return { ok: false, error: res.getContentText() };
  }
  return { ok: true };
}

/**
 * Notion連携の設定確認用。Apps Scriptエディタから手動で実行すると、
 * テスト用の1件をNotionに登録して結果をログに出す。
 */
function testNotionConnection() {
  const result = sendToNotion_({
    body: 'これはNotion連携の動作確認用のテストです。確認後は削除してください。',
    store: '全店舗対象',
    name: 'テスト',
    imageUrl: '',
    postedAt: new Date(),
  });
  Logger.log(result.ok ? 'Notion連携に成功しました。' : 'Notion連携に失敗: ' + result.error);
  return result;
}

/**
 * 引き継ぎ掲示板の新着を、対象店舗のスタッフへLINEで通知する。
 *
 * 宛先は従業員名簿から「承認済み・在籍中」かつ対象店舗に所属するスタッフ。
 * 投稿先が「全店舗対象」の場合は全員。投稿者本人には送らない。
 *
 * 必要な設定（スクリプトプロパティ）：
 *   LINE_MESSAGING_CHANNEL_ACCESS_TOKEN … Messaging APIのチャネルアクセストークン
 *   PORTAL_BASE_URL（任意）             … 通知に載せるポータルのURL
 * ※LINEログインチャネルとMessaging APIチャネルが同じプロバイダーにないと、
 *   ユーザーIDが一致せず送信できません。
 */
function notifyBoardPost_(targetStore, posterUserId, posterName, body) {
  const token = getProp_('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    return { sent: 0, error: 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN が未設定です。' };
  }

  const toAll = targetStore === BOARD_ALL_STORES_LABEL;
  const values = getSheet_().getDataRange().getValues();
  const userIds = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const userId = row[0];
    const store = row[2];
    const approval = row[3];
    const active = row[4];
    if (!userId || userId === posterUserId) continue;       // 投稿者本人には送らない
    if (approval !== '承認済み' || active !== '在籍') continue;
    if (!toAll && store !== targetStore) continue;
    userIds.push(userId);
  }
  if (!userIds.length) return { sent: 0 };

  const baseUrl = getProp_('PORTAL_BASE_URL') || 'https://hachi-takeoff.github.io/employee-portal/';
  const excerpt = body.length > 80 ? body.slice(0, 80) + '…' : body;
  const text = '【引き継ぎ掲示板】新しい投稿があります\n'
    + '対象店舗：' + targetStore + '\n'
    + '投稿者：' + posterName + '\n\n'
    + excerpt + '\n\n'
    + '▼内容を確認する\n'
    + baseUrl + '?page=board';

  // multicastは1回につき500人まで。人数が増えても動くよう分割して送る。
  let sent = 0;
  for (let i = 0; i < userIds.length; i += 500) {
    const chunk = userIds.slice(i, i + 500);
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/multicast', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: chunk, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 200) {
      sent += chunk.length;
    } else {
      Logger.log('通知APIエラー(%s): %s', res.getResponseCode(), res.getContentText());
      return { sent: sent, error: res.getContentText() };
    }
  }
  return { sent: sent };
}

/**
 * 【クライアントから呼び出し】引き継ぎ掲示板の投稿にコメントする。
 * 承認済み・在籍中であれば誰でもコメントできる。
 */
function postBoardComment(idToken, postId, body) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: false, error: access.reason };
  }
  if (!postId) {
    return { ok: false, error: 'missing_post_id' };
  }
  if (!body || !body.trim()) {
    return { ok: false, error: 'missing_body' };
  }

  // スプレッドシート上で「どの投稿へのコメントか」が分かるよう、元の投稿の情報も一緒に記録する
  const original = findBoardPostById_(postId);

  const sheet = getBoardCommentSheet_();
  sheet.appendRow([
    postId,
    original ? original.store : '（投稿が見つかりません）',
    original ? original.name : '',
    original ? original.body : '',
    new Date(), payload.sub, access.name, access.store, body.trim(),
  ]);
  return { ok: true };
}

/** 投稿IDから引き継ぎ掲示板の元投稿を探す。見つからなければ null。 */
function findBoardPostById_(postId) {
  const values = getBoardSheet_().getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(postId)) {
      return {
        postedAt: values[i][1],
        userId: values[i][2],
        name: values[i][3],
        store: values[i][4],
        body: values[i][5],
      };
    }
  }
  return null;
}

/* ============================================================
 * 店舗追加申請（担当店舗が増えたスタッフが、掲示板の閲覧・投稿範囲の
 * 追加を本部に申請する。本部がシート上で「承認」に変更すると、
 * 従業員名簿の「閲覧可能店舗」に自動で反映される。Setup.gs の
 * handleStoreRequestEdit をインストール型トリガーに登録しておくこと）
 * ============================================================ */

const STORE_REQUEST_SHEET_NAME = '店舗追加申請';

function getStoreRequestSheet_() {
  const spreadsheetId = getProp_('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('SPREADSHEET_ID が未設定です。');
  }
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(STORE_REQUEST_SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + STORE_REQUEST_SHEET_NAME + '」が見つかりません。Setup.gs の initializeStoreRequestSheet() を先に実行してください。');
  }
  return sheet;
}

/**
 * 【クライアントから呼び出し】担当店舗が増えた場合に、その店舗の
 * 掲示板閲覧・投稿権限の追加を本部に申請する。
 */
function requestStoreAccess(idToken, requestedStore) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: false, error: access.reason };
  }
  const target = String(requestedStore || '').trim();
  if (BOARD_STORES.indexOf(target) === -1) {
    return { ok: false, error: 'invalid_store' };
  }
  const permitted = access.viewableStores || BOARD_STORES;
  if (permitted.indexOf(target) !== -1) {
    return { ok: false, error: 'already_permitted' };
  }

  const sheet = getStoreRequestSheet_();
  sheet.appendRow([new Date(), payload.sub, access.name, access.store, target, '未対応', '']);
  return { ok: true };
}

/* ============================================================
 * 本部への要望・質問（閲覧できるのは投稿者本人＋本部のみ）
 * ============================================================ */

const SUGGEST_SHEET_NAME = '要望・質問';

function getSuggestSheet_() {
  const spreadsheetId = getProp_('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('SPREADSHEET_ID が未設定です。');
  }
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(SUGGEST_SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SUGGEST_SHEET_NAME + '」が見つかりません。Setup.gs の initializeSuggestSheet() を先に実行してください。');
  }
  return sheet;
}

/**
 * 【クライアントから呼び出し】要望・質問の一覧を取得する。
 * 本部は全件（誰の投稿か分かる形で）、それ以外は自分が投稿したものだけを返す。
 */
function getSuggestions(idToken) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: true, allowed: false, reason: access.reason };
  }

  const sheet = getSuggestSheet_();
  const values = sheet.getDataRange().getValues();
  const items = [];
  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    const userId = row[1];
    if (isHq_(access.store) || userId === payload.sub) {
      items.push({
        postedAt: normalizeDateTime_(row[0]),
        name: row[2],
        store: row[3],
        body: row[4],
        status: row[5] || '未対応',
        answer: row[6] || '',
        answeredAt: row[7] ? normalizeDateTime_(row[7]) : '',
        category: row[8] || '一般要望', // I列：一般要望 or 不具合報告
      });
    }
  }
  return { ok: true, allowed: true, isHq: isHq_(access.store), items: items };
}

/** 要望・質問の種別として許可する値 */
const SUGGEST_CATEGORIES = ['一般要望', '不具合報告'];

/**
 * 【クライアントから呼び出し】本部への要望・質問を投稿する。
 * category … '一般要望' または '不具合報告'（未指定・不正な値は '一般要望' 扱い）。
 */
function postSuggestion(idToken, body, category) {
  const payload = verifyIdToken_(idToken);
  const access = checkAccess_(payload.sub);
  if (!access.allowed) {
    return { ok: false, error: access.reason };
  }
  if (!body || !body.trim()) {
    return { ok: false, error: 'missing_body' };
  }
  const cat = SUGGEST_CATEGORIES.indexOf(category) !== -1 ? category : SUGGEST_CATEGORIES[0];

  const sheet = getSuggestSheet_();
  sheet.appendRow([new Date(), payload.sub, access.name, access.store, body.trim(), '未対応', '', '', cat]);
  return { ok: true };
}
