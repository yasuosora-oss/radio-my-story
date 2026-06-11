/* =========================================================
   ラジオ・マイ・ストーリー — Step 1
   録音リレーとデータ管理（API連携はまだモック）
   ========================================================= */

"use strict";

/* ---------- アプリ全体の状態 ---------- */
const state = {
  playerCount: 0,      // 参加人数（2〜5）
  currentPlayer: 0,    // いま録音する人（0始まり）。バトンタッチでぐるぐる回る
  takes: [],           // 確定したシーンの配列 [{ player, blob, url, durationSec }]
  selectedGenre: null, // 選んだジャンル
  storyOutline: null,  // AIがまとめた「あらすじ」。おかわり時に再利用する
  dramaMarks: [],      // 場面の変わり目の秒数リスト（効果音のタイミング）
  bgmOn: true,         // BGM・効果音のオン／オフ
  ecoMode: localStorage.getItem("rms_eco") === "1", // 節約モード（前回の選択を記憶）
  currentScript: null, // いま表示中の台本（音声化に使う）
  dramaUrl: null,      // 生成した音声ドラマの再生用URL
};

// 録音直後・バトンタッチ前の「仮のテイク」。録りなおしたら捨てる
let pendingTake = null;

const PLAYER_LABELS = ["A", "B", "C", "D", "E"];

const HINT_OPENING = "物語のはじまりをどうぞ！「むかしむかし…」でもOK";
const HINTS_LOOP = [
  "前の人の話をうけて、つづきをどうぞ！",
  "新キャラ登場や場面チェンジも自由！",
  "そろそろ事件が起きるころかも…？",
  "どんでん返しのチャンス！",
  "クライマックスに向けて盛り上げよう！",
];

/* ---------- 録音まわりの内部変数 ---------- */
let mediaStream = null;
let mediaRecorder = null;
let recChunks = [];
let audioCtx = null;
let analyser = null;
let rafId = null;
let recStartTime = 0;
let timerId = null;

/* ---------- よく使う要素 ---------- */
const $ = (id) => document.getElementById(id);

const screens = {
  setup: $("screen-setup"),
  relay: $("screen-relay"),
  complete: $("screen-complete"),
  loading: $("screen-loading"),
  outline: $("screen-outline"),
  genre: $("screen-genre"),
  result: $("screen-result"),
};

/* ---------- 画面切り替え ---------- */
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
  window.scrollTo({ top: 0 });
  if (name !== "loading") keepAwake(false); // 生成画面を離れたら画面スリープ防止を解除
}

/* ---------- スマホの画面スリープ防止（生成中だけ） ----------
   スマホは画面が消えると通信を止めてしまうため、
   生成中はブラウザに「画面をつけたままにして」とお願いする */
let wakeLock = null;

async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) { /* 対応していない端末ではそのまま（従来どおり）動く */ }
}

/* 他のアプリから戻ってきたとき、生成中ならスリープ防止をかけなおす */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && screens.loading.classList.contains("active")) {
    keepAwake(true);
  }
});

/* =========================================================
   画面1：初期設定（人数選択）
   ========================================================= */
document.querySelectorAll(".count-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".count-btn").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.playerCount = Number(btn.dataset.count);
    updateStartEnabled();
  });
});

/* 「収録スタート」は、人数とAIのカギの両方がそろったら押せる */
function updateStartEnabled() {
  const hasCount = state.playerCount > 0;
  const hasKey = $("apiKeyInput").value.trim().length > 0;
  $("btnStart").disabled = !(hasCount && hasKey);
}
$("apiKeyInput").addEventListener("input", updateStartEnabled);

/* 保存済みのカギがあれば、最初から入力欄に入れておく */
(function prefillApiKey() {
  const saved = getSavedApiKey();
  if (saved) {
    $("apiKeyInput").value = saved;
    $("apiKeySave").checked = true;
  }
})();

$("btnStart").addEventListener("click", () => {
  setApiKey($("apiKeyInput").value, $("apiKeySave").checked);
  state.currentPlayer = 0;
  state.takes = [];
  pendingTake = null;
  buildProgressDots();
  updateRelayUI();
  showScreen("relay");
});

