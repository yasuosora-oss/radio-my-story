/* =========================================================
   ラジオ・マイ・ストーリー — Step 2
   Gemini API との通信まわり
   APIキーはコードに書かず、画面から入力してもらう方式
   ========================================================= */

"use strict";

/* 使いたいモデルの候補。上から順に試して、使えたものを採用する */
const GEMINI_MODELS = [
  "gemini-3.5-flash",
  "gemini-3-flash",
  "gemini-flash-latest",
  "gemini-2.5-flash",
];

/* 読み上げ（TTS）専用モデルの候補。上から順に試す
   （2026年6月にGoogleがモデル名を刷新したため、新名→旧名の順で網羅） */
const GEMINI_TTS_MODELS = [
  "gemini-3.1-flash-tts-preview",    // 最新（最優先で試す）
  "gemini-2.5-flash-tts",            // 現行の標準モデル
  "gemini-2.5-pro-tts",              // 高品質版
  "gemini-2.5-flash-lite-preview-tts",
  "gemini-2.5-flash-preview-tts",    // 旧名（保険）
  "gemini-2.5-pro-preview-tts",      // 旧名（保険）
];

/* ジャンルごとの「ナレーション担当の声」。雰囲気に合う声を割り当てる */
const GENRE_VOICES = {
  "恋愛・ラブコメ":      "Sulafat",   // 優しく包み込むあたたかい声
  "SF・ファンタジー":    "Charon",    // 重厚感・説得力のある声
  "ミステリー・サスペンス": "Algenib", // 冷静沈着で低めの、影のある声
  "ホラー・怪談":        "Enceladus", // 静かで囁くような声
  "日常・コメディ":      "Puck",      // 元気で快活な声
  "歴史・時代劇":        "Alnilam",   // 威厳と深みのある語り部の声
};

/* 登場人物用の「声優プール」。性別・年代ごとに別の声を割り当てる */
const VOICE_POOLS = {
  manAdult:   ["Orus", "Iapetus", "Algieba", "Achird", "Umbriel"],
  womanAdult: ["Callirrhoe", "Despina", "Erinome", "Autonoe", "Vindemiatrix"],
  boy:        ["Puck", "Zubenelgenubi"],
  girl:       ["Leda", "Zephyr"],
  oldMan:     ["Rasalgethi", "Algenib"],
  oldWoman:   ["Gacrux", "Sulafat"],
};

/* 「女性・子ども」のような説明文から、合う声のプールを選ぶ */
function pickVoicePool(desc) {
  const female = /女/.test(desc);
  if (/子|少年|少女|幼/.test(desc)) return female ? VOICE_POOLS.girl : VOICE_POOLS.boy;
  if (/老|高齢|年配|おじい|おばあ/.test(desc)) return female ? VOICE_POOLS.oldWoman : VOICE_POOLS.oldMan;
  return female ? VOICE_POOLS.womanAdult : VOICE_POOLS.manAdult;
}

/* 配役表をもとに、役ごとに「かぶらない声」を割り当てる */
function assignVoices(cast, genre) {
  const narrator = GENRE_VOICES[genre] || "Kore";
  const voices = { "ナレーション": narrator };
  const used = new Set([narrator]);

  Object.keys(cast).forEach((name) => {
    const pool = pickVoicePool(cast[name]);
    const free = pool.find((v) => !used.has(v)) || pool[0];
    voices[name] = free;
    used.add(free);
  });
  return voices;
}

/* 録音の合計サイズ上限（APIに一度に送れる量の目安） */
const MAX_TOTAL_BYTES = 14 * 1024 * 1024; // 約14MB

/* キーは基本「ブラウザを閉じたら消える」。チェックを入れた時だけ端末に記憶 */
let geminiApiKey = localStorage.getItem("rms_api_key") || "";

function setApiKey(key, save) {
  geminiApiKey = key.trim();
  if (save) {
    localStorage.setItem("rms_api_key", geminiApiKey);
  } else {
    localStorage.removeItem("rms_api_key");
  }
}

function hasApiKey() {
  return geminiApiKey.length > 0;
}

function getSavedApiKey() {
  return localStorage.getItem("rms_api_key") || "";
}

