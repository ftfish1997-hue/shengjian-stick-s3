import { createWavBlob } from "./wav.js";
import { recordings, cloudRecords, openDatabase } from "./db.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const TIMER_KEY = "sticks3-pomodoro-v1";
const DEVICE_ID = "iphone-16-pro-simulator";
const MAX_RECORDING_SECONDS = 60;
const MAX_QUEUE_BYTES = 6 * 1024 * 1024;

const state = {
  recording: false,
  recordingKind: "voice_record",
  audioContext: null,
  mediaStream: null,
  sourceNode: null,
  processorNode: null,
  chunks: [],
  recordingStartedAt: 0,
  recordingClock: null,
  objectUrls: [],
  forceOffline: false,
  selectedFocusSeconds: 1500,
  focusClock: null,
  toastClock: null,
};

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(state.toastClock);
  state.toastClock = setTimeout(() => toast.classList.remove("show"), 2800);
}

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function shortId(value) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", month: "numeric", day: "numeric" }).format(new Date(value));
}

function isEffectivelyOnline() {
  return navigator.onLine && !state.forceOffline;
}

function renderNetwork() {
  const online = isEffectivelyOnline();
  $("#network-pill").classList.toggle("offline", !online);
  $("#network-label").textContent = online ? "在线" : "模拟离线";
}

function currentSessionId() {
  const timer = loadTimer();
  return timer && ["running", "paused"].includes(timer.status) ? timer.session_id : null;
}

async function beginRecording(kind = "voice_record") {
  if (state.recording) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showToast("麦克风需要 HTTPS 安全连接");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass({ latencyHint: "interactive" });
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    processor.onaudioprocess = (event) => {
      if (state.recording) chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(context.destination);

    Object.assign(state, {
      recording: true,
      recordingKind: kind,
      audioContext: context,
      mediaStream: stream,
      sourceNode: source,
      processorNode: processor,
      chunks,
      recordingStartedAt: performance.now(),
    });
    setRecordingUi(true, kind);
    state.recordingClock = setInterval(updateRecordingClock, 200);
  } catch (error) {
    showToast(error.name === "NotAllowedError" ? "请在 Safari 设置中允许麦克风权限" : `无法开始录音：${error.message}`);
  }
}

function updateRecordingClock() {
  const elapsed = (performance.now() - state.recordingStartedAt) / 1000;
  $("#record-timer").textContent = formatClock(elapsed);
  if (elapsed >= MAX_RECORDING_SECONDS) {
    showToast("已达到 60 秒录音上限，正在保存");
    stopRecording();
  }
}

function setRecordingUi(recording, kind = "voice_record") {
  $("#record-button").classList.toggle("recording", recording && kind === "voice_record");
  $("#record-button").setAttribute("aria-label", recording ? "停止录音" : "开始录音");
  $("#note-button").classList.toggle("is-recording", recording && kind === "pomodoro_note");
  if (recording && kind === "pomodoro_note") {
    $("#note-button").disabled = false;
    $("#note-button strong").textContent = "停止并保存备注";
    $("#note-button small").textContent = "正在录音，轻点后安全落盘";
  } else {
    $("#note-button strong").textContent = "录制专注备注";
    $("#note-button small").textContent = "自动关联当前 session_id";
  }
  $("#record-title").textContent = recording ? "正在录音" : "想到什么，就录下来";
  $("#record-hint").textContent = recording ? "再次轻点即可停止并安全保存。" : "录音会先保存在这台 iPhone，再尝试同步。";
}

