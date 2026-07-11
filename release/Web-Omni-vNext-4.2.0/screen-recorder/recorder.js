(function() {
  "use strict";

  const PORT_NAME = "wo-screen-recorder";
  const STORAGE_KEY = "woRecorderPrefs";
  const COMMAND_TYPE = "WO_RECORDER_COMMAND";
  const DEFAULT_PREFIX = "web-omni-recording";
  const MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

  const els = {
    statusPill: document.getElementById("statusPill"),
    filenamePrefix: document.getElementById("filenamePrefix"),
    microphoneToggle: document.getElementById("microphoneToggle"),
    filenamePreview: document.getElementById("filenamePreview"),
    startBtn: document.getElementById("startBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    stopBtn: document.getElementById("stopBtn"),
    timerValue: document.getElementById("timerValue"),
    audioValue: document.getElementById("audioValue"),
    captureHint: document.getElementById("captureHint"),
    stayOpenNotice: document.getElementById("stayOpenNotice"),
    noticeBox: document.getElementById("noticeBox"),
    previewVideo: document.getElementById("previewVideo"),
    previewEmpty: document.getElementById("previewEmpty"),
    sessionSummary: document.getElementById("sessionSummary"),
    focusExistingBtn: document.getElementById("focusExistingBtn"),
  };

  let port = null;
  let readOnlyMode = false;
  let environmentSupported = true;
  let isUnloading = false;
  let sessionState = createIdleState();
  let mediaRecorder = null;
  let displayStream = null;
  let recordingStream = null;
  let microphoneStream = null;
  let mixedAudioContext = null;
  let timerId = null;
  let previewUrl = null;
  let chunks = [];
  let bufferedBytes = 0;
  let outputFileHandle = null;
  let outputWriter = null;
  let outputWriteChain = Promise.resolve();
  let outputWriteError = null;
  let audioSummary = "未开始";
  let activeNotice = { message: "", level: "info" };

  bindEvents();
  connectPort();
  loadPrefs().finally(() => {
    validateEnvironment();
    updateFilenamePreview();
    updateUI();
  });

  function bindEvents() {
    els.startBtn.addEventListener("click", startRecording);
    els.pauseBtn.addEventListener("click", togglePause);
    els.stopBtn.addEventListener("click", () => stopRecording("manual-stop"));
    els.focusExistingBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: COMMAND_TYPE, command: "OPEN_RECORDER" }, () => {});
    });

    els.filenamePrefix.addEventListener("input", () => {
      updateFilenamePreview();
      persistPrefs();
    });
    els.microphoneToggle.addEventListener("change", () => {
      persistPrefs();
      updateUI();
    });

    window.addEventListener("beforeunload", (event) => {
      if (sessionState.status === "idle") return;
      event.preventDefault();
      event.returnValue = "";
    });

    window.addEventListener("pagehide", () => {
      isUnloading = true;
      abortOutputWriter();
      cleanupMedia({ preservePlayback: true });
    });
  }

  function connectPort() {
    port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (!isUnloading) {
        setNotice("录制器连接已断开，请重新打开录屏页。", "error");
        readOnlyMode = true;
        els.focusExistingBtn.hidden = false;
        updateUI();
      }
    });
  }

  function handlePortMessage(message) {
    if (!message) return;

    if (message.type === "STATE_SYNC") {
      readOnlyMode = Boolean(message.readOnly);
      sessionState = normalizeState(message.state);
      if (readOnlyMode) {
        setNotice("已有录制页正在控制当前会话，请返回原录制器操作。", "info");
        els.focusExistingBtn.hidden = false;
      } else if (activeNotice.message === "已有录制页正在控制当前会话，请返回原录制器操作。") {
        clearNotice();
      }
      updateUI();
      return;
    }

    if (message.type === "COMMAND") {
      if (message.command === "TOGGLE_PAUSE") {
        togglePause();
      } else if (message.command === "STOP") {
        stopRecording("remote-stop");
      }
    }
  }

  async function loadPrefs() {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY]);
      const prefs = stored[STORAGE_KEY] || {};
      els.filenamePrefix.value = sanitizePrefix(prefs.filenamePrefix || DEFAULT_PREFIX);
      els.microphoneToggle.checked = Boolean(prefs.microphoneEnabled);
    } catch (error) {
      setNotice("读取录屏设置失败，已使用默认配置。", "info");
      els.filenamePrefix.value = DEFAULT_PREFIX;
    }
  }

  function persistPrefs() {
    const prefs = {
      filenamePrefix: getFilenamePrefix(),
      microphoneEnabled: els.microphoneToggle.checked,
    };
    chrome.storage.local.set({ [STORAGE_KEY]: prefs });
  }

  function validateEnvironment() {
    environmentSupported = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      environmentSupported = false;
      setNotice("当前浏览器环境不支持 getDisplayMedia，无法使用录屏功能。", "error");
      els.startBtn.disabled = true;
    } else if (typeof MediaRecorder === "undefined") {
      environmentSupported = false;
      setNotice("当前浏览器环境不支持 MediaRecorder，无法导出录制结果。", "error");
      els.startBtn.disabled = true;
    }
  }

  async function startRecording() {
    if (readOnlyMode || mediaRecorder || sessionState.status !== "idle") return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || typeof MediaRecorder === "undefined") {
      validateEnvironment();
      return;
    }

    clearNotice();
    persistPrefs();

    const startedAt = Date.now();
    const filename = buildFilename(startedAt);
    const wantsMicrophone = els.microphoneToggle.checked;

    try {
      outputFileHandle = await chooseOutputFile(filename);
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });

      bindDisplayStop(displayStream);

      const prepared = await buildRecordingStream(displayStream, wantsMicrophone);
      recordingStream = prepared.stream;
      microphoneStream = prepared.microphoneStream;
      mixedAudioContext = prepared.audioContext;
      audioSummary = prepared.label;
      chunks = [];
      bufferedBytes = 0;
      outputWriter = null;
      outputWriteChain = Promise.resolve();
      outputWriteError = null;

      const options = getRecorderOptions();
      mediaRecorder = options ? new MediaRecorder(recordingStream, options) : new MediaRecorder(recordingStream);

      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (!event.data || event.data.size <= 0) return;
        if (outputFileHandle) {
          outputWriteChain = outputWriteChain.then(async () => {
            if (!outputWriter) outputWriter = await outputFileHandle.createWritable();
            await outputWriter.write(event.data);
          }).catch((error) => {
            outputWriteError = error;
            setNotice("写入录制文件失败，录制将停止：" + readableError(error), "error");
            stopRecording("write-error");
          });
          return;
        }

        bufferedBytes += event.data.size;
        chunks.push(event.data);
        if (bufferedBytes >= MEMORY_LIMIT_BYTES) {
          setNotice("内存录制已达到 512 MiB 上限，正在自动停止并保存。", "info");
          stopRecording("memory-limit");
        }
      });

      mediaRecorder.addEventListener("stop", () => {
        finalizeRecording(filename).catch((error) => {
          setNotice("保存录制结果失败：" + readableError(error), "error");
          cleanupMedia({ preservePlayback: false });
        });
      }, { once: true });

      mediaRecorder.addEventListener("error", () => {
        setNotice("录制过程中发生错误，录制已停止。", "error");
      });

      mediaRecorder.start(1000);
      showLivePreview(displayStream);

      sessionState = normalizeState({
        status: "recording",
        startedAt,
        pauseStartedAt: null,
        pausedDurationMs: 0,
        microphoneEnabled: wantsMicrophone,
        filename,
      });
      syncState();

      setNotice("系统共享已开始。你可以在任意网页上通过悬浮条暂停、继续或停止。", "success");
    } catch (error) {
      cleanupMedia({ preservePlayback: false });
      sessionState = createIdleState();
      audioSummary = "未开始";
      syncState();

      const message = error && error.name === "NotAllowedError"
        ? "你取消了共享选择，录制未开始。"
        : "开始录制失败：" + readableError(error);
      setNotice(message, "error");
      outputFileHandle = null;
    }

    updateUI();
  }

  function bindDisplayStop(stream) {
    const handleEnded = () => {
      if (sessionState.status === "idle") return;
      setNotice("系统共享已结束，录制已自动停止。", "info");
      stopRecording("capture-ended");
    };

    stream.getVideoTracks().forEach((track) => track.addEventListener("ended", handleEnded, { once: true }));
  }

  async function buildRecordingStream(captureStream, wantsMicrophone) {
    const videoTracks = captureStream.getVideoTracks();
    const systemAudioTracks = captureStream.getAudioTracks();
    let audioContext = null;
    let micStream = null;
    const labels = [];

    if (systemAudioTracks.length > 0) labels.push("系统音频");

    if (wantsMicrophone) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (micStream.getAudioTracks().length > 0) labels.push("麦克风");
      } catch (error) {
        setNotice("麦克风未启用，已继续录制其余可用音频。", "info");
      }
    }

    const hasSystemAudio = systemAudioTracks.length > 0;
    const hasMicAudio = Boolean(micStream && micStream.getAudioTracks().length > 0);

    if (hasSystemAudio && !hasMicAudio) {
      return {
        stream: new MediaStream([...videoTracks, ...systemAudioTracks]),
        microphoneStream: micStream,
        audioContext: null,
        label: "系统音频",
      };
    }

    if (!hasSystemAudio && !hasMicAudio) {
      return {
        stream: new MediaStream([...videoTracks]),
        microphoneStream: micStream,
        audioContext: null,
        label: "无音频",
      };
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const destination = audioContext.createMediaStreamDestination();

    if (hasSystemAudio) {
      const systemSource = audioContext.createMediaStreamSource(new MediaStream(systemAudioTracks));
      const systemGain = audioContext.createGain();
      systemGain.gain.value = 1;
      systemSource.connect(systemGain).connect(destination);
    }

    if (hasMicAudio) {
      const microphoneSource = audioContext.createMediaStreamSource(new MediaStream(micStream.getAudioTracks()));
      const microphoneGain = audioContext.createGain();
      microphoneGain.gain.value = 1;
      microphoneSource.connect(microphoneGain).connect(destination);
    }

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const mixedAudioTracks = destination.stream.getAudioTracks();
    return {
      stream: new MediaStream([...videoTracks, ...mixedAudioTracks]),
      microphoneStream: micStream,
      audioContext,
      label: labels.join(" + ") || "无音频",
    };
  }

  function getRecorderOptions() {
    const preferred = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];

    for (const mimeType of preferred) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return { mimeType };
      }
    }

    return null;
  }

  function togglePause() {
    if (readOnlyMode || !mediaRecorder) return;

    if (mediaRecorder.state === "recording") {
      try {
        mediaRecorder.pause();
        sessionState = normalizeState({
          ...sessionState,
          status: "paused",
          pauseStartedAt: Date.now(),
        });
        syncState();
        setNotice("录制已暂停。", "info");
      } catch (error) {
        setNotice("暂停录制失败：" + readableError(error), "error");
      }
    } else if (mediaRecorder.state === "paused") {
      try {
        mediaRecorder.resume();
        const pausedSpan = sessionState.pauseStartedAt ? Date.now() - sessionState.pauseStartedAt : 0;
        sessionState = normalizeState({
          ...sessionState,
          status: "recording",
          pauseStartedAt: null,
          pausedDurationMs: (sessionState.pausedDurationMs || 0) + pausedSpan,
        });
        syncState();
        setNotice("录制已继续。", "success");
      } catch (error) {
        setNotice("继续录制失败：" + readableError(error), "error");
      }
    }

    updateUI();
  }

  function stopRecording(reason) {
    if (!mediaRecorder) {
      cleanupMedia({ preservePlayback: true });
      sessionState = createIdleState();
      audioSummary = "未开始";
      syncState();
      updateUI();
      return;
    }

    const recorder = mediaRecorder;
    mediaRecorder = null;

    if (reason === "remote-stop" && activeNotice.message.indexOf("已自动停止") === -1) {
      setNotice("录制已从网页悬浮条停止。", "info");
    }

    if (recorder.state !== "inactive") {
      recorder.stop();
    } else {
      finalizeRecording(sessionState.filename || buildFilename()).catch((error) => {
        setNotice("保存录制结果失败：" + readableError(error), "error");
      });
    }

    updateUI();
  }

  async function finalizeRecording(filename) {
    if (outputFileHandle) {
      await outputWriteChain;
      if (outputWriter) {
        await outputWriter.close();
        outputWriter = null;
      }
      if (outputWriteError) throw outputWriteError;
      const file = await outputFileHandle.getFile();
      if (file.size > 0) {
        showPlayback(file);
        if (activeNotice.level !== "error") setNotice("录屏已写入 " + filename, "success");
      } else if (activeNotice.level !== "error") {
        setNotice("录制未生成可保存的数据。", "error");
      }
      outputFileHandle = null;
      finishRecordingState(file.size > 0);
      return;
    }

    const mimeType = chunks.length > 0 && chunks[0].type ? chunks[0].type : "video/webm";
    const blob = new Blob(chunks, { type: mimeType });
    const hasData = blob.size > 0;

    if (hasData) {
      showPlayback(blob);
      downloadBlob(blob, filename);
      if (activeNotice.level !== "error") {
        setNotice("录屏已保存为 " + filename, "success");
      }
    } else if (activeNotice.level !== "error") {
      setNotice("录制未生成可下载的数据。", "error");
      clearPreview();
    }

    finishRecordingState(hasData);
  }

  function finishRecordingState(hasData) {
    cleanupMedia({ preservePlayback: hasData });
    chunks = [];
    bufferedBytes = 0;
    outputWriteChain = Promise.resolve();
    outputWriteError = null;
    audioSummary = "未开始";
    sessionState = createIdleState();
    syncState();
    updateUI();
  }

  async function chooseOutputFile(filename) {
    if (typeof window.showSaveFilePicker !== "function") {
      setNotice("当前浏览器将使用内存录制，达到 512 MiB 时自动停止保存。", "info");
      return null;
    }
    try {
      return await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: "WebM video",
          accept: { "video/webm": [".webm"] },
        }],
      });
    } catch (error) {
      if (error && error.name !== "AbortError") throw error;
      setNotice("未选择文件位置，将使用内存录制，达到 512 MiB 时自动停止保存。", "info");
      return null;
    }
  }

  function abortOutputWriter() {
    if (outputWriter && typeof outputWriter.abort === "function") {
      outputWriter.abort().catch(() => {});
    }
    outputWriter = null;
    outputFileHandle = null;
  }

  function syncState() {
    if (port && !readOnlyMode) {
      port.postMessage({
        type: "STATE_UPDATE",
        state: {
          ...sessionState,
          microphoneEnabled: els.microphoneToggle.checked,
          filename: sessionState.filename || null,
        },
      });
    }
    updateUI();
  }

  function showLivePreview(stream) {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }

    els.previewVideo.pause();
    els.previewVideo.removeAttribute("src");
    els.previewVideo.srcObject = stream;
    els.previewVideo.muted = true;
    els.previewVideo.style.display = "block";
    els.previewEmpty.style.display = "none";
    els.previewVideo.play().catch(() => {});
  }

  function showPlayback(blob) {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    previewUrl = URL.createObjectURL(blob);
    els.previewVideo.pause();
    els.previewVideo.srcObject = null;
    els.previewVideo.src = previewUrl;
    els.previewVideo.muted = false;
    els.previewVideo.style.display = "block";
    els.previewEmpty.style.display = "none";
    els.previewVideo.play().catch(() => {});
  }

  function clearPreview() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    els.previewVideo.pause();
    els.previewVideo.removeAttribute("src");
    els.previewVideo.srcObject = null;
    els.previewVideo.load();
    els.previewVideo.style.display = "none";
    els.previewEmpty.style.display = "flex";
  }

  function cleanupMedia(options) {
    const preservePlayback = Boolean(options && options.preservePlayback);

    [recordingStream, displayStream, microphoneStream].forEach((stream) => {
      if (!stream) return;
      stream.getTracks().forEach((track) => track.stop());
    });

    if (mixedAudioContext) {
      mixedAudioContext.close().catch(() => {});
    }

    recordingStream = null;
    displayStream = null;
    microphoneStream = null;
    mixedAudioContext = null;

    if (!preservePlayback) {
      clearPreview();
    } else if (els.previewVideo.srcObject) {
      els.previewVideo.srcObject = null;
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function updateUI() {
    const idle = sessionState.status === "idle";
    const paused = sessionState.status === "paused";
    const canStart = environmentSupported && !readOnlyMode && idle;
    const canControl = !readOnlyMode && !idle && Boolean(mediaRecorder);

    els.startBtn.disabled = !canStart;
    els.pauseBtn.disabled = !canControl;
    els.stopBtn.disabled = !canControl;
    els.pauseBtn.textContent = paused ? "继续" : "暂停";
    els.filenamePrefix.disabled = !idle || readOnlyMode;
    els.microphoneToggle.disabled = !idle || readOnlyMode;
    els.focusExistingBtn.hidden = !readOnlyMode;

    els.statusPill.textContent = readOnlyMode
      ? "只读"
      : idle
        ? "待命"
        : paused
          ? "已暂停"
          : "录制中";

    els.timerValue.textContent = formatDuration(getElapsedMs());
    els.audioValue.textContent = audioSummary;
    els.sessionSummary.textContent = readOnlyMode
      ? "当前页面处于只读状态，请返回正在工作的录制页。"
      : idle
        ? "尚未开始录制"
        : paused
          ? "录制已暂停，可在此页或网页悬浮条继续。"
          : "录制进行中，可在此页或网页悬浮条停止。";

    els.captureHint.textContent = readOnlyMode
      ? "已有录制页在控制当前会话。你可以点击下方按钮回到它。"
      : idle
        ? "点击“开始录制”后，浏览器会弹出系统选择器，你可以选择录制整个屏幕、单个窗口或当前标签页。"
        : "录制开始后，系统共享的停止会自动结束本次录制。";

    els.stayOpenNotice.hidden = idle;
    updateFilenamePreview();
    updateTimerLoop();
    applyNotice();
  }

  function updateTimerLoop() {
    if (sessionState.status === "idle" && timerId) {
      clearInterval(timerId);
      timerId = null;
      return;
    }

    if (sessionState.status !== "idle" && !timerId) {
      timerId = setInterval(() => {
        els.timerValue.textContent = formatDuration(getElapsedMs());
      }, 1000);
    }
  }

  function getElapsedMs() {
    if (!sessionState.startedAt) return 0;
    const endAt = sessionState.status === "paused" && sessionState.pauseStartedAt
      ? sessionState.pauseStartedAt
      : Date.now();
    return Math.max(0, endAt - sessionState.startedAt - (sessionState.pausedDurationMs || 0));
  }

  function updateFilenamePreview() {
    const timestamp = sessionState.status === "idle" ? Date.now() : sessionState.startedAt || Date.now();
    const filename = sessionState.filename || buildFilename(timestamp);
    els.filenamePreview.textContent = filename;
  }

  function buildFilename(timestamp) {
    return sanitizePrefix(getFilenamePrefix()) + "-" + formatTimestamp(timestamp || Date.now()) + ".webm";
  }

  function getFilenamePrefix() {
    return sanitizePrefix(els.filenamePrefix.value || DEFAULT_PREFIX);
  }

  function sanitizePrefix(value) {
    const sanitized = String(value || "")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return sanitized || DEFAULT_PREFIX;
  }

  function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const hour = pad2(date.getHours());
    const minute = pad2(date.getMinutes());
    const second = pad2(date.getSeconds());
    return "" + year + month + day + "-" + hour + minute + second;
  }

  function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return [hours, minutes, seconds].map(pad2).join(":");
    }
    return [minutes, seconds].map(pad2).join(":");
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function createIdleState() {
    return {
      status: "idle",
      startedAt: null,
      pauseStartedAt: null,
      pausedDurationMs: 0,
      recorderTabId: null,
      microphoneEnabled: false,
      filename: null,
    };
  }

  function normalizeState(nextState) {
    const state = {
      ...createIdleState(),
      ...(nextState || {}),
    };
    if (state.status !== "recording" && state.status !== "paused") {
      return createIdleState();
    }
    return state;
  }

  function readableError(error) {
    if (!error) return "未知错误";
    return error.message || error.name || String(error);
  }

  function setNotice(message, level) {
    activeNotice = {
      message,
      level: level || "info",
    };
    applyNotice();
  }

  function clearNotice() {
    activeNotice = { message: "", level: "info" };
    applyNotice();
  }

  function applyNotice() {
    const box = els.noticeBox;
    if (!activeNotice.message) {
      box.hidden = true;
      box.className = "notice-box";
      box.textContent = "";
      return;
    }

    box.hidden = false;
    box.className = "notice-box is-visible is-" + activeNotice.level;
    box.textContent = activeNotice.message;
  }
})();