/* 音声Blobを、APIに渡せる文字列（Base64）に変換する */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("音声データの変換に失敗しました。"));
    reader.readAsDataURL(blob);
  });
}

/* Gemini APIを呼ぶ共通関数。モデル候補を順に試し、結果の取り出し方は呼び出し側が渡す */
async function geminiRequest(models, body, pickResult) {
  let modelNotFound = false;

  for (const model of models) {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model + ":generateContent?key=" + encodeURIComponent(geminiApiKey);

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error("インターネットに接続できませんでした。電波の良いところで、もう一度お試しください。");
    }

    if (res.ok) {
      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw new Error("データの受信が途中で切れました。電波の良い場所で、もう一度お試しください。");
      }
      const result = pickResult(data);
      if (!result) {
        throw new Error("AIからの返事が空でした。もう一度お試しください。");
      }
      console.log("使用モデル:", model);
      return result;
    }

    // このモデルが存在しない場合だけ、次の候補へ
    if (res.status === 404) {
      modelNotFound = true;
      continue;
    }
    if (res.status === 400 || res.status === 403) {
      throw new Error("APIキーが正しくないようです。キーを確認して、もう一度入力してください。");
    }
    if (res.status === 429) {
      throw new Error("AIの利用回数が一時的に上限に達しました。1〜2分待ってからお試しください。");
    }
    throw new Error("AIサーバーでエラーが起きました（コード: " + res.status + "）。少し待ってからお試しください。");
  }

  if (modelNotFound) {
    throw new Error("利用できるAIモデルが見つかりませんでした。アプリの更新が必要かもしれません。");
  }
  throw new Error("AIの呼び出しに失敗しました。");
}

/* テキスト生成用の呼び出し（あらすじ・台本づくりで使う） */
function callGemini(parts) {
  return geminiRequest(GEMINI_MODELS, { contents: [{ parts }] }, (data) => {
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("");
    return text || null;
  });
}

/* ---------- ①録音リレーを「1つのあらすじ」に統合する ---------- */
async function integrateStory(takes) {
  const totalBytes = takes.reduce((sum, t) => sum + t.blob.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error("録音の合計が長すぎて、一度にAIへ送れません。各シーンを短めにして、もう一度収録してみてください。");
  }

  const parts = [{
    text:
      "あなたはラジオドラマの構成作家です。これから渡す音声は、家族や友人が1台のマイクを回しながら、即興でつないだリレー形式の物語です。\n" +
      "シーン番号の順番どおりに内容を聞き取り、以下の形式で日本語で出力してください。\n\n" +
      "# タイトル案\n（物語にぴったりのタイトルを1つ）\n\n" +
      "# あらすじ\n（全シーンのつじつまを自然に整えた、400〜600字の物語の骨組み。話者の名前は出さず、ひとつの物語として書く）\n\n" +
      "# 登場人物\n（名前または呼び名と、ひとこと説明の箇条書き）\n\n" +
      "注意: 聞き取りにくい部分は前後の流れから自然に補ってください。見出し以外にマークダウンの飾りは使わないでください。",
  }];

  for (let i = 0; i < takes.length; i++) {
    parts.push({ text: "--- シーン" + (i + 1) + " ---" });
    parts.push({
      inline_data: {
        mime_type: takes[i].blob.type || "audio/webm",
        data: await blobToBase64(takes[i].blob),
      },
    });
  }

  return callGemini(parts);
}

/* ---------- ③台本を、感情豊かな音声ドラマにする（TTS） ---------- */

