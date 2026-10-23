/* 케이지워치 v1 — 소형 반려동물 활동량 모니터
 *
 * 동작 원리
 *   카메라 프레임을 128x96 흑백으로 줄여 직전 프레임과 픽셀 단위로 비교한다.
 *   전역 밝기 변화(자동노출 드리프트, 조명)를 먼저 상쇄한 뒤 변한 픽셀 수를 센다.
 *   이 값이 보정으로 측정한 노이즈 수준을 넘으면 "움직임"으로 판정하고,
 *   1분 단위로 집계해 IndexedDB에 쌓는다.
 *
 * v1 분석은 "무활동 지속" 하나만 본다. 다만 저장은 풀 스펙이라
 * 시간대별 기준선·패턴 변화 탐지는 나중에 과거 데이터 그대로 쓸 수 있다.
 */
'use strict';

/* 화면 상단에 그대로 표시된다. 폰이 구버전을 캐시했는지 눈으로 바로 확인하려는 것.
   코드를 고쳐 배포할 때마다 올리고, index.html 의 app.js?v= 도 같이 맞춘다. */
const VERSION = '1.6';

/* ───────────────────────── 설정 ───────────────────────── */

const DIFF_W = 128, DIFF_H = 96;          // 차분 해상도
const CALIB_MS = 60000;                   // 보정 구간 60초
const SNAP_W = 640, SNAP_H = 480;         // 스냅샷 해상도(차후 알림 첨부용)

const DEFAULTS = {
  inactiveMin: 180,       // 무활동 알람 기준(분)
  gate: true,             // 감시 시간대 제한
  from: '20:00',
  to: '08:00',
  sound: true,
  notif: true,
  sampleMs: 250,
  // 18로 두면 어두운 실내의 센서 노이즈가 그대로 통과한다.
  // 실측: 노트북 웹캠 저녁 실내광에서 18 -> 노이즈 634, 30 -> 노이즈 47.
  pixelThreshold: 30,
  activeMul: 4,           // 노이즈 대비 배수
  minuteActivePct: 2,     // 이 비율 이상 움직인 분만 "활동한 분"으로 인정
  darkLum: 12,            // 평균 밝기가 이 아래면 '아무것도 안 보임'으로 본다 (0~255)
  camera: 'environment',  // 'user' 로 두면 화면과 같은 방향(전면)을 본다
  redChannel: false,      // 적색 조명 아래에서는 빨강 채널만 쓴다
  nightPct: 40,           // 야간 조명 패널의 적색 세기 (%)
  keepDays: 30,
  region: null,           // {x,y,w,h} 0~1 정규화
};

let cfg = { ...DEFAULTS };

/* ───────────────────────── IndexedDB ───────────────────────── */

const DB_NAME = 'cagewatch', DB_VER = 1;
let _db = null;

function dbOpen() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('minutes')) db.createObjectStore('minutes', { keyPath: 't' });
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('config')) db.createObjectStore('config');
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function store(name, mode = 'readonly') {
  const db = await dbOpen();
  return db.transaction(name, mode).objectStore(name);
}

const putMinute = async (rec) => req((await store('minutes', 'readwrite')).put(rec));
const getMinutes = async (t0, t1) =>
  req((await store('minutes')).getAll(IDBKeyRange.bound(t0, t1)));
const allMinutes = async () => req((await store('minutes')).getAll());
const saveCfg = async () => req((await store('config', 'readwrite')).put(cfg, 'cfg'));
const loadCfg = async () => req((await store('config')).get('cfg'));

async function addEvent(level, msg) {
  const ev = { ts: Date.now(), level, msg };
  await req((await store('events', 'readwrite')).add(ev));
  renderLog();
  return ev;
}
async function recentEvents(n = 60) {
  const s = await store('events');
  return new Promise((res) => {
    const out = [];
    const c = s.openCursor(null, 'prev');
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur || out.length >= n) return res(out);
      out.push(cur.value); cur.continue();
    };
    c.onerror = () => res(out);
  });
}
async function pruneOld() {
  const cut = Math.floor(Date.now() / 60000) - cfg.keepDays * 1440;
  const s = await store('minutes', 'readwrite');
  return new Promise((res) => {
    const c = s.openCursor(IDBKeyRange.upperBound(cut));
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return res();
      cur.delete(); cur.continue();
    };
    c.onerror = () => res();
  });
}
async function wipeAll() {
  for (const n of ['minutes', 'events']) await req((await store(n, 'readwrite')).clear());
}

/* ───────────────────────── 움직임 감지 ───────────────────────── */

const diffCanvas = document.createElement('canvas');
diffCanvas.width = DIFF_W; diffCanvas.height = DIFF_H;
const diffCtx = diffCanvas.getContext('2d', { willReadFrequently: true });

const snapCanvas = document.createElement('canvas');
snapCanvas.width = SNAP_W; snapCanvas.height = SNAP_H;

let prevGray = null;
let mask = null, maskCount = DIFF_W * DIFF_H;

