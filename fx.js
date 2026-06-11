/* =========================================================
   Radio My Story — Step 4
   BGMと効果音（SE）
   音源ファイルは使わず、ブラウザ内蔵のシンセサイザー
   （Web Audio API）でその場で演奏する。
   各ジャンルに「作曲済みのメロディ」を持たせている。
   ========================================================= */

"use strict";

let fxCtx = null;
let bgm = null; // 再生中のBGM一式

function fxContext() {
  if (!fxCtx) fxCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (fxCtx.state === "suspended") fxCtx.resume();
  return fxCtx;
}

/* 音名→周波数(Hz)の対応表（メロディを書きやすくするため） */
const N = {
  G3: 196, GS3: 208, A3: 220, AS3: 233, B3: 247,
  C4: 262, D4: 294, DS4: 311, E4: 330, F4: 349, G4: 392, A4: 440, AS4: 466, B4: 494,
  C5: 523, D5: 587, E5: 659, F5: 698, G5: 784, A5: 880, C6: 1047,
};

/* ジャンルごとの音の設計図
   drones: 鳴りっぱなしの土台の音［周波数, 波形］
   melody: 作曲済みのメロディ。［音の高さ, 長さ(拍)］の並び。0は休符
   tempo:  テンポ（1分あたりの拍数）
   noise:  空気感ノイズの量（ホラー系）
   se:     場面の変わり目の効果音の種類 */
const GENRE_FX = {
  "恋愛・ラブコメ": { // 明るいピアノ風＋胸キュンポップ
    vol: .09, filter: 1100, noise: 0, wave: "sine", tempo: 92, se: "chime",
    drones: [[131, "sine"], [196, "sine"]],
    melody: [
      [N.E4, .5], [N.G4, .5], [N.A4, 1], [N.G4, .5], [N.E4, .5], [N.D4, 1], [N.C4, 1],
      [N.D4, .5], [N.E4, .5], [N.G4, 1], [N.E5, 1.5], [N.D5, .5], [N.C5, 2], [0, 1],
    ],
  },
  "SF・ファンタジー": { // 浮遊感のある電子音＋壮大なオーケストラ風
    vol: .10, filter: 800, noise: .04, wave: "sine", tempo: 56, se: "sweep",
    drones: [[65.4, "sawtooth"], [98, "sine"]],
    melody: [
      [N.C4, 2], [N.G4, 2], [N.C5, 3], [0, 1], [N.A4, 2], [N.G4, 2], [N.E4, 3], [0, 1],
      [N.F4, 2], [N.G4, 2], [N.C5, 4], [0, 2],
    ],
  },
  "ミステリー・サスペンス": { // 緊張感のあるジャズ風＋時計の秒針（チクタク）
    vol: .10, filter: 500, noise: .06, wave: "sine", tempo: 100, se: "stab", tick: true,
    drones: [[49, "sawtooth"], [73.4, "sine"]],
    melody: [
      [N.G3, .5], [N.AS3, .5], [N.B3, .5], [N.G3, .5], [0, .5], [N.C4, .5], [N.B3, 1],
      [0, 1], [N.G3, .5], [N.AS3, .5], [N.GS3, 1], [0, 1.5],
    ],
  },
  "ホラー・怪談": { // 不協和音＋家鳴りノイズ＋心拍を狂わせる低音
    vol: .11, filter: 400, noise: .16, wave: "sine", tempo: 46, se: "dokun", pulse: true,
    drones: [[55, "sawtooth"], [58.3, "sine"]],
    melody: [
      [N.AS3, 2], [N.A3, 2], [0, 2], [N.B3, 2], [N.AS3, 3], [0, 3],
      [N.E4, 1], [N.DS4, 3], [0, 4],
    ],
  },
  "日常・コメディ": { // 木琴・ウクレレ風の軽快ポップ
    vol: .10, filter: 1500, noise: 0, wave: "triangle", tempo: 120, se: "boing",
    drones: [[131, "triangle"]],
    melody: [
      [N.C4, .5], [N.E4, .5], [N.G4, .5], [N.E4, .5], [N.A4, .5], [N.G4, .5], [N.E4, 1],
      [0, .5], [N.F4, .5], [N.D4, .5], [N.G4, .5], [N.C5, 1], [0, 1],
    ],
  },
  "歴史・時代劇": { // 三味線風の音色＋叙情的で切ない和風メロディ
    vol: .10, filter: 1300, noise: 0, wave: "sawtooth", tempo: 60, se: "ki",
    drones: [[147, "sine"]],
    melody: [
      [N.D4, 1], [N.DS4, 1], [N.G4, 2], [N.A4, 1], [N.AS4, 1], [N.A4, 2],
      [N.G4, 1], [N.DS4, 1], [N.D4, 2], [0, 2],
    ],
  },
};

/* 起承転結ごとのBGMの表情（基本設定にかける倍率）
   vol=音量 melo=メロディの音量 tempo=速さ tension=緊張感の音の強さ */