/* 台本テキストから「配役表」と「話者ごとのかたまり」を取り出す */
function parseScript(script) {
  const castMatch = script.match(/【配役】([\s\S]*?)【台本】/);
  const bodyMatch = script.match(/【台本】([\s\S]*)/);
  if (!castMatch || !bodyMatch) return null;

  // 題名（なくても動くが、あればタイトルコールに使う）
  let title = "";
  const titleMatch = script.match(/【タイトル】([\s\S]*?)【/);
  if (titleMatch) title = (titleMatch[1].trim().split("\n")[0] || "").trim();

  const cast = {};
  castMatch[1].split("\n").map((l) => l.trim()).filter(Boolean).forEach((line) => {
    if (line.startsWith("ナレーション")) return;
    const parts = line.split(/[｜|]/);
    if (parts.length >= 2) cast[parts[0].trim()] = parts[1].trim();
  });

  const segments = [];
  bodyMatch[1].split("\n").forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    const pauseMatch = line.match(/^[（(]間(?:[・･]\s*(起|承|転|結))?[）)]$/);
    if (pauseMatch) {
      segments.push({ type: "pause", phase: pauseMatch[1] || null });
      return;
    }
    const m = line.match(/^(.+?)[：:](.*)$/);
    if (m && (m[1].trim() === "ナレーション" || cast[m[1].trim()] !== undefined)) {
      segments.push({ type: "line", speaker: m[1].trim(), text: m[2].trim() });
    } else if (segments.length && segments[segments.length - 1].type === "line") {
      // 話者名のない行は、直前のセリフ・ナレーションの続きとみなす
      segments[segments.length - 1].text += "\n" + line;
    }
  });

  // 同じ話者が連続するかたまりは1つにまとめる（API呼び出し回数の節約）
  const merged = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (seg.type === "line" && last && last.type === "line" && last.speaker === seg.speaker) {
      last.text += "\n" + seg.text;
    } else {
      merged.push(seg);
    }
  }

  if (merged.filter((s) => s.type === "line").length < 2) return null;
  return { title, cast, segments: merged };
}

/* 1かたまりぶんの読み上げ指示文をつくる */
function buildSegmentPrompt(seg, cast, genre) {
  if (seg.speaker === "ナレーション") {
    return (
      "これはジャンル「" + genre + "」のラジオドラマのナレーションです。" +
      "感情を抑えた、落ち着いた一定のトーンで、はっきりと読んでください。" +
      "（）内の文字は読み上げないでください。\n\n" + seg.text
    );
  }
  const desc = cast[seg.speaker] || "";
  return (
    "これはジャンル「" + genre + "」のラジオドラマのセリフです。" +
    "あなたは「" + seg.speaker + "」（" + desc + "）の役です。役になりきって、感情豊かに演じてください。" +
    "冒頭の（）内は演技指示なので、声に出さずに演技へ反映してください。\n\n" + seg.text
  );
}

/* TTSを1回呼ぶ。
   429（回数制限）のときは「1分あたりの上限」と「1日あたりの上限」を見分けて、
   前者なら待ってやりなおし、後者なら別モデルを試し、それでもダメなら正直に伝える */