/* =========================================================
   画面2：録音リレー
   ========================================================= */
function buildProgressDots() {
  const wrap = $("relayProgress");
  wrap.innerHTML = "";
  for (let i = 0; i < state.playerCount; i++) {
    const dot = document.createElement("div");
    dot.className = "dot";
    dot.textContent = PLAYER_LABELS[i];
    wrap.appendChild(dot);
  }
}

function updateRelayUI() {
  const i = state.currentPlayer;
  const sceneNo = state.takes.length + 1; // いま録るのが何シーン目か

  $("playerName").textContent = "ユーザー" + PLAYER_LABELS[i];
  $("sceneCounter").textContent = "SCENE " + sceneNo;

  // ヒント：最初のシーンは導入用、それ以降はループでいろいろ出す
  const hint = (sceneNo === 1)
    ? HINT_OPENING
    : HINTS_LOOP[(sceneNo - 2) % HINTS_LOOP.length];
  $("playerHint").textContent = hint;

  // ドットの状態更新：いまの人だけ光る（リレーは何周でも回る）
  document.querySelectorAll("#relayProgress .dot").forEach((dot, idx) => {
    dot.classList.toggle("current", idx === i);
  });

  // コントロールを初期状態に
  $("btnRec").classList.remove("hidden");
  $("btnStop").classList.add("hidden");
  $("afterRec").classList.add("hidden");
  $("micError").classList.add("hidden");
  $("recTimer").textContent = "00:00";
  clearCanvas();
}

/* ---------- 録音スタート ---------- */
$("btnRec").addEventListener("click", async () => {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error("マイク取得エラー:", err);
    $("micError").classList.remove("hidden");
    return;
  }

  recChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recChunks.push(e.data);
  };
  mediaRecorder.onstop = onRecordingStopped;
  mediaRecorder.start();

  // 波形表示の準備（Web Audio API）
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  source.connect(analyser);
  drawWave();

  // タイマー開始
  recStartTime = Date.now();
  timerId = setInterval(updateTimer, 200);

  // UI切り替え
  $("btnRec").classList.add("hidden");
  $("btnStop").classList.remove("hidden");
  $("onairLamp").classList.add("lit");
  document.querySelector(".visualizer-wrap").classList.add("live");
});

/* ---------- ストップ ---------- */
$("btnStop").addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
});

/* ---------- 録音停止後の処理 ---------- */
function onRecordingStopped() {
  const durationSec = Math.round((Date.now() - recStartTime) / 1000);

  // 後片付け
  clearInterval(timerId);
  cancelAnimationFrame(rafId);
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  mediaStream = null;
  audioCtx = null;

  // Blob化して「仮テイク」として保持（バトンタッチで確定）
  const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
  const url = URL.createObjectURL(blob);
  pendingTake = { player: state.currentPlayer, blob, url, durationSec };
  console.log(`シーン${state.takes.length + 1}（ユーザー${PLAYER_LABELS[state.currentPlayer]}）を録音:`, blob);

  // UI切り替え：試聴＆バトンタッチ
  $("btnStop").classList.add("hidden");
  $("onairLamp").classList.remove("lit");
  document.querySelector(".visualizer-wrap").classList.remove("live");
  $("previewAudio").src = url;
  $("afterRec").classList.remove("hidden");

  // 全員が1回ずつ話し終わっていたら「物語を完結する」ボタンも出す
  const canFinish = state.takes.length + 1 >= state.playerCount;
  $("btnFinish").classList.toggle("hidden", !canFinish);
}

/* ---------- 仮テイクを物語に確定する ---------- */
function commitPendingTake() {
  if (pendingTake) {
    state.takes.push(pendingTake);
    pendingTake = null;
  }
}

/* ---------- 録りなおす ---------- */
$("btnRetake").addEventListener("click", () => {
  if (pendingTake) URL.revokeObjectURL(pendingTake.url);
  pendingTake = null;
  updateRelayUI();
});