function buildMask() {
  if (!cfg.region) { mask = null; maskCount = DIFF_W * DIFF_H; return; }
  const { x, y, w, h } = cfg.region;
  const x0 = Math.max(0, Math.round(x * DIFF_W)), y0 = Math.max(0, Math.round(y * DIFF_H));
  const x1 = Math.min(DIFF_W, Math.round((x + w) * DIFF_W)), y1 = Math.min(DIFF_H, Math.round((y + h) * DIFF_H));
  mask = new Uint8Array(DIFF_W * DIFF_H);
  let n = 0;
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { mask[yy * DIFF_W + xx] = 1; n++; }
  maskCount = n || 1;
  prevGray = null;   // 영역이 바뀌면 기준 프레임을 버린다
}

/** 한 프레임 비교. { score, ratio, valid } */
function sampleFrame(video) {
  diffCtx.drawImage(video, 0, 0, DIFF_W, DIFF_H);
  const d = diffCtx.getImageData(0, 0, DIFF_W, DIFF_H).data;
  const n = DIFF_W * DIFF_H;
  const gray = new Uint8Array(n);
  if (cfg.redChannel) {
    // 적색 조명 아래에서는 화면이 거의 빨강 단색이라 휘도 공식(빨강 가중치 30%)이
    // 신호의 대부분을 버린다. 빨강 채널을 그대로 쓰는 쪽이 훨씬 밝고 또렷하다.
    for (let i = 0, p = 0; i < n; i++, p += 4) gray[i] = d[p];
  } else {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      gray[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
  }
  if (!prevGray) { prevGray = gray; return { score: 0, ratio: 0, valid: false, warmup: true, lum: 0 }; }

  // 1단계: 전역 밝기 이동량을 구해 상쇄한다.
  //   자동노출이 흔들리거나 방 조명이 바뀌면 화면 전체가 같은 방향으로 변하는데,
  //   이걸 빼지 않으면 조명 변화가 전부 "움직임"으로 잡힌다.
  let sum = 0, cnt = 0, lumSum = 0;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    sum += gray[i] - prevGray[i]; cnt++;
    lumSum += gray[i];
  }
  const shift = cnt ? sum / cnt : 0;
  const lum = cnt ? lumSum / cnt : 0;

  // 2단계: 상쇄 후에도 임계값을 넘는 픽셀만 센다.
  let changed = 0;
  const thr = cfg.pixelThreshold;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    if (Math.abs((gray[i] - prevGray[i]) - shift) > thr) changed++;
  }
  prevGray = gray;

  const ratio = changed / (cnt || 1);
  // 영역 절반 이상이 한꺼번에 변했으면 손이 들어왔거나 조명이 바뀐 것으로 보고 버린다.
  return { score: changed, ratio, valid: ratio <= 0.5, lum };
}

/* ───────────────────────── 상태 ───────────────────────── */

const S = {
  running: false,
  calibrating: false,
  calibUntil: 0,
  calibScores: [],
  activeThreshold: 8,
  noiseFloor: 0,
  score: null,           // 최근 프레임 움직임 점수
  night: false,          // 야간 조명 패널 표시 여부
  preNight: null,        // 야간 조명 켜기 전 카메라/채널 설정
  lum: null,             // 최근 프레임 평균 밝기 (0~255)
  darkSince: null,       // 어두워지기 시작한 시각
  darkWarned: false,
  lastActiveAt: 0,       // 프레임 단위. 화면 표시용
  lastActiveMinute: null, // 분 단위. 무활동 알람은 이쪽만 본다
  bucket: null,          // { t, frames, active, invalid, sum, max }
  timer: null,
  stream: null,
  wakeLock: null,
  lastFrameAt: 0,
  alarmOn: false,
  alarmedForMinute: -1,
  regionMode: false,
};

const newBucket = (t) => ({ t, frames: 0, active: 0, invalid: 0, sum: 0, max: 0 });

/* ───────────────────────── DOM ───────────────────────── */

const $ = (id) => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');

/* ───────────────────────── 알람 ───────────────────────── */

let audioCtx = null, beepTimer = null;

function unlockAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function beep() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [0, 0.28, 0.56].forEach((off) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0, t0 + off);
    g.gain.linearRampToValueAtTime(0.28, t0 + off + 0.02);
    g.gain.setValueAtTime(0.28, t0 + off + 0.16);
    g.gain.linearRampToValueAtTime(0, t0 + off + 0.2);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t0 + off); o.stop(t0 + off + 0.22);
  });
}

async function fireAlarm(msg) {
  if (S.alarmOn) return;
  S.alarmOn = true;
  $('alarmText').textContent = msg;
  $('alarmBanner').classList.add('on');
  await addEvent('alarm', msg);

  if (cfg.sound) {
    unlockAudio();
    beep();
    beepTimer = setInterval(beep, 2500);
  }
  if (cfg.notif && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('케이지워치 경보', { body: msg, tag: 'cagewatch', renotify: true });
    } catch (_) { /* 일부 안드로이드는 서비스워커 경유만 허용 */ }
  }
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
}

function clearAlarm() {
  S.alarmOn = false;
  $('alarmBanner').classList.remove('on');
  if (beepTimer) { clearInterval(beepTimer); beepTimer = null; }
}