const BGM_PHASES = {
  "起": { vol: 0.8,  melo: 0.6, tempo: 0.9,  tension: 0 },
  "承": { vol: 1.0,  melo: 1.0, tempo: 1.0,  tension: 0 },
  "転": { vol: 1.35, melo: 1.5, tempo: 1.25, tension: 0.3 },
  "結": { vol: 0.85, melo: 0.6, tempo: 0.8,  tension: 0 },
};

/* 1音だけ鳴らす部品（音程・波形・音量・立ち上がり・余韻を指定） */
function tone(dest, freq, wave, peak, attack, decay, when) {
  const ctx = fxContext();
  const t = (when !== undefined) ? when : ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = wave;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + attack + decay + 0.1);
}

/* ホラー用：心臓の鼓動（ドッ、ドッ） */
function heartbeat(dest) {
  const ctx = fxContext();
  tone(dest, 52, "sine", 0.9, 0.005, 0.18);
  tone(dest, 48, "sine", 0.7, 0.005, 0.16, ctx.currentTime + 0.22);
}

/* ミステリー用：時計の秒針（チク、タク） */
function clockTick(dest, alt) {
  tone(dest, alt ? 2200 : 1750, "sine", 0.10, 0.001, 0.05);
}

/* メロディを1音ずつ順番に演奏していく（終わったら最初に戻ってループ） */
function playMelodyStep() {
  if (!bgm) return;
  const cfg = bgm.cfg;
  const note = cfg.melody[bgm.melodyIdx % cfg.melody.length];
  bgm.melodyIdx++;
  const beatMs = 60000 / (cfg.tempo * bgm.phaseMul.tempo);
  const durMs = note[1] * beatMs;
  if (note[0] > 0) {
    const peak = Math.min(0.45, 0.28 * bgm.phaseMul.melo);
    tone(bgm.master, note[0], cfg.wave, peak, 0.02, Math.max(0.25, (durMs / 1000) * 0.9));
  }
  bgm.melodyTimer = setTimeout(playMelodyStep, durMs);
}

/* メロディと鼓動のタイマーを（いまの表情に合わせて）かけ直す */
function scheduleMusic() {
  if (!bgm) return;
  clearTimeout(bgm.melodyTimer);
  clearInterval(bgm.beatTimer);
  playMelodyStep();
  if (bgm.cfg.pulse) {
    const beatMs = 60000 / (bgm.cfg.tempo * bgm.phaseMul.tempo);
    bgm.beatTimer = setInterval(() => { if (bgm) heartbeat(bgm.master); }, beatMs * 2);
  } else if (bgm.cfg.tick) {
    // 時計の秒針はテンポに関係なく、きっかり1秒ごと
    bgm.beatTimer = setInterval(() => {
      if (!bgm) return;
      bgm.tickAlt = !bgm.tickAlt;
      clockTick(bgm.master, bgm.tickAlt);
    }, 1000);
  }
}

/* BGMの表情を起承転結で切り替える（3秒かけてじわっと変化） */
function setBgmPhase(name) {
  if (!bgm || !BGM_PHASES[name]) return;
  const p = BGM_PHASES[name];
  if (bgm.phaseMul === p) return;
  bgm.phaseMul = p;
  const ctx = fxContext();
  const t = ctx.currentTime;
  bgm.master.gain.cancelScheduledValues(t);
  bgm.master.gain.setValueAtTime(bgm.master.gain.value, t);
  bgm.master.gain.linearRampToValueAtTime(bgm.cfg.vol * p.vol, t + 3);
  bgm.tensionGain.gain.cancelScheduledValues(t);
  bgm.tensionGain.gain.setValueAtTime(bgm.tensionGain.gain.value, t);
  bgm.tensionGain.gain.linearRampToValueAtTime(p.tension, t + 3);
  console.log("BGMフェーズ:", name);
}

/* ---------- BGMの開始・停止 ---------- */
function startBgm(genre) {
  stopBgm();
  const cfg = GENRE_FX[genre] || GENRE_FX["日常・コメディ"];
  const ctx = fxContext();

  const master = ctx.createGain();
  master.gain.setValueAtTime(0, ctx.currentTime);
  master.gain.linearRampToValueAtTime(cfg.vol * BGM_PHASES["起"].vol, ctx.currentTime + 2);
  master.connect(ctx.destination);
  const nodes = [];

  // 1) ドローン（鳴りっぱなしの土台）。音量をゆっくり揺らして生きている感じに
  cfg.drones.forEach(([freq, wave], i) => {
    const o = ctx.createOscillator(); o.type = wave; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = 0.5;
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cfg.filter;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07 + i * 0.04;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.18;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    o.connect(g); g.connect(f); f.connect(master);
    o.start(); lfo.start();
    nodes.push(o, lfo);
  });

  // 2) 空気感ノイズ（ホラー・サスペンスの不穏さ）
  if (cfg.noise > 0) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 160;
    const g = ctx.createGain(); g.gain.value = cfg.noise;
    src.connect(f); f.connect(g); g.connect(master);
    src.start();
    nodes.push(src);
  }

  // 3) 「転」で立ち上がる緊張感の音（ふだんは無音で待機）
  const baseFreq = cfg.drones.length ? cfg.drones[0][0] : 110;
  const tOsc = ctx.createOscillator();
  tOsc.type = "sawtooth";
  tOsc.frequency.value = baseFreq * 1.06; // 土台より半音ずれた不穏な音
  const tFil = ctx.createBiquadFilter();
  tFil.type = "lowpass";
  tFil.frequency.value = cfg.filter;
  const tGain = ctx.createGain();
  tGain.gain.value = 0;
  tOsc.connect(tFil); tFil.connect(tGain); tGain.connect(master);
  tOsc.start();
  nodes.push(tOsc);

  // 4) メロディは「起」の表情でスタート
  bgm = {
    master, nodes, cfg,
    tensionGain: tGain,
    phaseMul: BGM_PHASES["起"],
    melodyIdx: 0,
    melodyTimer: null,
    beatTimer: null,
  };
  scheduleMusic();
}