/* ---------- 次の人へバトンタッチ（何周でも回る） ---------- */
$("btnNext").addEventListener("click", () => {
  commitPendingTake();
  state.currentPlayer = (state.currentPlayer + 1) % state.playerCount;
  updateRelayUI();
});

/* ---------- 物語をここで完結する ---------- */
$("btnFinish").addEventListener("click", () => {
  commitPendingTake();
  buildTakeList();
  showScreen("complete");
});

/* ---------- タイマー表示 ---------- */
function updateTimer() {
  const sec = Math.floor((Date.now() - recStartTime) / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  $("recTimer").textContent = `${mm}:${ss}`;
}

/* ---------- 波形描画 ---------- */
function drawWave() {
  const canvas = $("waveCanvas");
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(analyser.frequencyBinCount);

  function frame() {
    rafId = requestAnimationFrame(frame);
    analyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barCount = data.length;
    const barW = canvas.width / barCount;
    const midY = canvas.height / 2;

    for (let i = 0; i < barCount; i++) {
      const h = Math.max(4, (data[i] / 255) * canvas.height * 0.9);
      // 中央から上下に伸びるバー。音量が大きいほど赤く
      const heat = data[i] / 255;
      ctx.fillStyle = heat > 0.6 ? "#ff4757" : "#ffb547";
      ctx.beginPath();
      ctx.roundRect(i * barW + 1, midY - h / 2, barW - 2, h, 3);
      ctx.fill();
    }
  }
  frame();
}

function clearCanvas() {
  const canvas = $("waveCanvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 待機中はまんなかに細いライン
  ctx.fillStyle = "#2e2638";
  ctx.fillRect(0, canvas.height / 2 - 1, canvas.width, 2);
}

/* =========================================================
   画面3：全員の録音完了
   ========================================================= */
function buildTakeList() {
  const list = $("takeList");
  list.innerHTML = "";
  state.takes.forEach((take, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "take-name";
    name.textContent = `${i + 1}. ユーザー${PLAYER_LABELS[take.player]}（${take.durationSec}秒）`;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = take.url;
    li.appendChild(name);
    li.appendChild(audio);
    list.appendChild(li);
  });
}

$("btnGenerate").addEventListener("click", () => {
  // カギは最初の画面でセット済み
  startIntegration();
});

/* =========================================================
   画面5：生成中（ローディング）とエラー表示
   ========================================================= */
let errorReturnScreen = "complete"; // エラー時に「もどる」で戻る先

function showLoading(message, returnScreen) {
  errorReturnScreen = returnScreen;
  $("loadingText").textContent = message;
  $("loadingWrap").classList.remove("hidden");
  $("apiError").classList.add("hidden");
  $("btnErrorBack").classList.add("hidden");
  $("btnShowKeySwap").classList.add("hidden");
  $("keySwap").classList.add("hidden");
  showScreen("loading");
  keepAwake(true); // 生成中はスマホの画面を消さない
}

function showApiError(message) {
  $("loadingWrap").classList.add("hidden");
  $("apiError").textContent = "⚠️ " + message;
  $("apiError").classList.remove("hidden");
  $("btnErrorBack").classList.remove("hidden");
  $("btnShowKeySwap").classList.remove("hidden");
}

/* エラー画面から、録音や台本を消さずにAPIキーだけ差し替える */
$("btnShowKeySwap").addEventListener("click", () => {
  $("keySwap").classList.remove("hidden");
  $("apiKeySwapInput").focus();
});

$("btnKeySwapApply").addEventListener("click", () => {
  const key = $("apiKeySwapInput").value.trim();
  if (!key) {
    $("apiKeySwapInput").focus();
    $("apiKeySwapInput").placeholder = "ここに新しいキーを貼り付けてください！";
    return;
  }
  setApiKey(key, $("apiKeySave").checked);
  $("apiKeyInput").value = key; // 最初の画面の入力欄もそろえておく
  $("apiKeySwapInput").value = "";
  $("keySwap").classList.add("hidden");
  showScreen(errorReturnScreen); // もどって、もう一度生成ボタンを押せばOK
});

$("btnErrorBack").addEventListener("click", () => showScreen(errorReturnScreen));

/* ---------- ①録音をAIに送って、あらすじに統合 ---------- */
async function startIntegration() {
  showLoading("みんなの声を聴いて、物語をまとめています…", "complete");
  try {
    const outline = await integrateStory(state.takes);
    state.storyOutline = outline;
    $("outlineBox").textContent = outline;
    showScreen("outline");
  } catch (err) {
    console.error("あらすじ生成エラー:", err);
    showApiError(err.message);
  }
}

/* =========================================================
   画面6：あらすじ確認
   ========================================================= */
$("btnToGenre").addEventListener("click", () => showScreen("genre"));

/* =========================================================
   画面7：ジャンル選択 → ②台本の生成
   ========================================================= */
document.querySelectorAll(".genre-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    state.selectedGenre = btn.dataset.genre;
    showLoading(`「${state.selectedGenre}」の台本を執筆中…`, "genre");
    try {
      const script = await generateScript(state.storyOutline, state.selectedGenre);
      state.currentScript = script;
      $("resultTitle").innerHTML = `「${state.selectedGenre}」版<br>台本、完成！`;
      $("scriptBox").textContent = script;
      resetDramaPlayer(); // 新しい台本なので、前の音声はリセット
      showScreen("result");
    } catch (err) {
      console.error("台本生成エラー:", err);
      showApiError(err.message);
    }
  });
});