/* ───────────────────────── 감시 시간대 ───────────────────────── */

const hm2min = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

/** 감시 시간대 안인지. 20:00~08:00 처럼 자정을 넘기는 구간도 처리한다. */
function inWatchWindow(d = new Date()) {
  if (!cfg.gate) return true;
  const now = d.getHours() * 60 + d.getMinutes();
  const a = hm2min(cfg.from), b = hm2min(cfg.to);
  return a <= b ? (now >= a && now < b) : (now >= a || now < b);
}

/* ───────────────────────── 메인 루프 ───────────────────────── */

function tick() {
  if (!S.running || video.readyState < 2) return;

  const r = sampleFrame(video);
  S.lastFrameAt = Date.now();
  if (r.warmup) return;
  S.lum = r.lum;

  // 보정 구간: 임계값을 정하기 위한 표본만 모은다.
  if (S.calibrating) {
    if (r.valid) S.calibScores.push(r.score);
    if (Date.now() >= S.calibUntil) finishCalibration();
    updateLiveUI(r);
    return;
  }

  const m = Math.floor(Date.now() / 60000);
  if (!S.bucket) S.bucket = newBucket(m);
  if (m !== S.bucket.t) {
    const done = S.bucket;
    S.bucket = newBucket(m);
    flushBucket(done);
    onMinute(done);
  }

  const b = S.bucket;
  if (!r.valid) { b.invalid++; }
  else {
    b.frames++;
    b.sum += r.score;
    if (r.score > b.max) b.max = r.score;
    if (r.score > S.activeThreshold) { b.active++; S.lastActiveAt = Date.now(); }
  }
  updateLiveUI(r);
}

async function flushBucket(b) {
  if (!b || (!b.frames && !b.invalid)) return;
  await putMinute(b);
}

/** 1분마다: 무활동 판정 + 차트/정리. done 은 방금 끝난 1분 집계. */
async function onMinute(done) {
  const min = Math.floor(Date.now() / 60000);

  // 방금 끝난 1분이 "활동한 분"인지 판정한다.
  //
  // 프레임 하나가 기준을 넘었다고 시계를 리셋하면 안 된다. 노이즈 바닥이
  // 판정 기준에 가까울 때 분당 한두 프레임은 우연히 넘는데, 그걸 활동으로
  // 치면 동물이 실제로 움직이지 않아도 무활동 시간이 영영 쌓이지 않아
  // 알람이 울리지 않는다. 오탐보다 나쁜 미탐이다.
  if (done && done.frames && done.active / done.frames >= cfg.minuteActivePct / 100) {
    S.lastActiveMinute = done.t;
  }
  if (S.lastActiveMinute == null) S.lastActiveMinute = min;

  const idleMin = min - S.lastActiveMinute;
  if (idleMin >= cfg.inactiveMin && inWatchWindow() && !S.alarmOn) {
    await fireAlarm(`${idleMin}분 동안 움직임이 없습니다.`);
  }
  // 다시 움직이면 자동으로 알람을 내리고 복구를 기록한다.
  if (S.alarmOn && idleMin === 0) {
    clearAlarm();
    await addEvent('info', '움직임이 다시 감지되어 알람을 해제했습니다.');
  }

  checkDarkness();

  if (min % 30 === 0) pruneOld();
  if ($('tab-stats').classList.contains('on')) renderCharts();
  updateLiveUI(null);
}


/* 화면이 너무 어두우면 감시가 조용히 무의미해진다.
   깜깜해서 안 보이는 것과 동물이 안 움직이는 것은 둘 다 "활동 0"으로 찍히므로
   구분이 안 된다. 어두우면 명시적으로 알려서 조명을 켜게 한다. */
function checkDarkness() {
  if (S.lum == null || S.calibrating) return;
  const dark = S.lum < cfg.darkLum;
  if (!dark) {
    if (S.darkWarned) {
      addEvent('info', `화면이 다시 밝아졌습니다 (밝기 ${Math.round(S.lum)}).`);
      $('liveNote').className = 'note';
      $('liveNote').textContent = '감시 중입니다.';
    }
    S.darkSince = null; S.darkWarned = false;
    return;
  }
  if (!S.darkSince) S.darkSince = Date.now();
  // 잠깐 어두워진 건 넘어가고, 2분 넘게 지속될 때만 경고한다.
  if (Date.now() - S.darkSince < 120000 || S.darkWarned) return;
  S.darkWarned = true;
  $('liveNote').className = 'note warn';
  $('liveNote').innerHTML = `<b>화면이 너무 어둡습니다 (밝기 ${Math.round(S.lum)}/255).</b> `
    + '카메라가 아무것도 보지 못하는 상태라 지금 기록되는 "활동 0"은 의미가 없습니다. '
    + '조명을 켠 뒤 <b>재보정</b>하세요.';
  addEvent('warn', `화면이 너무 어둡습니다 (밝기 ${Math.round(S.lum)}). 감지가 무의미한 상태입니다.`);
  if (cfg.notif && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('케이지워치', { body: '화면이 너무 어두워 감지할 수 없습니다.', tag: 'cw-dark' }); } catch (_) {}
  }
}