async function ttsCall(text, voice, onWait) {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  };

  let sawRateLimit = false;  // 1分あたりの上限に当たった
  let sawDailyLimit = false; // 1日あたりの上限に当たった
  let quotaInfo = "";        // 直近の429の技術情報（原因特定用に画面へ出す）
  let emptyRetried = false;  // 「音声が空」のやりなおしを使ったか

  for (const model of GEMINI_TTS_MODELS) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        model + ":generateContent?key=" + encodeURIComponent(geminiApiKey);
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        // スマホの電波のゆらぎ等。少し待って自動でやりなおす
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        throw new Error("通信が途切れました。スマホの場合は画面をつけたまま、電波の良い場所でもう一度お試しください。");
      }

      if (res.ok) {
        let data;
        try {
          data = await res.json();
        } catch (e) {
          // 受信の途中で通信が切れた。少し待って自動でやりなおす
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 2500));
            continue;
          }
          throw new Error("音声データの受信が途中で切れました。スマホの場合は画面をつけたまま、電波の良い場所でもう一度お試しください。");
        }
        const part = (data.candidates?.[0]?.content?.parts || [])
          .find((p) => p.inlineData && p.inlineData.data);
        if (!part) {
          // AIは返事をしたのに、音声が入っていなかった。理由を調べて表示する
          console.error("音声なしの応答:", JSON.stringify(data).slice(0, 2000));
          if (!emptyRetried) {
            emptyRetried = true; // 一時的な不調かもしれないので、2秒おいて1回だけやりなおす
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          const cand = data.candidates?.[0];
          const reason = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || "";
          const aiText = ((cand?.content?.parts || []).map((p) => p.text || "").join("")).trim().slice(0, 150);
          throw new Error(
            "AIが音声を返しませんでした。" +
            (/SAFETY|PROHIBITED|BLOCK/i.test(reason)
              ? "台本の表現が安全フィルタに反応した可能性があります。「別のジャンルでおかわり」で台本を作り直すと通ることが多いです。"
              : "もう一度お試しください。") +
            (reason ? "\n〔理由コード: " + reason + "〕" : "") +
            (aiText ? "\n〔AIの返答: " + aiText + "〕" : "")
          );
        }
        const rateMatch = (part.inlineData.mimeType || "").match(/rate=(\d+)/);
        const bin = atob(part.inlineData.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { bytes, rate: rateMatch ? Number(rateMatch[1]) : 24000 };
      }
      if (res.status === 429) {
        sawRateLimit = true;
        // エラーの中身を読んで、上限の種類とおすすめの待ち時間を取り出す
        let detail = "";
        try { detail = JSON.stringify(await res.json()); } catch (e) { /* 読めなければ空のまま */ }
        console.error("429の詳細:", model, detail);
        const qm = detail.match(/"quotaMetric"\s*:\s*"([^"]+)"/);
        const qv = detail.match(/"quotaValue"\s*:\s*"?([0-9]+)"?/);
        quotaInfo = model
          + (qm ? "｜" + qm[1].split("/").pop() : "")
          + (qv ? "｜上限" + qv[1] : "");
        if (/PerDay|per.?day|daily/i.test(detail)) {
          sawDailyLimit = true;
          break; // このモデルは今日はもう無理。別モデルの枠を試す
        }
        let waitSec = 21;
        const m = detail.match(/retryDelay[^0-9]*(\d+)/);
        if (m) waitSec = Math.min(70, Number(m[1]) + 2);
        if (attempt < 3) {
          if (onWait) onWait();
          await new Promise((r) => setTimeout(r, waitSec * 1000));
        }
        continue;
      }
      if (res.status === 404) { break; } // このモデルは存在しない。次の候補へ
      if (res.status === 400 || res.status === 403) {
        throw new Error("APIキーが正しくないようです。キーを確認して、もう一度入力してください。");
      }
      throw new Error("AIサーバーでエラーが起きました（コード: " + res.status + "）。少し待ってからお試しください。");
    }
    // このモデルがダメでも、次の候補モデル（別の利用枠）を試す
  }

  const diag = quotaInfo ? "\n〔技術情報: " + quotaInfo + "〕" : "";
  if (sawDailyLimit) {
    throw new Error(
      "きょうの利用枠（1日あたりの音声生成回数）を使い切ったようです。" +
      "数分待っても回復しません。枠は毎日、日本時間の夕方ごろにリセットされます。" + diag
    );
  }
  if (sawRateLimit) {
    throw new Error(
      "音声AIの利用回数の上限にかかっています。" +
      "2〜3分おいて再度お試しください。何度も続く場合は、下の技術情報を開発パートナー（Claude）に伝えてください。" + diag
    );
  }
  throw new Error("利用できる音声AIモデルが見つかりませんでした。アプリの更新が必要かもしれません。");
}

/* 指定した秒数の「無音」データをつくる（間の演出に使う） */
function makeSilence(seconds, rate) {
  return new Uint8Array(Math.round(seconds * rate) * 2); // 16ビット=2バイト/サンプル
}

/* 収録ずみ音声の貯金箱。
   途中で失敗してもう一度ボタンを押したとき、
   成功していた部分は通信せずに一瞬で再利用できる */
const speechCache = new Map();

function cacheSet(key, audio) {
  if (speechCache.size > 120) speechCache.clear(); // ためこみすぎ防止
  speechCache.set(key, audio);
}

/* 1セグメントの収録。「AIが音声を返さない（OTHER等）」が続いたら、
   演技指示を外したシンプルな読み上げ方に切り替えて再挑戦する */
async function ttsSegmentWithFallback(seg, cast, genre, voice, onWait) {
  try {
    return await ttsCall(buildSegmentPrompt(seg, cast, genre), voice, onWait);
  } catch (err) {
    if (!/音声を返しませんでした/.test(err.message)) throw err;
    const plain = seg.text.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").trim();
    if (!plain) throw err;
    console.warn("シンプル読み上げで再挑戦:", seg.speaker);
    return await ttsCall("次の日本語の文章を、自然なトーンで読み上げてください。\n\n" + plain, voice, onWait);
  }
}