async function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  clearInterval(state.recordingClock);
  const inputSampleRate = state.audioContext.sampleRate;
  state.processorNode?.disconnect();
  state.sourceNode?.disconnect();
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  await state.audioContext?.close();

  const { blob, durationSeconds } = createWavBlob(state.chunks, inputSampleRate, MAX_RECORDING_SECONDS);
  const eventId = crypto.randomUUID();
  const sessionId = state.recordingKind === "pomodoro_note" ? currentSessionId() : null;
  const capturedAt = new Date().toISOString();
  const record = {
    event_id: eventId,
    device_id: DEVICE_ID,
    captured_at: capturedAt,
    created_at: capturedAt,
    kind: state.recordingKind,
    session_id: sessionId,
    queue_status: "pending",
    retry_count: 0,
    duration_seconds: durationSeconds,
    byte_length: blob.size,
    mime_type: "audio/wav",
    sample_rate_hz: 16_000,
    bits_per_sample: 16,
    channels: 1,
    firmware_version: "mobile-simulator-0.1.0",
    schema_version: 1,
    audio: blob,
  };

  try {
    const queue = await recordings.getAll();
    const bytesUsed = queue.reduce((total, item) => total + item.byte_length, 0);
    if (bytesUsed + blob.size > MAX_QUEUE_BYTES) throw new Error("LOCAL_QUEUE_FULL");
    await recordings.put(record);
    showToast(`已安全保存 ${durationSeconds.toFixed(1)} 秒录音`);
    await renderQueue();
    if (state.recordingKind === "pomodoro_note") switchView("voice-view");
  } catch (error) {
    showToast(`本地保存失败：${error.message}`);
  } finally {
    setRecordingUi(false);
    $("#record-timer").textContent = "00:00";
    Object.assign(state, { chunks: [], mediaStream: null, audioContext: null, processorNode: null, sourceNode: null });
  }
}

async function toggleRecording(kind) {
  if (state.recording) return stopRecording();
  return beginRecording(kind);
}

function freeObjectUrls() {
  state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.objectUrls = [];
}

async function renderQueue() {
  const items = await recordings.getAll();
  const list = $("#queue-list");
  freeObjectUrls();
  list.replaceChildren();
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "record-item";
    const objectUrl = URL.createObjectURL(item.audio);
    state.objectUrls.push(objectUrl);
    const title = item.kind === "pomodoro_note" ? "专注语音备注" : "语音记录";
    card.innerHTML = `
      <div class="record-row">
        <div><h3 class="record-name">${title}</h3><p class="record-meta">${formatDate(item.created_at)} · ${item.duration_seconds.toFixed(1)} 秒 · ${(item.byte_length / 1024).toFixed(1)} KB<span class="record-id">${shortId(item.event_id)}</span></p></div>
        <span class="kind-badge">${item.queue_status === "pending" ? "待同步" : "重试中"}</span>
      </div>
      <audio controls preload="metadata" src="${objectUrl}"></audio>`;
    list.append(card);
  }
  $("#queue-count").textContent = String(items.length);
  $("#queue-empty").hidden = items.length > 0;
  $("#sync-button").disabled = items.length === 0;
  $("#sync-detail").textContent = items.length ? `${items.length} 条等待确认` : "没有待同步录音";
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fakeUpload(item) {
  let cloud = await cloudRecords.get(item.event_id);
  const duplicate = Boolean(cloud);
  if (!cloud) {
    cloud = {
      event_id: item.event_id,
      record_id: crypto.randomUUID(),
      device_id: item.device_id,
      kind: item.kind,
      session_id: item.session_id,
      created_at: item.created_at,
      status: "uploaded",
      raw_text: "",
      record_type: "inbox",
    };
    await cloudRecords.put(cloud);
  }

  if ($("#drop-response").checked) {
    $("#drop-response").checked = false;
    throw new Error("RESPONSE_LOST");
  }

  return {
    success: true,
    event_id: $("#wrong-ack").checked ? "00000000-0000-0000-0000-000000000000" : item.event_id,
    record_id: cloud.record_id,
    status: "accepted",
    duplicate,
  };
}

async function advancePipeline(eventId) {
  const record = await cloudRecords.get(eventId);
  if (!record || record.status === "notion_synced") return;
  const stages = [
    ["transcribed", "这是一条来自 iPhone 的语音记录。真实转写将在 OpenAI API 获得授权后接入。"],
    ["structured", null],
    ["notion_synced", null],
  ];
  for (const [status, rawText] of stages) {
    await sleep(220);
    record.status = status;
    if (rawText) record.raw_text = rawText;
    if (status === "structured") record.record_type = record.kind === "pomodoro_note" ? "pomodoro" : "inbox";
    await cloudRecords.put(record);
    await renderHistory();
  }
}