/* ───────────────────────── 보정 ───────────────────────── */

function startCalibration() {
  S.calibrating = true;
  S.calibScores = [];
  S.calibUntil = Date.now() + CALIB_MS;
  prevGray = null;
  setPill('cal', '보정 중');
  $('liveNote').className = 'note warn';
  $('liveNote').innerHTML = '<b>보정 중</b> — 60초간 카메라 노이즈 수준을 측정합니다. 이 동안은 케이지를 건드리지 마세요. 알람은 울리지 않습니다.';
}

function finishCalibration() {
  const v = S.calibScores.slice().sort((a, b) => a - b);
  const q = (p) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : 0);

  // 보정 중에 동물이 몇 번 움직여도 흔들리지 않도록 중앙값 + MAD 를 쓴다.
  const med = q(0.5);
  const dev = v.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  const mad = dev.length ? dev[dev.length >> 1] : 0;

  // 깨끗한 카메라에서는 프레임 절반 이상이 정확히 0이라 중앙값도 MAD도 0이 된다.
  // 그러면 위 공식이 분포의 꼬리를 전혀 못 본다 — 가끔 40씩 튀는 프레임이 있어도
  // 기준이 바닥값으로 내려앉아 그 40이 전부 움직임으로 잡힌다.
  // 상위 분위수를 같이 봐서 꼬리를 덮는다.
  const p95 = q(0.95);

  S.noiseFloor = med;
  S.noiseP95 = p95;
  S.activeThreshold = Math.max(
    6,
    Math.round(med + cfg.activeMul * (mad || 1)),
    Math.round(p95 * 1.5) + 1,
  );

  S.calibrating = false;
  S.lastActiveAt = Date.now();      // 보정 종료 시점을 기준점으로 삼는다
  S.lastActiveMinute = Math.floor(Date.now() / 60000);
  S.bucket = newBucket(Math.floor(Date.now() / 60000));
  setPill('run', '감시 중');
  $('liveNote').className = 'note';
  $('liveNote').innerHTML = `보정 완료 — 노이즈 중앙값 <b>${med}</b>, 상위5% <b>${p95}</b>, 판정 기준 <b>${S.activeThreshold}</b>픽셀. 오탐이 많으면 설정에서 판정 배수를 올리세요.`;
  addEvent('info', `보정 완료 (노이즈 ${med}, 상위5% ${p95}, 기준 ${S.activeThreshold})`);
}

/* ───────────────────────── 시작 / 정지 ───────────────────────── */

function camConstraints() {
  return { video: { facingMode: { ideal: cfg.camera }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false };
}

/* 야간 조명: 화면을 광원으로 쓴다. 화면은 어차피 켜져 있어야 하므로 추가 비용이 없다.
   OS 화면 밝기는 웹에서 못 바꾸므로, 폰 밝기를 최대로 올려둬야 효과가 난다. */
function applyNightColor() {
  const v = Math.round(255 * cfg.nightPct / 100);
  $('nightPanel').style.background = `rgb(${v},0,0)`;
  $('nightPctVal').textContent = cfg.nightPct;
  $('nightRange').value = cfg.nightPct;
}

/* 화면을 광원으로 쓰려면 화면과 같은 방향을 보는 전면 카메라여야 한다. 후면 카메라인 채로
   켜면 빛은 뒤를, 카메라는 앞을 향해 아무 소용이 없다. 적색광 아래에서는 빨강 채널만
   쓰는 쪽이 훨씬 또렷하다. 셋 다 물리적으로 묶여 있으므로 한 번에 같이 바꾼다. */
async function toggleNight(on) {
  S.night = on;
  $('nightPanel').classList.toggle('on', on);
  $('btnNight').classList.toggle('on', on);
  if (on) applyNightColor();

  const want = on
    ? { camera: 'user', redChannel: true }
    : (S.preNight || { camera: cfg.camera, redChannel: cfg.redChannel });

  if (on) S.preNight = { camera: cfg.camera, redChannel: cfg.redChannel };
  else S.preNight = null;

  const changed = cfg.camera !== want.camera || cfg.redChannel !== want.redChannel;
  cfg.camera = want.camera;
  cfg.redChannel = want.redChannel;
  cfgToForm();
  await saveCfg();

  if (!changed) return;
  // 조명 조건이 통째로 달라졌으므로 기존 보정값은 더 이상 유효하지 않다.
  await addEvent('info', on
    ? '야간 조명: 전면 카메라 + 적색 채널로 전환하고 재보정합니다.'
    : '야간 조명 해제: 원래 카메라 설정으로 되돌리고 재보정합니다.');
  if (S.running) {
    await onStreamLost();
    startCalibration();
  }
}

async function start() {
  unlockAudio();
  if (cfg.notif && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch (_) {}
  }
  try {
    S.stream = await navigator.mediaDevices.getUserMedia(camConstraints());
  } catch (e) {
    setPill('err', '카메라 실패');
    $('liveNote').className = 'note warn';
    $('liveNote').innerHTML = `<b>카메라를 열 수 없습니다.</b> ${e.name === 'NotAllowedError'
      ? '브라우저 카메라 권한을 허용해 주세요.'
      : 'HTTPS(또는 localhost)로 접속해야 카메라를 쓸 수 있습니다. README의 호스팅 안내를 보세요.'}`;
    addEvent('warn', `카메라 열기 실패: ${e.name}`);
    return;
  }

  video.srcObject = S.stream;
  await video.play().catch(() => {});
  S.stream.getVideoTracks()[0].addEventListener('ended', onStreamLost);

  fitOverlay();
  buildMask();
  S.running = true;
  S.lastFrameAt = Date.now();
  $('btnStart').disabled = true;
  $('btnStop').disabled = false;
  $('btnRecal').disabled = false;

  startCalibration();
  S.timer = setInterval(tick, cfg.sampleMs);
  requestWakeLock();
  addEvent('info', '감시를 시작했습니다.');
}

function stop() {
  S.running = false;
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  if (S.bucket) { flushBucket(S.bucket); S.bucket = null; }
  if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
  video.srcObject = null;
  prevGray = null;
  releaseWakeLock();
  clearAlarm();
  $('btnStart').disabled = false;
  $('btnStop').disabled = true;
  $('btnRecal').disabled = true;
  setPill('', '대기');
  addEvent('info', '감시를 정지했습니다.');
}

/** 카메라 트랙이 끊기면(탭 전환, OS 개입) 다시 붙인다. */
async function onStreamLost() {
  if (!S.running) return;
  addEvent('warn', '카메라 연결이 끊겨 재시작합니다.');
  setPill('err', '카메라 복구 중');
  try {
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.stream = await navigator.mediaDevices.getUserMedia(camConstraints());
    video.srcObject = S.stream;
    await video.play().catch(() => {});
    S.stream.getVideoTracks()[0].addEventListener('ended', onStreamLost);
    prevGray = null;
    setPill('run', '감시 중');
    addEvent('info', '카메라를 다시 연결했습니다.');
  } catch (e) {
    setPill('err', '카메라 끊김');
    fireAlarm('카메라 연결이 끊겼습니다. 앱을 다시 시작해 주세요.');
  }
}

/* 화면 꺼짐 방지 */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
  } catch (_) {}
}
function releaseWakeLock() { if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; } }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.running) {
    if (!S.wakeLock) requestWakeLock();
    // 백그라운드 동안 프레임이 멈췄을 수 있으니 기준 프레임을 버린다.
    prevGray = null;
    if (!S.stream || !S.stream.active) onStreamLost();
  }
});

