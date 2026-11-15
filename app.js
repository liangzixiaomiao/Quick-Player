/* =========================================================
 * 倍速压缩工坊
 * 思路：视频在本机解码 → 按选定倍速播放 → 逐帧绘制到 canvas
 *      → canvas.captureStream + MediaRecorder 录制为 MP4/WebM
 * 全程不上传，单文件双击即可运行。
 * ========================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    video: $('video'),
    dropZone: $('dropZone'),
    placeholder: $('placeholder'),
    fileInput: $('fileInput'),
    pickBtn: $('pickBtn'),
    changeBtn: $('changeBtn'),
    fileName: $('fileName'),
    fileInfo: $('fileInfo'),
    playBtn: $('playBtn'),
    curTime: $('curTime'),
    durTime: $('durTime'),
    speedChip: $('speedChip'),
    previewSpeed: $('previewSpeed'),
    muteBtn: $('muteBtn'),
    tlTrack: $('tlTrack'),
    tlFrames: $('tlFrames'),
    tlSel: $('tlSel'),
    dimL: $('dimL'),
    dimR: $('dimR'),
    hStart: $('hStart'),
    hEnd: $('hEnd'),
    tlHead: $('tlHead'),
    tlStartLabel: $('tlStartLabel'),
    tlEndLabel: $('tlEndLabel'),
    statStart: $('statStart'),
    statEnd: $('statEnd'),
    statLen: $('statLen'),
    statOut: $('statOut'),
    previewRange: $('previewRange'),
    targetInput: $('targetInput'),
    targetHint: $('targetHint'),
    presets: $('presets'),
    modeSwitch: $('modeSwitch'),
    manualRow: $('manualRow'),
    speedRange: $('speedRange'),
    manualSpeedLabel: $('manualSpeedLabel'),
    calcLen: $('calcLen'),
    calcSpeed: $('calcSpeed'),
    calcOut: $('calcOut'),
    speedWarn: $('speedWarn'),
    includeAudio: $('includeAudio'),
    keepPitch: $('keepPitch'),
    resSelect: $('resSelect'),
    formatSelect: $('formatSelect'),
    exportBtn: $('exportBtn'),
    cancelBtn: $('cancelBtn'),
    exportBox: $('exportBox'),
    progressBar: $('progressBar'),
    exportStatus: $('exportStatus'),
    exportPct: $('exportPct'),
    resultCard: $('resultCard'),
    resultVideo: $('resultVideo'),
    downloadLink: $('downloadLink'),
    againBtn: $('againBtn'),
    resultInfo: $('resultInfo'),
    formatBadge: $('formatBadge'),
    canvas: $('exportCanvas')
  };

  var MIN_SPEED = 0.1;
  var MAX_SPEED = 16;
  var MIN_CLIP = 0.25;   // 最短片段（秒）
  var FPS = 30;

  var state = {
    file: null,
    url: '',
    duration: 0,
    vw: 0, vh: 0,
    hasFile: false,
    trimStart: 0,
    trimEnd: 0,
    target: 60,
    mode: 'auto',
    manualSpeed: 4,
    muted: false,
    rangePreview: false,
    exporting: false,
    cancelRequested: false
  };

  var rafPlay = 0, rafExport = 0;
  var progressTimer = 0;
  var exportT0 = 0, exportExpected = 0;
  var resultUrl = '';
  var stripToken = 0;

  var audioCtx = null, recordGain = null, monitorGain = null, audioDest = null;

  /* ---------------- 工具函数 ---------------- */
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function fmt(t) {
    t = Math.max(0, Number(t) || 0);
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = Math.floor(t % 60);
    if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
    return m + ':' + pad(s);
  }

  function fmtTenth(t) {
    t = Math.max(0, Number(t) || 0);
    var m = Math.floor(t / 60);
    var s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function speedLabel(s) {
    return (Math.round(s * 100) / 100).toFixed(2) + '×';
  }

  function once(el, evt, timeout) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        el.removeEventListener(evt, ok);
        reject(new Error('timeout: ' + evt));
      }, timeout || 4000);
      function ok() {
        clearTimeout(timer);
        el.removeEventListener(evt, ok);
        resolve();
      }
      el.addEventListener(evt, ok);
    });
  }

  function seekVideo(v, t) {
    return new Promise(function (resolve) {
      var target = clamp(t, 0, Math.max(0, (v.duration || 0) - 0.02));
      if (Math.abs(v.currentTime - target) < 0.005) { resolve(); return; }
      var done = function () {
        clearTimeout(timer);
        v.removeEventListener('seeked', done);
        resolve();
      };
      var timer = setTimeout(done, 2500);
      v.addEventListener('seeked', done);
      try { v.currentTime = target; } catch (e) { done(); }
    });
  }

  // 等待画面真正开始推进（起播瞬间解码器会卡顿几百毫秒）
  function waitPlaybackMoving(v, fromTime, timeoutMs) {
    return new Promise(function (resolve) {
      var t0 = performance.now();
      var check = function () {
        if (v.ended || v.currentTime >= fromTime + 0.06) { resolve(true); return; }
        if (performance.now() - t0 > (timeoutMs || 2500)) { resolve(false); return; }
        setTimeout(check, 30);
      };
      check();
    });
  }

  /* ---------------- 计算 ---------------- */
  function clipLength() {
    return Math.max(0, state.trimEnd - state.trimStart);
  }

  function currentSpeed() {
    var len = clipLength();
    if (!state.hasFile || len <= 0) {
      return state.mode === 'manual' ? clamp(state.manualSpeed, MIN_SPEED, MAX_SPEED) : 1;
    }
    if (state.mode === 'manual') return clamp(state.manualSpeed, MIN_SPEED, MAX_SPEED);
    return clamp(len / Math.max(1, state.target), MIN_SPEED, MAX_SPEED);
  }

  function computeDims() {
    var w = state.vw || els.video.videoWidth || 1280;
    var h = state.vh || els.video.videoHeight || 720;
    var cap = Number(els.resSelect.value) || 0;
    if (cap && h > cap) {
      w = Math.round(w * (cap / h));
      h = cap;
    }
    w = Math.max(2, w - (w % 2));
    h = Math.max(2, h - (h % 2));
    return { w: w, h: h };
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var len = clipLength();
    var speed = currentSpeed();
    var out = speed > 0 ? len / speed : 0;

    els.speedChip.textContent = speedLabel(speed);
    els.statStart.textContent = fmtTenth(state.trimStart);
    els.statEnd.textContent = fmtTenth(state.trimEnd);
    els.statLen.textContent = fmtTenth(len);
    els.statOut.textContent = fmtTenth(out);
    els.calcLen.textContent = fmtTenth(len);
    els.calcSpeed.textContent = speedLabel(speed);
    els.calcOut.textContent = fmtTenth(out);
    els.targetHint.textContent = '= ' + fmt(state.target);

    var xS = state.duration ? (state.trimStart / state.duration) * 100 : 0;
    var xE = state.duration ? (state.trimEnd / state.duration) * 100 : 100;
    els.hStart.style.left = xS + '%';
    els.hEnd.style.left = xE + '%';
    els.tlSel.style.left = xS + '%';
    els.tlSel.style.width = Math.max(0, xE - xS) + '%';
    els.dimL.style.width = xS + '%';
    els.dimR.style.width = Math.max(0, 100 - xE) + '%';

    els.manualSpeedLabel.textContent = speedLabel(state.manualSpeed);
    els.previewRange.disabled = !state.hasFile || state.exporting;
    els.exportBtn.disabled = !state.hasFile || state.exporting;
    els.exportBtn.textContent = state.hasFile ? ('开始导出 · ' + fmt(out)) : '开始导出';

    // 提示
    var warn = '';
    if (state.hasFile && len > 0) {
      if (state.mode === 'auto') {
        var ideal = len / Math.max(1, state.target);
        if (ideal > MAX_SPEED) {
          warn = '需要 ' + ideal.toFixed(1) + '× 才能压到目标时长，已按浏览器上限 16× 处理，输出约 ' +
            fmt(out) + '。可再裁短片段或放宽目标时长。';
        } else if (ideal < 1) {
          warn = '目标时长比片段还长，将以 ' + ideal.toFixed(2) + '× 放慢播放。';
        }
      } else if (out > state.target + 0.5) {
        warn = '当前倍速下输出约 ' + fmt(out) + '，仍超过目标 ' + fmt(state.target) + '。';
      }
    }
    els.speedWarn.hidden = !warn;
    els.speedWarn.textContent = warn;

    syncPresets();
  }

  function syncPresets() {
    var btns = els.presets.querySelectorAll('button[data-sec]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-active', Number(btns[i].dataset.sec) === state.target);
    }
  }

  function updatePlayhead() {
    var t = els.video.currentTime || 0;
    els.curTime.textContent = fmt(t);
    var p = state.duration ? (t / state.duration) * 100 : 0;
    els.tlHead.style.left = clamp(p, 0, 100) + '%';
  }

  function applyRate() {
    if (state.exporting) return;
    var rate = 1;
    if (state.hasFile && els.previewSpeed.checked) rate = currentSpeed();
    els.video.playbackRate = clamp(rate, 0.0625, MAX_SPEED);
    applyPitch();
  }

  function applyPitch() {
    var on = els.keepPitch.checked;
    els.video.preservesPitch = on;
    els.video.webkitPreservesPitch = on;
    els.video.mozPreservesPitch = on;
  }

  /* ---------------- 载入文件 ---------------- */
  function setFile(file) {
    if (!file || state.exporting) return;
    var isVideo = /^video\//.test(file.type) || /\.(mp4|m4v|webm|mov|mkv|avi|ogv)$/i.test(file.name);
    if (!isVideo) {
      els.fileInfo.textContent = '请选择视频文件';
      return;
    }
    if (state.url) URL.revokeObjectURL(state.url);
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = ''; }

    state.file = file;
    state.url = URL.createObjectURL(file);
    state.hasFile = false;
    state.duration = 0;
    state.trimStart = 0;
    state.trimEnd = 0;
    state.rangePreview = false;

    els.video.pause();
    els.placeholder.classList.add('is-hidden');
    els.video.classList.add('is-empty');
    els.fileName.textContent = file.name;
    els.fileInfo.textContent = '读取中…';
    els.durTime.textContent = '0:00';
    els.resultCard.hidden = true;
    els.exportBox.hidden = true;

    els.video.src = state.url;
    els.video.load();
    render();
  }

  function onLoaded() {
    if (!state.url) return;
    var d = els.video.duration;
    if (!isFinite(d) || d <= 0) {
      els.fileInfo.textContent = '无法读取时长（可能是流式文件）';
      return;
    }
    state.duration = d;
    state.vw = els.video.videoWidth || 0;
    state.vh = els.video.videoHeight || 0;
    state.trimStart = 0;
    state.trimEnd = d;
    state.hasFile = true;

    els.video.classList.remove('is-empty');
    var mb = state.file.size / 1048576;
    var sizeText = mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
    els.fileInfo.textContent = fmt(d) + ' · ' + state.vw + '×' + state.vh + ' · ' + sizeText;
    els.durTime.textContent = fmt(d);
    applyPitch();
    applyRate();
    render();
    updatePlayhead();
    buildFilmstrip();
  }

  /* ---------------- 时间轴缩略图 ---------------- */
  function drawCover(g, v, x, y, w, h) {
    var vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    var scale = Math.max(w / vw, h / vh);
    var dw = vw * scale, dh = vh * scale;
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    g.restore();
  }

  function buildFilmstrip() {
    var canvas = els.tlFrames;
    var g = canvas.getContext('2d');
    g.fillStyle = '#0b0e15';
    g.fillRect(0, 0, canvas.width, canvas.height);
    if (!state.url || !state.duration) return;

    var token = ++stripToken;
    var probe = document.createElement('video');
    probe.className = 'hidden-video';
    probe.muted = true;
    probe.playsInline = true;
    probe.preload = 'auto';
    probe.src = state.url;
    document.body.appendChild(probe);

    var N = 18;
    var cellW = canvas.width / N;
    var H = canvas.height;

    once(probe, 'loadeddata', 5000).then(function () {
      var chain = Promise.resolve();
      var mark = function (i) {
        chain = chain.then(function () {
          if (token !== stripToken) return;
          var t = state.duration * (i + 0.5) / N;
          return seekVideo(probe, Math.min(t, Math.max(0, state.duration - 0.08))).then(function () {
            if (token !== stripToken) return;
            drawCover(g, probe, i * cellW, 0, cellW, H);
          }).catch(function () {});
        });
      };
      for (var i = 0; i < N; i++) mark(i);
      return chain;
    }).catch(function () {}).then(function () {
      probe.remove();
    });
  }

  /* ---------------- 时间轴拖动 ---------------- */
  function setupTimeline() {
    var track = els.tlTrack;
    var dragging = null;

    function timeAt(clientX) {
      var r = track.getBoundingClientRect();
      var ratio = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
      return ratio * state.duration;
    }

    track.addEventListener('pointerdown', function (e) {
      if (!state.hasFile || state.exporting) return;
      var handle = e.target.closest ? e.target.closest('.tl-handle') : null;
      if (handle) {
        dragging = handle.dataset.handle;
        handle.classList.add('is-active');
        if (!els.video.paused) els.video.pause();
        try { track.setPointerCapture(e.pointerId); } catch (err) {}
      } else {
        seekVideo(els.video, timeAt(e.clientX));
        updatePlayhead();
      }
      e.preventDefault();
    });

    track.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var t = timeAt(e.clientX);
      if (dragging === 'start') {
        state.trimStart = clamp(t, 0, state.trimEnd - MIN_CLIP);
      } else {
        state.trimEnd = clamp(t, state.trimStart + MIN_CLIP, state.duration);
      }
      els.video.currentTime = dragging === 'start' ? state.trimStart : state.trimEnd;
      render();
      updatePlayhead();
      applyRate();
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = null;
      els.hStart.classList.remove('is-active');
      els.hEnd.classList.remove('is-active');
      try { track.releasePointerCapture(e.pointerId); } catch (err) {}
      render();
    }
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
  }

  /* ---------------- 播放控制 ---------------- */
  function togglePlay() {
    if (!state.hasFile || state.exporting) return;
    if (els.video.paused) {
      state.rangePreview = false;
      ensureAudioGraph(); // 提前建立音频链路，导出时少一次起播卡顿
      var p = els.video.play();
      if (p && p.catch) p.catch(function () {});
    } else {
      els.video.pause();
    }
  }

  function previewClip() {
    if (!state.hasFile || state.exporting) return;
    state.rangePreview = true;
    seekVideo(els.video, state.trimStart).then(function () {
      if (state.exporting) return;
      els.video.playbackRate = clamp(currentSpeed(), 0.0625, MAX_SPEED);
      var p = els.video.play();
      if (p && p.catch) p.catch(function () {});
    });
  }

  function startTick() {
    cancelAnimationFrame(rafPlay);
    var loop = function () {
      updatePlayhead();
      if (state.rangePreview && !state.exporting &&
          els.video.currentTime >= state.trimEnd - 0.02) {
        state.rangePreview = false;
        els.video.pause();
        return;
      }
      if (!els.video.paused) rafPlay = requestAnimationFrame(loop);
    };
    rafPlay = requestAnimationFrame(loop);
  }

  /* ---------------- 声音 ---------------- */
  function setMuted(m) {
    state.muted = m;
    if (monitorGain) monitorGain.gain.value = m ? 0 : 1;
    else els.video.muted = m;
    els.muteBtn.textContent = m ? '🔇' : '🔊';
  }

  function ensureAudioGraph() {
    return new Promise(function (resolve) {
      if (audioCtx) {
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().then(resolve).catch(resolve);
        } else resolve();
        return;
      }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { resolve(); return; }
      try {
        audioCtx = new AC();
        var src = audioCtx.createMediaElementSource(els.video);
        recordGain = audioCtx.createGain();
        monitorGain = audioCtx.createGain();
        audioDest = audioCtx.createMediaStreamDestination();
        src.connect(recordGain);
        recordGain.connect(audioDest);
        src.connect(monitorGain);
        monitorGain.connect(audioCtx.destination);
        recordGain.gain.value = 1;
        monitorGain.gain.value = state.muted ? 0 : 1;
        // 音频已改由 WebAudio 输出，元素自身静音会连累录制，这里统一复位
        els.video.muted = false;
        els.video.volume = 1;
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().then(resolve).catch(resolve);
        } else resolve();
      } catch (err) {
        console.warn('音频图创建失败', err);
        resolve();
      }
    });
  }

  /* ---------------- 导出 ---------------- */
  var MIME_MP4 = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4'
  ];
  var MIME_WEBM = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];

  function supported(list) {
    if (!window.MediaRecorder) return '';
    for (var i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {}
    }
    return '';
  }

  function pickMime(pref) {
    var first = pref === 'webm' ? MIME_WEBM : MIME_MP4;
    var second = pref === 'webm' ? MIME_MP4 : MIME_WEBM;
    return supported(first) || supported(second);
  }

  function initFormatBadge() {
    var canExport = window.MediaRecorder &&
      window.HTMLCanvasElement &&
      HTMLCanvasElement.prototype.captureStream;
    if (!canExport) {
      els.formatBadge.textContent = '当前浏览器不支持导出';
      return;
    }
    var m = pickMime(els.formatSelect.value);
    if (!m) els.formatBadge.textContent = '当前浏览器不支持导出';
    else if (m.indexOf('mp4') >= 0) els.formatBadge.textContent = '导出 MP4';
    else els.formatBadge.textContent = '导出 WebM';
  }

  function setStatus(text) {
    els.exportStatus.textContent = text;
  }

  function updateProgress() {
    if (!exportExpected) return;
    var elapsed = performance.now() - exportT0;
    var p = clamp(elapsed / exportExpected, 0, 0.995);
    els.progressBar.style.width = (p * 100).toFixed(1) + '%';
    els.exportPct.textContent = Math.round(p * 100) + '%';
    var remain = Math.max(0, exportExpected - elapsed) / 1000;
    setStatus('正在录制快放画面 · 剩余约 ' + (remain > 1 ? Math.ceil(remain) + ' 秒' : '1 秒'));
  }

  function cleanupExport() {
    state.exporting = false;
    cancelAnimationFrame(rafExport);
    clearInterval(progressTimer);
    progressTimer = 0;
    if (monitorGain) monitorGain.gain.value = state.muted ? 0 : 1;
    els.exportBtn.hidden = false;
    els.cancelBtn.hidden = true;
    els.exportBtn.disabled = !state.hasFile;
    els.video.playbackRate = clamp(els.previewSpeed.checked ? currentSpeed() : 1, 0.0625, MAX_SPEED);
    render();
  }

  function startExport() {
    if (!state.hasFile || state.exporting) return;

    var speed = currentSpeed();
    var start = state.trimStart;
    var end = state.trimEnd;
    var len = end - start;
    if (len < MIN_CLIP) {
      setStatus('片段太短');
      return;
    }

    state.exporting = true;
    state.cancelRequested = false;
    state.rangePreview = false;
    els.video.pause();

    els.exportBtn.hidden = true;
    els.cancelBtn.hidden = false;
    els.exportBox.hidden = false;
    els.resultCard.hidden = true;
    els.progressBar.style.width = '0%';
    els.exportPct.textContent = '0%';
    setStatus('准备中…');
    render();

    var recorder = null;
    var chunks = [];

    var run = async function () {
      try {
        await ensureAudioGraph();
        applyPitch();

        var dims = computeDims();
        els.canvas.width = dims.w;
        els.canvas.height = dims.h;
        var ctx = els.canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, dims.w, dims.h);

        setStatus('跳转到片段起点…');
        await seekVideo(els.video, start);
        try { ctx.drawImage(els.video, 0, 0, dims.w, dims.h); } catch (e) {}

        var mime = pickMime(els.formatSelect.value);
        if (!mime) throw new Error('当前浏览器不支持录制，请使用最新版 Chrome / Edge');

        if (monitorGain) monitorGain.gain.value = 0;

        els.video.playbackRate = clamp(speed, 0.0625, MAX_SPEED);

        // 起播时解码器会空转几百毫秒，若此时已开录，这段空转会被
        // 当作「静止首帧」记进成片，导致输出比目标更长。
        // 因此先开播、等画面真正推进，再创建录制流。
        await els.video.play();
        await waitPlaybackMoving(els.video, start, 2500);
        try { ctx.drawImage(els.video, 0, 0, dims.w, dims.h); } catch (e) {}

        var capture = els.canvas.captureStream(FPS);
        if (els.includeAudio.checked && audioDest) {
          var at = audioDest.stream.getAudioTracks()[0];
          if (at) capture.addTrack(at);
        }

        // 不指定 videoBitsPerSecond：显式码率会让部分 Chromium 走慢速编码路径，
        // 导致播放掉速、成片比目标更长。
        recorder = new MediaRecorder(capture, { mimeType: mime });
        recorder.ondataavailable = function (e) {
          if (e.data && e.data.size) chunks.push(e.data);
        };

        var stopped = new Promise(function (resolve) {
          recorder.onstop = function () { resolve(); };
          setTimeout(resolve, 6000);
        });

        exportT0 = performance.now();
        exportExpected = (len / speed) * 1000;
        recorder.start(200);
        progressTimer = setInterval(updateProgress, 200);

        await new Promise(function (resolve) {
          var lastDraw = 0;
          var loop = function () {
            if (!state.exporting) { resolve(); return; }
            var now = performance.now();
            // 按录制帧率绘制，避免无谓的多余读回
            if (now - lastDraw >= 1000 / FPS) {
              try { ctx.drawImage(els.video, 0, 0, dims.w, dims.h); } catch (e) {}
              lastDraw = now;
            }
            if (els.video.currentTime >= end - 0.05 || els.video.ended) { resolve(); return; }
            rafExport = requestAnimationFrame(loop);
          };
          rafExport = requestAnimationFrame(loop);
          // 兜底：防止 seek 卡住导致永不结束
          setTimeout(resolve, exportExpected * 1.6 + 8000);
        });

        els.video.pause();
        clearInterval(progressTimer);
        progressTimer = 0;

        // 录制墙钟 ≈ 成片时长，趁 stop 之前取，避免把收尾耗时算进去
        var recordedMs = performance.now() - exportT0;

        if (recorder.state !== 'inactive') recorder.stop();
        await stopped;

        if (state.cancelRequested) {
          setStatus('已取消导出');
          els.exportBox.hidden = true;
          return;
        }

        var type = mime.split(';')[0];
        var blob = new Blob(chunks, { type: type });
        if (!blob.size) throw new Error('没有录制到画面数据');

        var ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
        var realDur = Math.max(0.1, recordedMs / 1000);
        var base = (state.file && state.file.name ? state.file.name : 'video').replace(/\.[^.]+$/, '');
        var name = base + '_' + (Math.round(speed * 100) / 100) + 'x_' + Math.round(realDur) + 's.' + ext;

        if (resultUrl) URL.revokeObjectURL(resultUrl);
        resultUrl = URL.createObjectURL(blob);

        els.resultVideo.src = resultUrl;
        els.downloadLink.href = resultUrl;
        els.downloadLink.download = name;
        var targetDur = len / speed;
        var text = ext.toUpperCase() + ' · ' + (blob.size / 1048576).toFixed(1) +
          ' MB · 实际输出 ' + fmtTenth(realDur) + '（目标 ' + fmtTenth(targetDur) + '）';
        if (realDur - targetDur > Math.max(0.6, targetDur * 0.08)) {
          text += ' · 本机编码跟不上，建议改用 WebM 或降低分辨率';
        }
        els.resultInfo.textContent = text;
        els.resultCard.hidden = false;
        if (els.resultCard.scrollIntoView) {
          els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        els.progressBar.style.width = '100%';
        els.exportPct.textContent = '100%';
        setStatus('导出完成');
      } catch (err) {
        console.error(err);
        setStatus('导出失败：' + ((err && err.message) || err));
      } finally {
        if (recorder && recorder.state !== 'inactive') {
          try { recorder.stop(); } catch (e) {}
        }
        cleanupExport();
      }
    };

    run();
  }

  function cancelExport() {
    if (!state.exporting) return;
    state.cancelRequested = true;
    state.exporting = false;
    els.video.pause();
    // 不能在这里取消 rAF：导出主流程正等它看到 exporting=false 后收尾
    clearInterval(progressTimer);
    progressTimer = 0;
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    els.fileInput.addEventListener('change', function () {
      if (els.fileInput.files && els.fileInput.files[0]) setFile(els.fileInput.files[0]);
      els.fileInput.value = '';
    });
    els.pickBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      els.fileInput.click();
    });
    els.changeBtn.addEventListener('click', function () { els.fileInput.click(); });

    // 拖拽
    var dz = els.dropZone;
    ['dragenter', 'dragover'].forEach(function (evt) {
      dz.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dz.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dz.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (evt === 'dragleave' && dz.contains(e.relatedTarget)) return;
        dz.classList.remove('is-dragover');
      });
    });
    dz.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) setFile(f);
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    // 播放器
    els.playBtn.addEventListener('click', togglePlay);
    els.muteBtn.addEventListener('click', function () { setMuted(!state.muted); });
    els.previewSpeed.addEventListener('change', applyRate);
    els.previewRange.addEventListener('click', previewClip);

    els.video.addEventListener('loadedmetadata', onLoaded);
    els.video.addEventListener('play', function () {
      els.playBtn.textContent = '❚❚';
      startTick();
    });
    els.video.addEventListener('pause', function () {
      els.playBtn.textContent = '▶';
      cancelAnimationFrame(rafPlay);
      updatePlayhead();
    });
    els.video.addEventListener('timeupdate', updatePlayhead);
    els.video.addEventListener('error', function () {
      if (!state.url) return;
      els.fileInfo.textContent = '视频无法解码，请换用 MP4(H.264) / WebM';
    });

    // 参数
    els.targetInput.addEventListener('input', function () {
      var v = Number(els.targetInput.value);
      if (isFinite(v) && v > 0) {
        state.target = v;
        render();
        applyRate();
      }
    });
    els.targetInput.addEventListener('blur', function () {
      if (!(state.target > 0)) state.target = 60;
      els.targetInput.value = state.target;
      render();
    });

    els.presets.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-sec]') : null;
      if (!b) return;
      state.target = Number(b.dataset.sec);
      els.targetInput.value = state.target;
      render();
      applyRate();
    });

    els.modeSwitch.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-mode]') : null;
      if (!b) return;
      var autoSpeed = currentSpeed();
      state.mode = b.dataset.mode;
      var kids = els.modeSwitch.querySelectorAll('button');
      for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('is-active', kids[i] === b);
      els.manualRow.hidden = state.mode !== 'manual';
      if (state.mode === 'manual') {
        state.manualSpeed = clamp(Math.round(autoSpeed * 4) / 4, 0.25, 16);
        els.speedRange.value = state.manualSpeed;
      }
      render();
      applyRate();
    });

    els.speedRange.addEventListener('input', function () {
      state.manualSpeed = Number(els.speedRange.value);
      render();
      applyRate();
    });

    els.keepPitch.addEventListener('change', applyPitch);
    els.resSelect.addEventListener('change', render);
    els.formatSelect.addEventListener('change', initFormatBadge);

    els.exportBtn.addEventListener('click', startExport);
    els.cancelBtn.addEventListener('click', cancelExport);
    els.againBtn.addEventListener('click', function () {
      if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = ''; }
      els.resultCard.hidden = true;
      els.exportBox.hidden = true;
      els.resultVideo.removeAttribute('src');
      els.progressBar.style.width = '0%';
    });

    // 快捷键
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (!state.hasFile || state.exporting) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        els.video.currentTime = Math.max(0, els.video.currentTime - (e.shiftKey ? 1 : 5));
        updatePlayhead();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        els.video.currentTime = Math.min(state.duration, els.video.currentTime + (e.shiftKey ? 1 : 5));
        updatePlayhead();
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    els.video.classList.add('is-empty');
    els.manualRow.hidden = true;
    initFormatBadge();
    bindEvents();
    setupTimeline();
    setMuted(false);
    applyPitch();
    render();
    updatePlayhead();
  }

  init();
})();