function stopBgm() {
  if (!bgm) return;
  const ctx = fxContext();
  clearTimeout(bgm.melodyTimer);
  clearInterval(bgm.beatTimer);
  const m = bgm.master;
  const nodes = bgm.nodes;
  bgm = null;
  m.gain.cancelScheduledValues(ctx.currentTime);
  m.gain.setValueAtTime(m.gain.value, ctx.currentTime);
  m.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6); // ふわっと消す
  setTimeout(() => {
    nodes.forEach((n) => { try { n.stop(); } catch (e) { /* 停止済みは無視 */ } });
    m.disconnect();
  }, 700);
}

/* ---------- 場面の変わり目の効果音（ジャンル別） ---------- */
function playSceneSE(genre) {
  const cfg = GENRE_FX[genre] || GENRE_FX["日常・コメディ"];
  const ctx = fxContext();
  const out = ctx.createGain();
  out.gain.value = 0.3;
  out.connect(ctx.destination);
  const t = ctx.currentTime;

  switch (cfg.se) {
    case "chime": // やわらかいチャイム
      [523, 659, 784].forEach((f, i) => tone(out, f, "sine", 0.5, 0.01, 1.0, t + i * 0.12));
      break;

    case "boing": { // コミカルな「ボヨン」
      const o = ctx.createOscillator(); o.type = "triangle";
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(600, t + 0.25);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.5);
      break;
    }

    case "sting": // ホラーの不協和音「ヒュイーン…」
      [466, 494, 523].forEach((f) => tone(out, f, "sawtooth", 0.25, 0.4, 1.6, t));
      break;

    case "sweep": { // SFの上昇スイープ
      const o = ctx.createOscillator(); o.type = "sawtooth";
      o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(1400, t + 0.8);
      const f = ctx.createBiquadFilter(); f.type = "lowpass";
      f.frequency.setValueAtTime(400, t);
      f.frequency.exponentialRampToValueAtTime(3000, t + 0.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.3, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
      o.connect(f); f.connect(g); g.connect(out);
      o.start(t); o.stop(t + 1.1);
      break;
    }

    case "koto": // 琴の上昇アルペジオ
      [294, 392, 440, 587, 784].forEach((f, i) => tone(out, f, "triangle", 0.4, 0.005, 0.7, t + i * 0.07));
      break;

    case "bell": // ロマンスのやさしいベル
      [698, 880, 1047].forEach((f, i) => tone(out, f, "sine", 0.4, 0.01, 1.4, t + i * 0.18));
      break;

    case "braam": // 重低音「ブォーン」
      tone(out, 55, "sawtooth", 0.7, 0.06, 1.4, t);
      tone(out, 58, "sawtooth", 0.5, 0.06, 1.4, t);
      break;

    case "stab": // ピアノの鋭い一音「ジャン！」
      [110, 220, 262, 330].forEach((f) => tone(out, f, "sawtooth", 0.3, 0.005, 1.3, t));
      break;

    case "dokun": { // 心臓の鼓動「ドクン」＋何かが擦れるノイズ
      tone(out, 52, "sine", 0.9, 0.005, 0.2, t);
      tone(out, 48, "sine", 0.7, 0.005, 0.18, t + 0.22);
      const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.5), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (i / d.length) * 0.5;
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 900;
      const g = ctx.createGain(); g.gain.value = 0.5;
      src.connect(f); f.connect(g); g.connect(out);
      src.start(t + 0.5);
      break;
    }

    case "ki": { // 拍子木「カンッ、カンッ」
      [0, 0.22].forEach((dt) => {
        const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.03), ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
        const src = ctx.createBufferSource(); src.buffer = buf;
        const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 2500;
        const g = ctx.createGain(); g.gain.value = 0.8;
        src.connect(f); f.connect(g); g.connect(out);
        src.start(t + dt);
      });
      break;
    }
  }
}