/* =========================================================
   画面8：台本完成 → ③音声ドラマの生成・再生
   ========================================================= */
function resetDramaPlayer() {
  stopBgm();
  if (state.dramaUrl) URL.revokeObjectURL(state.dramaUrl);
  state.dramaUrl = null;
  state.dramaMarks = [];
  nextMarkIdx = 0;
  lastAutoPhase = null;
  $("dramaAudio").removeAttribute("src");
  $("dramaPlayer").classList.add("hidden");
  $("dramaPlayer").classList.remove("playing");
  $("btnSpeak").classList.remove("hidden");
}

/* ---------- BGM・効果音の再生制御 ---------- */
const dramaAudio = $("dramaAudio");
let nextMarkIdx = 0;      // 次に鳴らす効果音は何番目か
let lastAutoPhase = null; // タグなし台本用：時間4等分で出した直近のフェーズ

function syncMarkIndex() {
  const t = dramaAudio.currentTime;
  nextMarkIdx = 0;
  while (nextMarkIdx < state.dramaMarks.length && state.dramaMarks[nextMarkIdx].at <= t) {
    nextMarkIdx++;
  }
}

/* 台本に起承転結タグが付いているか */
function hasPhaseTags() {
  return state.dramaMarks.some((m) => m.phase);
}

/* いまの再生位置の起承転結（タグから判定） */
function currentTaggedPhase() {
  let phase = "起";
  for (const m of state.dramaMarks) {
    if (m.at <= dramaAudio.currentTime && m.phase) phase = m.phase;
  }
  return phase;
}

/* 保険：タグがない台本は、再生時間を4等分して起承転結とみなす */
function autoPhase() {
  const d = dramaAudio.duration;
  if (!d || !isFinite(d)) return "起";
  return ["起", "承", "転", "結"][Math.min(3, Math.floor((dramaAudio.currentTime / d) * 4))];
}

function applyCurrentPhase() {
  setBgmPhase(hasPhaseTags() ? currentTaggedPhase() : autoPhase());
}

dramaAudio.addEventListener("play", () => {
  $("dramaPlayer").classList.add("playing");
  if (!state.bgmOn) return;
  startBgm(state.selectedGenre);
  applyCurrentPhase();
  if (dramaAudio.currentTime < 0.3) playSceneSE(state.selectedGenre); // オープニングの一発
  syncMarkIndex();
});