/* 本体：台本を解析し、役ごとに別の声で収録してつなぎ合わせる
   ecoMode=true のときは「節約モード」（1人語り・通信1回）で作る */
async function generateSpeech(script, genre, onProgress, ecoMode) {
  if (ecoMode) {
    return soloSpeech(script, genre, onProgress);
  }
  const parsed = parseScript(script);
  if (!parsed) {
    // 台本が想定の形式でなかったときの保険：従来の1人語り方式
    return soloSpeech(script, genre, onProgress);
  }

  const voices = assignVoices(parsed.cast, genre);
  console.log("配役と声の割り当て:", voices);

  const total = parsed.segments.filter((s) => s.type === "line").length;
  let done = 0;
  let rate = 24000;
  const chunks = [];
  const marks = [];   // 場面の変わり目（間）の位置（秒）。効果音のタイミングに使う
  let offsetSec = 0;  // いま音声の何秒目まで作ったか

  // まずタイトルコール：少し間 → 題名 → たっぷり間 → 本編
  if (parsed.title) {
    if (onProgress) onProgress("タイトルコールを収録中…");
    const titleKey = "TITLE|" + voices["ナレーション"] + "|" + parsed.title;
    let titleAudio = speechCache.get(titleKey);
    if (!titleAudio) {
      titleAudio = await ttsCall(
        "これはラジオドラマ番組の冒頭のタイトルコールです。次の題名だけを、ゆっくり、印象的に読み上げてください。\n\n" +
        "『" + parsed.title + "』",
        voices["ナレーション"],
        () => { if (onProgress) onProgress("AIが混み合っています。順番待ち中…"); }
      );
      cacheSet(titleKey, titleAudio);
    }
    rate = titleAudio.rate;
    chunks.push(makeSilence(0.8, rate));
    offsetSec += 0.8;
    chunks.push(titleAudio.bytes);
    offsetSec += titleAudio.bytes.length / (rate * 2);
    chunks.push(makeSilence(1.6, rate));
    offsetSec += 1.6;
  }

  for (const seg of parsed.segments) {
    if (seg.type === "pause") {
      marks.push({ at: offsetSec, phase: seg.phase || null }); // 位置と起承転結タグ
      chunks.push(makeSilence(1.4, rate)); // 場面の変わり目はたっぷりめの間
      offsetSec += 1.4;
      continue;
    }
    const voice = voices[seg.speaker] || voices["ナレーション"];
    const cacheKey = voice + "|" + seg.speaker + "|" + seg.text;
    let audio = speechCache.get(cacheKey);
    if (!audio) {
      audio = await ttsSegmentWithFallback(
        seg, parsed.cast, genre, voice,
        () => { if (onProgress) onProgress("AIが混み合っています。順番待ち中…（" + done + "/" + total + " 収録済み）"); }
      );
      cacheSet(cacheKey, audio);
    }
    rate = audio.rate;
    chunks.push(audio.bytes);
    offsetSec += audio.bytes.length / (rate * 2);
    chunks.push(makeSilence(0.6, rate)); // 話者の切り替わりにひと呼吸の間
    offsetSec += 0.6;
    done++;
    if (onProgress) onProgress("声優AIが収録中… " + done + "/" + total);
  }

  // 全部の音をひとつにつなげて、WAVと効果音タイミング表を返す
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const joined = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { joined.set(c, offset); offset += c.length; }
  return { blob: pcmBytesToWavBlob(joined, rate), marks, title: parsed.title || "" };
}