/* 프레임이 60초 이상 멈추면(브라우저가 타이머를 죽인 경우) 알린다. */
setInterval(() => {
  if (!S.running || S.calibrating) return;
  if (Date.now() - S.lastFrameAt > 60000) {
    setPill('err', '멈춤');
    fireAlarm('감시가 멈췄습니다. 화면이 꺼졌거나 브라우저가 앱을 중단했습니다.');
  }
}, 20000);

/* ───────────────────────── 라이브 UI ───────────────────────── */

function setPill(cls, text) {
  const p = $('pill');
  p.className = 'pill' + (cls ? ' ' + cls : '');
  p.textContent = text;
}

function fmtAgo(ms) {
  if (!ms) return '–';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분 전`;
}

/** 마지막으로 "활동한 분" 이후 경과 시간 */
function fmtIdle(lastMin) {
  if (lastMin == null) return '–';
  const d = Math.floor(Date.now() / 60000) - lastMin;
  if (d <= 0) return '방금';
  if (d < 60) return `${d}분 전`;
  return `${Math.floor(d / 60)}시간 ${d % 60}분 전`;
}

function updateLiveUI(r) {
  if (r) {
    S.score = r.score;
    const pct = Math.min(100, Math.round((r.score / Math.max(1, S.activeThreshold * 4)) * 100));
    $('mNow').innerHTML = `${r.score}<small>px</small>`;
    $('mBar').style.width = pct + '%';
    $('mBar').style.background = r.score > S.activeThreshold ? 'var(--accent)' : '#3d444d';
  }
  const b = S.bucket;
  $('mMin').innerHTML = b && b.frames
    ? `${Math.round((b.active / b.frames) * 100)}<small>%</small>`
    : '–';
  // 알람을 결정하는 값(분 단위)을 그대로 보여준다. 프레임 단위 값을 보여주면
  // 화면은 "방금"인데 알람 시계는 따로 도는 상황이 생겨 혼란스럽다.
  $('mLast').textContent = S.calibrating ? '보정 중' : fmtIdle(S.lastActiveMinute);
  $('mThr').innerHTML = S.calibrating ? '–' : `${S.activeThreshold}<small>px</small>`;
  const lumEl = $('mLum');
  if (lumEl) {
    lumEl.innerHTML = S.lum == null ? '–' : `${Math.round(S.lum)}<small>/255</small>`;
    lumEl.style.color = (S.lum != null && S.lum < cfg.darkLum) ? 'var(--bad)' : '';
  }
  // 야간 조명이 켜져 있으면 UI가 전부 가려지므로, 붉은 화면 아래 띠에
  // 감지가 살아있는지 확인할 최소한의 지표를 그대로 띄운다.
  if (S.night) {
    const nv = $('nightLumVal');
    nv.textContent = S.lum == null ? '–' : Math.round(S.lum);
    nv.style.color = (S.lum != null && S.lum >= cfg.darkLum) ? '#4ade80' : '#f87171';

    const active = S.score != null && !S.calibrating && S.score > S.activeThreshold;
    const nm = $('nightMove');
    nm.textContent = S.calibrating ? '보정 중'
      : (S.score == null ? '–' : `${S.score} / ${S.activeThreshold}`);
    nm.style.color = active ? '#4ade80' : '';

    $('nightMin').textContent = b && b.frames ? `${Math.round((b.active / b.frames) * 100)}%` : '–';
    $('nightLast').textContent = S.calibrating ? '–' : fmtIdle(S.lastActiveMinute);

    const bar = $('nightBar');
    bar.style.width = Math.min(100, Math.round(((S.score || 0) / Math.max(1, S.activeThreshold * 4)) * 100)) + '%';
    bar.style.background = active ? '#4ade80' : '#3d444d';
  }
}
setInterval(() => { if (S.running) updateLiveUI(null); }, 5000);

/* ───────────────────────── 관찰영역 지정 ───────────────────────── */

function fitOverlay() {
  const r = overlay.getBoundingClientRect();
  overlay.width = Math.max(1, Math.round(r.width));
  overlay.height = Math.max(1, Math.round(r.height));
  drawOverlay();
}
window.addEventListener('resize', fitOverlay);

let drag = null;

function drawOverlay(live) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const box = live || (cfg.region && {
    x: cfg.region.x * overlay.width, y: cfg.region.y * overlay.height,
    w: cfg.region.w * overlay.width, h: cfg.region.h * overlay.height,
  });
  if (S.regionMode) {
    octx.fillStyle = 'rgba(0,0,0,.35)';
    octx.fillRect(0, 0, overlay.width, overlay.height);
  }
  if (!box) return;
  if (S.regionMode) octx.clearRect(box.x, box.y, box.w, box.h);
  octx.strokeStyle = '#4ade80';
  octx.lineWidth = 2;
  octx.setLineDash(live ? [6, 4] : []);
  octx.strokeRect(box.x, box.y, box.w, box.h);
  octx.setLineDash([]);
}

overlay.addEventListener('pointerdown', (e) => {
  if (!S.regionMode) return;
  overlay.setPointerCapture(e.pointerId);
  const r = overlay.getBoundingClientRect();
  drag = { x0: e.clientX - r.left, y0: e.clientY - r.top };
});
overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = overlay.getBoundingClientRect();
  const x1 = e.clientX - r.left, y1 = e.clientY - r.top;
  drawOverlay({
    x: Math.min(drag.x0, x1), y: Math.min(drag.y0, y1),
    w: Math.abs(x1 - drag.x0), h: Math.abs(y1 - drag.y0),
  });
});
overlay.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const r = overlay.getBoundingClientRect();
  const x1 = e.clientX - r.left, y1 = e.clientY - r.top;
  const x = Math.min(drag.x0, x1), y = Math.min(drag.y0, y1);
  const w = Math.abs(x1 - drag.x0), h = Math.abs(y1 - drag.y0);
  drag = null;
  if (w < 20 || h < 20) { drawOverlay(); return; }   // 탭 실수 무시
  cfg.region = { x: x / r.width, y: y / r.height, w: w / r.width, h: h / r.height };
  saveCfg(); buildMask();
  toggleRegionMode(false);
  addEvent('info', '관찰영역을 설정했습니다. 재보정을 권합니다.');
});

function toggleRegionMode(on) {
  S.regionMode = on;
  $('btnRegion').classList.toggle('on', on);
  $('btnRegion').textContent = on ? '영역 드래그 중…' : '관찰영역 지정';
  drawOverlay();
}

/* ───────────────────────── 차트 ───────────────────────── */

function chartSetup(cv) {
  const dpr = window.devicePixelRatio || 1;
  // 원래 높이를 한 번만 기억해 둔다. cv.height 는 아래에서 DPR 배율로 덮어쓰므로
  // 그걸 다시 읽으면 다시 그릴 때마다 높이가 배로 불어난다.
  if (!cv.dataset.h) cv.dataset.h = cv.getAttribute('height') || 150;
  const w = cv.clientWidth || 320, h = Number(cv.dataset.h);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.height = h + 'px';
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/** 막대 차트. bins: [{v:0~1|null, label?}] */
function drawBars(cv, bins, opt = {}) {
  const { g, w, h } = chartSetup(cv);
  const padL = 34, padB = 16, padT = 8, padR = 6;   // 100% 라벨이 잘리지 않을 만큼
  const iw = w - padL - padR, ih = h - padB - padT;

  g.strokeStyle = '#2a313a'; g.lineWidth = 1;
  g.fillStyle = '#6e7681'; g.font = '10px sans-serif'; g.textAlign = 'right';
  for (let i = 0; i <= 2; i++) {
    const y = padT + ih * (i / 2);
    g.beginPath(); g.moveTo(padL, y + .5); g.lineTo(w - padR, y + .5); g.stroke();
    g.fillText(`${100 - i * 50}%`, padL - 5, y + 3);
  }

  const bw = iw / bins.length;
  bins.forEach((b, i) => {
    const x = padL + i * bw;
    if (b.v == null) {
      g.fillStyle = '#21262d';
      g.fillRect(x, padT + ih - 2, Math.max(1, bw - 0.5), 2);
      return;
    }
    const bh = Math.max(b.v > 0 ? 1 : 0, ih * Math.min(1, b.v));
    g.fillStyle = opt.color || '#4ade80';
    g.fillRect(x, padT + ih - bh, Math.max(1, bw - 0.5), bh);
  });

  g.fillStyle = '#6e7681'; g.textAlign = 'center'; g.font = '10px sans-serif';
  (opt.ticks || []).forEach((t) => {
    g.fillText(t.label, padL + bw * (t.i + .5), h - 4);
  });
}

async function renderCharts() {
  const nowMin = Math.floor(Date.now() / 60000);

  /* 최근 24시간: 10분 단위 144칸 */
  const rows = await getMinutes(nowMin - 1440, nowMin);
  const byMin = new Map(rows.map((r) => [r.t, r]));
  const bins24 = [];
  for (let i = 0; i < 144; i++) {
    let fr = 0, ac = 0, has = false;
    for (let k = 0; k < 10; k++) {
      const r = byMin.get(nowMin - 1440 + i * 10 + k);
      if (r && r.frames) { fr += r.frames; ac += r.active; has = true; }
    }
    bins24.push({ v: has ? ac / fr : null });
  }
  const ticks24 = [];
  for (let i = 0; i < 144; i += 24) {
    const d = new Date((nowMin - 1440 + i * 10) * 60000);
    ticks24.push({ i, label: `${d.getHours()}시` });
  }
  drawBars($('c24'), bins24, { ticks: ticks24 });

  /* 전체 기간 시간대별 평균 + 일별 활동 시간 */
  const all = await allMinutes();
  const hFrames = new Array(24).fill(0), hActive = new Array(24).fill(0);
  const dayMap = new Map();
  for (const r of all) {
    if (!r.frames) continue;
    const d = new Date(r.t * 60000);
    const h = d.getHours();
    hFrames[h] += r.frames; hActive[h] += r.active;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = dayMap.get(key) || { frames: 0, active: 0, min: 0 };
    cur.frames += r.frames; cur.active += r.active;
    if (r.active / r.frames > 0.05) cur.min++;      // 활동으로 볼 만한 분 수
    dayMap.set(key, cur);
  }
  drawBars($('cHour'),
    hFrames.map((f, h) => ({ v: f ? hActive[h] / f : null })),
    { color: '#60a5fa', ticks: [0, 6, 12, 18].map((i) => ({ i, label: `${i}시` })) });

  const days = [...dayMap.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-14);
  const maxMin = Math.max(60, ...days.map(([, v]) => v.min));
  drawBars($('cDay'),
    days.map(([, v]) => ({ v: v.min / maxMin })),
    { color: '#a78bfa', ticks: days.map(([k], i) => ({ i, label: k.slice(5).replace('-', '/') })).filter((_, i) => i % 3 === 0) });

  /* 요약 */
  const totalMin = all.filter((r) => r.frames).length;
  const n = $('statNote');
  if (!totalMin) {
    n.textContent = '아직 기록이 없습니다.';
  } else {
    const h = (totalMin / 60).toFixed(1);
    const peak = hFrames.map((f, i) => [i, f ? hActive[i] / f : 0]).sort((a, b) => b[1] - a[1])[0];
    const ready = totalMin >= 2880;
    n.innerHTML = `수집 <b>${h}시간</b> (${totalMin}분) · 가장 활발한 시간대 <b>${peak[0]}시</b>`
      + `<br>${ready
        ? '기준선 분석에 쓸 만한 양(2일 이상)이 모였습니다.'
        : `패턴 분석에는 2일(2880분) 이상 필요합니다. 현재 ${Math.round(totalMin / 2880 * 100)}%.`}`
      + `<br>최대 활동률 막대는 ${maxMin}분 기준으로 정규화했습니다.`;
  }
}

async function renderLog() {
  const evs = await recentEvents(60);
  const lbl = { alarm: '경보', warn: '주의', info: '정보' };
  $('log').innerHTML = evs.length
    ? evs.map((e) => {
        const d = new Date(e.ts);
        const t = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} `
          + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `<div class="${e.level}"><time>${t}</time><span class="lv">${lbl[e.level] || ''}</span><span>${e.msg}</span></div>`;
      }).join('')
    : '<div class="info"><span>기록된 이벤트가 없습니다.</span></div>';
}