dramaAudio.addEventListener("pause", () => {
  $("dramaPlayer").classList.remove("playing");
  stopBgm();
});
dramaAudio.addEventListener("ended", () => {
  $("dramaPlayer").classList.remove("playing");
  if (state.bgmOn) playSceneSE(state.selectedGenre); // エンディングの一発
  stopBgm();
});
dramaAudio.addEventListener("seeked", () => {
  syncMarkIndex();
  if (!dramaAudio.paused && state.bgmOn) applyCurrentPhase();
});

dramaAudio.addEventListener("timeupdate", () => {
  if (dramaAudio.paused || !state.bgmOn) return;
  while (nextMarkIdx < state.dramaMarks.length && state.dramaMarks[nextMarkIdx].at <= dramaAudio.currentTime) {
    const mark = state.dramaMarks[nextMarkIdx];
    playSceneSE(state.selectedGenre);          // 場面の変わり目で効果音
    if (mark.phase) setBgmPhase(mark.phase);   // 起承転結でBGMの表情を変える
    nextMarkIdx++;
  }
  if (!hasPhaseTags()) {
    const p = autoPhase();
    if (p !== lastAutoPhase) { lastAutoPhase = p; setBgmPhase(p); }
  }
});

$("btnBgmToggle").addEventListener("click", () => {
  state.bgmOn = !state.bgmOn;
  $("btnBgmToggle").textContent = state.bgmOn ? "🎵 BGM・効果音：オン" : "🔇 BGM・効果音：オフ";
  if (state.bgmOn && !dramaAudio.paused) {
    startBgm(state.selectedGenre);
    syncMarkIndex();
  } else if (!state.bgmOn) {
    stopBgm();
  }
});

/* ---------- 音声生成モードの切り替え ---------- */
function updateModeButtons() {
  $("modeRich").classList.toggle("selected", !state.ecoMode);
  $("modeEco").classList.toggle("selected", state.ecoMode);
}
$("modeRich").addEventListener("click", () => {
  state.ecoMode = false;
  localStorage.setItem("rms_eco", "0");
  updateModeButtons();
});
$("modeEco").addEventListener("click", () => {
  state.ecoMode = true;
  localStorage.setItem("rms_eco", "1");
  updateModeButtons();
});
updateModeButtons();

$("btnSpeak").addEventListener("click", async () => {
  const startMsg = state.ecoMode
    ? "1人語りの声優AIを呼んでいます…（節約モード）"
    : "配役を決めて、声優AIたちを集めています…（数分かかることがあります）";
  showLoading(startMsg, "result");
  try {
    const result = await generateSpeech(state.currentScript, state.selectedGenre,
      (msg) => { $("loadingText").textContent = msg; }, state.ecoMode);
    state.dramaUrl = URL.createObjectURL(result.blob);
    state.dramaMarks = result.marks;
    $("dramaTitle").textContent = result.title || `きょうの${state.selectedGenre}`;
    $("dramaAudio").src = state.dramaUrl;
    $("dramaPlayer").classList.remove("hidden");
    $("btnSpeak").classList.add("hidden");
    showScreen("result");
    $("dramaAudio").play().catch(() => {}); // 自動再生できない端末では再生ボタンで
  } catch (err) {
    console.error("音声生成エラー:", err);
    showApiError(err.message);
  }
});

$("btnAnotherGenre").addEventListener("click", () => {
  // 録音データはそのまま、ジャンルだけ選びなおせる（＝おかわり機能の土台）
  showScreen("genre");
});

function restartAll() {
  state.takes.forEach((take) => URL.revokeObjectURL(take.url));
  if (pendingTake) URL.revokeObjectURL(pendingTake.url);
  state.takes = [];
  pendingTake = null;
  state.currentPlayer = 0;
  state.selectedGenre = null;
  state.storyOutline = null;
  state.currentScript = null;
  resetDramaPlayer();
  showScreen("setup");
}
$("btnRestart").addEventListener("click", restartAll);
$("btnRestart2").addEventListener("click", restartAll);
$("btnRestart3").addEventListener("click", restartAll);

/* ---------- 初期化 ---------- */
clearCanvas();