async function syncAll() {
  if (!isEffectivelyOnline()) {
    showToast("当前离线，录音仍安全保存在本机");
    return;
  }
  const button = $("#sync-button");
  button.disabled = true;
  const items = await recordings.getAll();
  let uploaded = 0;
  for (const original of items) {
    const item = { ...original, queue_status: "uploading", retry_count: original.retry_count + 1 };
    await recordings.put(item);
    await renderQueue();
    try {
      const acknowledgement = await fakeUpload(item);
      if (acknowledgement.event_id !== item.event_id || !acknowledgement.record_id) {
        throw new Error("ACK_MISMATCH");
      }
      await recordings.delete(item.event_id);
      uploaded += 1;
      await renderQueue();
      await renderHistory();
      await advancePipeline(item.event_id);
    } catch (error) {
      await recordings.put({ ...item, queue_status: "pending", last_error: error.message });
      await renderQueue();
      if (error.message === "RESPONSE_LOST") showToast("已模拟响应丢失；记录保留，重试将幂等去重");
      else if (error.message === "ACK_MISMATCH") showToast("确认 event_id 不匹配；本地录音未删除");
      else showToast(`同步失败：${error.message}`);
    }
  }
  $("#wrong-ack").checked = false;
  await renderHistory();
  if (uploaded) showToast(`已确认并处理 ${uploaded} 条录音`);
}

function pipelineIndex(status) {
  return ["uploaded", "transcribed", "structured", "notion_synced"].indexOf(status);
}

async function renderHistory() {
  const items = await cloudRecords.getAll();
  const list = $("#history-list");
  list.replaceChildren();
  const labels = ["已入库", "已转写", "已结构化", "Notion 模拟"];
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "history-item";
    const progress = pipelineIndex(item.status);
    card.innerHTML = `
      <div class="history-top"><h3>${item.kind === "pomodoro_note" ? "专注备注" : "语音记录"}</h3><span class="history-time">${formatDate(item.created_at)}</span></div>
      <div class="transcript">${item.raw_text || "等待模拟转写…"}</div>
      <div class="pipeline">${labels.map((label, index) => `<span class="pipe-step ${index <= progress ? "done" : ""}">${label}</span>`).join("")}</div>`;
    list.append(card);
  }
  $("#cloud-count").textContent = String(items.length);
  $("#history-empty").hidden = items.length > 0;
}

function loadTimer() {
  try { return JSON.parse(localStorage.getItem(TIMER_KEY)); } catch { return null; }
}

function saveTimer(timer) {
  localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
  renderTimer();
}

function timerRemaining(timer) {
  if (!timer) return state.selectedFocusSeconds;
  if (timer.status === "paused") return timer.remaining_seconds;
  if (timer.status === "running") return Math.max(0, Math.ceil((timer.ends_at - Date.now()) / 1000));
  return timer.remaining_seconds ?? timer.planned_seconds;
}

function renderTimer() {
  let timer = loadTimer();
  if (timer?.status === "running" && timerRemaining(timer) <= 0) {
    timer = { ...timer, status: "completed", remaining_seconds: 0, completed_at: new Date().toISOString() };
    localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
    showToast("这一轮专注完成了");
  }
  const status = timer?.status || "ready";
  const remaining = ["running", "paused"].includes(status) ? timerRemaining(timer) : state.selectedFocusSeconds;
  $("#focus-time").textContent = formatClock(remaining);
  $("#focus-status").textContent = ({
    ready: "准备开始一段专注",
    running: "保持专注，想法可以随时录下",
    paused: "专注已暂停",
    completed: "本轮专注已完成",
    interrupted_reboot: "设备重启，本轮已标记中断",
  })[status];
  $("#focus-main").textContent = status === "running" ? "暂停" : status === "paused" ? "继续" : "开始专注";
  $("#note-button").disabled = !["running", "paused"].includes(status) || (state.recording && state.recordingKind !== "pomodoro_note");
  $$(".preset").forEach((button) => { button.disabled = ["running", "paused"].includes(status); });
}