/* ───────────────────────── CSV ───────────────────────── */

async function exportCsv() {
  const all = await allMinutes();
  all.sort((a, b) => a.t - b.t);
  const lines = ['datetime,epoch_min,frames,active,invalid,active_ratio,score_sum,score_max'];
  for (const r of all) {
    const d = new Date(r.t * 60000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
      + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const ratio = r.frames ? (r.active / r.frames).toFixed(4) : '';
    lines.push([iso, r.t, r.frames, r.active, r.invalid, ratio, r.sum, r.max].join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cagewatch_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ───────────────────────── 설정 폼 ───────────────────────── */

const FIELDS = [
  ['sInact', 'inactiveMin', 'num'], ['sGate', 'gate', 'bool'],
  ['sFrom', 'from', 'str'], ['sTo', 'to', 'str'],
  ['sSound', 'sound', 'bool'], ['sNotif', 'notif', 'bool'],
  ['sSample', 'sampleMs', 'num'], ['sPix', 'pixelThreshold', 'num'],
  ['sMul', 'activeMul', 'num'], ['sMinPct', 'minuteActivePct', 'num'],
  ['sCam', 'camera', 'str'], ['sRed', 'redChannel', 'bool'],
  ['sKeep', 'keepDays', 'num'],
];

function cfgToForm() {
  for (const [id, key, kind] of FIELDS) {
    const el = $(id);
    if (kind === 'bool') el.checked = !!cfg[key]; else el.value = cfg[key];
  }
}

async function formToCfg() {
  const oldSample = cfg.sampleMs, oldCam = cfg.camera;
  for (const [id, key, kind] of FIELDS) {
    const el = $(id);
    if (kind === 'bool') cfg[key] = el.checked;
    else if (kind === 'num') {
      const v = Number(el.value);
      if (Number.isFinite(v)) cfg[key] = v;
    } else cfg[key] = el.value;
  }
  await saveCfg();
  if (S.running && cfg.camera !== oldCam) {
    await addEvent('info', `카메라를 ${cfg.camera === 'user' ? '전면' : '후면'}으로 바꿔 다시 엽니다.`);
    await onStreamLost();
    startCalibration();
  }
  if (S.running && cfg.sampleMs !== oldSample) {
    clearInterval(S.timer);
    S.timer = setInterval(tick, cfg.sampleMs);
  }
  if (cfg.notif && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch (_) {}
  }
  $('setNote').className = 'note';
  $('setNote').innerHTML = '저장했습니다.'
    + (cfg.gate ? ` 감시 시간대는 <b>${cfg.from}~${cfg.to}</b>이고, 지금은 ${inWatchWindow() ? '<b>안</b>' : '밖'}입니다.` : ' 감시 시간대 제한이 꺼져 있어 하루 종일 감지합니다.')
    + (cfg.pixelThreshold !== DEFAULTS.pixelThreshold || cfg.activeMul !== DEFAULTS.activeMul
      ? ' 민감도를 바꿨으면 <b>재보정</b>을 누르세요.' : '');
}

/* ───────────────────────── 초기화 ───────────────────────── */

document.querySelectorAll('nav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
    const id = b.dataset.tab;
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === 'tab-' + id));
    if (id === 'stats') { renderCharts(); renderLog(); }
    if (id === 'live') fitOverlay();
  });
});