/* 節約モード：台本全体を1人の声優が通しで演じる（通信1回・利用枠ひかえめ） */
async function soloSpeech(script, genre, onProgress) {
  if (onProgress) onProgress("1人語りの声優AIが熱演中…（節約モード）");

  const cacheKey = "SOLO|" + genre + "|" + script;
  const cached = speechCache.get(cacheKey);
  if (cached) return cached;

  const voice = GENRE_VOICES[genre] || "Puck";
  const prompt =
    "あなたはプロの声優です。次のラジオドラマ台本を、ジャンル「" + genre + "」の雰囲気たっぷりに、" +
    "ナレーションと登場人物を声色を変えて感情豊かに演じ分けながら、日本語で読み上げてください。\n" +
    "- まず【タイトル】の題名だけをタイトルコールとしてゆっくり読み、ひと呼吸おいてから本編を読む\n" +
    "- 【配役】の一覧は読み上げない\n" +
    "- 「（間・転）」「（間）」のような行は読み上げず、ひと呼吸の間を置く\n" +
    "- 括弧書きの演技指示は読み上げず、直後のセリフ1つだけに反映する\n" +
    "- ナレーションは終始、落ち着いた一定のトーンで読む\n" +
    "- 「ナレーション：」「〇〇：」のような話者名は読み上げない\n\n" + script;

  const audio = await ttsCall(prompt, voice, () => {
    if (onProgress) onProgress("AIが混み合っています。順番待ち中…");
  });

  const parsed = parseScript(script); // タイトル表示用（読み取れなくてもOK）
  const result = {
    blob: pcmBytesToWavBlob(audio.bytes, audio.rate),
    marks: [],
    title: (parsed && parsed.title) || "",
  };
  cacheSet(cacheKey, result);
  return result;
}

/* 生のPCMデータに44バイトのWAVヘッダーを付けて、再生可能なBlobにする */
function pcmBytesToWavBlob(bytes, sampleRate) {
  const len = bytes.length;
  const buf = new ArrayBuffer(44 + len);
  const v = new DataView(buf);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  v.setUint32(4, 36 + len, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);          // fmtチャンクのサイズ
  v.setUint16(20, 1, true);           // PCM形式
  v.setUint16(22, 1, true);           // モノラル
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // 1秒あたりのバイト数
  v.setUint16(32, 2, true);           // 1サンプルのバイト数
  v.setUint16(34, 16, true);          // 16ビット
  writeStr(36, "data");
  v.setUint32(40, len, true);
  new Uint8Array(buf, 44).set(bytes);

  return new Blob([buf], { type: "audio/wav" });
}

/* ---------- ②あらすじを、選んだジャンルの台本に仕立てる ---------- */
async function generateScript(outline, genre) {
  const parts = [{
    text:
      "あなたはベテランの放送作家です。以下の物語のあらすじを、ジャンル「" + genre + "」の約5分のラジオドラマ台本（日本語、2000〜2600字程度）に仕立ててください。\n" +
      "出力は必ず次の形式にしてください。\n\n" +
      "【タイトル】\n" +
      "この物語にぴったりの印象的な題名を、ジャンルの雰囲気を込めて15文字以内で1つ\n\n" +
      "【配役】\n" +
      "ナレーション\n" +
      "登場人物名｜性別・年代 …を1行に1人ずつ（例：タクヤ｜男性・大人　ハナ｜女性・子ども　権造じいさん｜男性・老人）\n\n" +
      "【台本】\n" +
      "ここから台本。1行ごとに「話者名：本文」の形式で書く\n\n" +
      "ルール：\n" +
      "- 話者名は「ナレーション」か、【配役】に書いた名前だけを使う\n" +
      "- 登場人物は4人以内にする\n" +
      "- ナレーション（ト書き・説明）とセリフは必ず別の行にし、行間に空行を1行入れる\n" +
      "- セリフの冒頭に演技指示を（）で入れる（例：（ささやき声で））。演技指示はその直後のセリフ1つだけにかかる。ナレーション行には付けない\n" +
      "- 場面の変わり目には「（間・承）」のように、物語がその先どの段階に入るかを起承転結で示した行だけを入れる（例：（間・承）（間・転）（間・結））。「転」はいちばん盛り上がる場面の手前に、「結」は締めくくりの手前に置く\n" +
      "- 話者の切り替わり（ナレーション⇄セリフ、セリフ⇄セリフ）は物語全体で25回以内に収める\n" +
      "- 見出しやマークダウンの記号（#や*）は使わない\n" +
      "- ジャンル「" + genre + "」の雰囲気を全力で出す\n" +
      "- 元のあらすじの出来事はできるだけ活かす\n" +
      "- 最後はきれいにオチをつける\n\n" +
      "【あらすじ】\n" + outline,
  }];

  return callGemini(parts);
}