function focusMainAction() {
  const timer = loadTimer();
  if (timer?.status === "running") {
    saveTimer({ ...timer, status: "paused", remaining_seconds: timerRemaining(timer), paused_at: new Date().toISOString() });
  } else if (timer?.status === "paused") {
    saveTimer({ ...timer, status: "running", ends_at: Date.now() + timer.remaining_seconds * 1000, resumed_at: new Date().toISOString() });
  } else {
    const now = Date.now();
    saveTimer({ session_id: crypto.randomUUID(), status: "running", planned_seconds: state.selectedFocusSeconds, remaining_seconds: state.selectedFocusSeconds, started_at: new Date(now).toISOString(), ends_at: now + state.selectedFocusSeconds * 1000 });
  }
}

function resetTimer() {
  localStorage.removeItem(TIMER_KEY);
  renderTimer();
  showToast("番茄钟已重置");
}

function simulateReboot() {
  const timer = loadTimer();
  if (!timer || !["running", "paused"].includes(timer.status)) {
    showToast("当前没有进行中的番茄钟");
    return;
  }
  saveTimer({ ...timer, status: "interrupted_reboot", remaining_seconds: timerRemaining(timer), interruption_reason: "interrupted_reboot" });
  showToast("已按固件规则标记为 interrupted_reboot");
}

function switchView(viewId) {
  $$(".view").forEach((view) => { view.hidden = view.id !== viewId; view.classList.toggle("active", view.id === viewId); });
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === viewId));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function updateStorageState() {
  if (!navigator.storage?.estimate) {
    $("#storage-state").textContent = "浏览器管理";
    return;
  }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  $("#storage-state").textContent = quota ? `${(usage / 1024 / 1024).toFixed(1)} / ${(quota / 1024 / 1024).toFixed(0)} MB` : "可用";
}

async function requestPersistence() {
  if (!navigator.storage?.persist) {
    showToast("当前 Safari 不提供持久存储请求接口");
    return;
  }
  const granted = await navigator.storage.persist();
  showToast(granted ? "浏览器已允许持久保留离线数据" : "浏览器将按系统策略管理离线数据");
}

function showCompatibility() {
  const banner = $("#compatibility-banner");
  if (!window.isSecureContext) {
    banner.hidden = false;
    $("#secure-state").textContent = "需要 HTTPS";
  } else if (!navigator.mediaDevices?.getUserMedia) {
    banner.hidden = false;
    $("#compatibility-title").textContent = "浏览器不支持录音";
    $("#compatibility-copy").textContent = "请使用最新版 Safari 打开此页面。";
    $("#secure-state").textContent = "不支持录音";
  } else {
    banner.hidden = true;
    $("#secure-state").textContent = "HTTPS 就绪";
  }
}

function bindEvents() {
  $("#record-button").addEventListener("click", () => toggleRecording("voice_record"));
  $("#note-button").addEventListener("click", () => toggleRecording("pomodoro_note"));
  $("#sync-button").addEventListener("click", syncAll);
  $("#network-pill").addEventListener("click", () => { state.forceOffline = !state.forceOffline; renderNetwork(); showToast(state.forceOffline ? "已进入模拟离线模式" : "已恢复模拟网络"); });
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$(".preset").forEach((button) => button.addEventListener("click", () => {
    state.selectedFocusSeconds = Number(button.dataset.seconds);
    $$(".preset").forEach((item) => item.classList.toggle("active", item === button));
    renderTimer();
  }));
  $("#focus-main").addEventListener("click", focusMainAction);
  $("#focus-reset").addEventListener("click", resetTimer);
  $("#reboot-button").addEventListener("click", simulateReboot);
  $("#persist-button").addEventListener("click", requestPersistence);
  window.addEventListener("online", renderNetwork);
  window.addEventListener("offline", renderNetwork);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { renderTimer(); renderQueue(); renderHistory(); } });
}

async function initialize() {
  bindEvents();
  showCompatibility();
  renderNetwork();
  try {
    await openDatabase();
    await Promise.all([renderQueue(), renderHistory(), updateStorageState()]);
  } catch (error) {
    showToast(`无法打开本地队列：${error.message}`);
  }
  renderTimer();
  state.focusClock = setInterval(renderTimer, 500);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

initialize();