$('btnStart').addEventListener('click', start);
$('btnStop').addEventListener('click', stop);
$('btnRecal').addEventListener('click', () => { if (S.running) startCalibration(); });
$('btnRegion').addEventListener('click', () => toggleRegionMode(!S.regionMode));
$('btnRegionClear').addEventListener('click', () => {
  cfg.region = null; saveCfg(); buildMask(); toggleRegionMode(false);
  addEvent('info', '관찰영역을 해제했습니다 (전체 화면 감지).');
});
$('btnAck').addEventListener('click', async () => {
  clearAlarm();
  S.lastActiveAt = Date.now();   // 해제하면 무활동 시계를 다시 돌린다
  S.lastActiveMinute = Math.floor(Date.now() / 60000);
  await addEvent('info', '알람을 수동으로 해제했습니다.');
});
$('btnNight').addEventListener('click', () => toggleNight(!S.night));
$('nightOff').addEventListener('click', () => toggleNight(false));
$('nightRange').addEventListener('input', (e) => {
  cfg.nightPct = Number(e.target.value);
  applyNightColor();
  saveCfg();
});
$('btnSave').addEventListener('click', formToCfg);
$('btnExport').addEventListener('click', exportCsv);
$('btnWipe').addEventListener('click', async () => {
  if (!confirm('지금까지 쌓인 모든 기록과 이벤트를 삭제합니다. 되돌릴 수 없습니다.')) return;
  await wipeAll(); renderCharts(); renderLog();
});

(async function init() {
  $('ver').textContent = 'v' + VERSION;
  const saved = await loadCfg().catch(() => null);
  if (saved) cfg = { ...DEFAULTS, ...saved };
  cfgToForm();
  applyNightColor();
  buildMask();
  fitOverlay();
  renderLog();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!window.isSecureContext) {
    $('liveNote').className = 'note warn';
    $('liveNote').innerHTML = '<b>보안 컨텍스트가 아닙니다.</b> 카메라는 HTTPS 또는 localhost에서만 열립니다. README의 호스팅 안내를 보세요.';
  }
})();
