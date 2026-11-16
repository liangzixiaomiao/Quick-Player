/* =========================================================
 * 离线导出：MP4 解封装 → WebCodecs 解码 → 按目标时间轴抽帧
 *          → 重新编码 → mp4-muxer 封装
 * 导出耗时只取决于源视频长度与本机编码速度，与成片时长无关。
 * 只处理 H.264 + AAC 的 MP4；其余情况抛 OfflineUnsupported，
 * 由调用方回退到实时录制。
 * ========================================================= */
(function () {
  'use strict';

  var FPS = 30;           // 输出帧率
  var OUT_RATE = 48000;   // 输出音频采样率
  var BLOCK = 1024;       // 每次送进音频编码器的帧数

  function libs() {
    return {
      mp4box: window.MP4Box,
      Muxer: window.Mp4Muxer && window.Mp4Muxer.Muxer,
      Target: window.Mp4Muxer && window.Mp4Muxer.ArrayBufferTarget
    };
  }

  function supported() {
    var l = libs();
    return !!(l.mp4box && l.Muxer && l.Target && window.VideoEncoder && window.VideoDecoder);
  }

  function makeError(name, msg) {
    var e = new Error(msg);
    e.name = name;
    return e;
  }

  function unsupported(msg) { return makeError('OfflineUnsupported', msg || '离线编码不可用'); }
  function cancelled() { return makeError('OfflineCancelled', '已取消导出'); }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function hex2(n) {
    return ('0' + (n & 0xFF).toString(16)).slice(-2);
  }

  /* ---------------- 解封装 ---------------- */
  function demux(buffer) {
    return new Promise(function (resolve, reject) {
      var mp4 = libs().mp4box.createFile();
      var info = null;
      mp4.onError = function (e) { reject(unsupported('解封装失败：' + e)); };
      mp4.onReady = function (i) { info = i; };
      try {
        buffer.fileStart = 0;
        mp4.appendBuffer(buffer);
        mp4.flush();
      } catch (err) {
        reject(unsupported('解封装失败：' + ((err && err.message) || err)));
        return;
      }
      if (!info) { reject(unsupported('不是可解析的 MP4 文件')); return; }
      resolve({ mp4: mp4, info: info });
    });
  }

  // 从 mp4box 的 avcC（或码流里的 SPS/PPS）重建 AVCDecoderConfigurationRecord
  function naluOf(item) { return (item && item.nalu) ? item.nalu : item; }

  function buildAvcRecord(profile, compat, level, ls, sps, pps) {
    var size = 7, k;
    for (k = 0; k < sps.length; k++) size += 2 + sps[k].length;
    for (k = 0; k < pps.length; k++) size += 2 + pps[k].length;

    var out = new Uint8Array(size);
    var p = 0;
    out[p++] = 1;
    out[p++] = profile;
    out[p++] = compat;
    out[p++] = level;
    out[p++] = 0xFC | ((ls == null ? 3 : ls) & 3);
    out[p++] = 0xE0 | (sps.length & 0x1F);
    for (k = 0; k < sps.length; k++) {
      out[p++] = (sps[k].length >> 8) & 0xFF;
      out[p++] = sps[k].length & 0xFF;
      out.set(sps[k], p);
      p += sps[k].length;
    }
    out[p++] = pps.length & 0xFF;
    for (k = 0; k < pps.length; k++) {
      out[p++] = (pps[k].length >> 8) & 0xFF;
      out[p++] = pps[k].length & 0xFF;
      out.set(pps[k], p);
      p += pps[k].length;
    }

    return {
      codec: 'avc1.' + hex2(profile) + hex2(compat) + hex2(level),
      description: out
    };
  }

  function readAvc(mp4, trackId) {
    var trak = null;
    try { trak = mp4.getTrackById(trackId); } catch (e) {}
    if (!trak || !trak.mdia || !trak.mdia.minf) return null;

    var entries = trak.mdia.minf.stbl.stsd.entries;
    for (var i = 0; i < entries.length; i++) {
      var avcC = entries[i].avcC;
      if (!avcC) continue;
      var sps = (avcC.SPS || []).map(naluOf);
      var pps = (avcC.PPS || []).map(naluOf);
      if (!sps.length || !pps.length) continue;
      return buildAvcRecord(
        avcC.AVCProfileIndication, avcC.profile_compatibility, avcC.AVCLevelIndication,
        avcC.lengthSizeMinusOne, sps, pps
      );
    }
    return null;
  }

  // 兜底：从第一个关键帧的码流里找 SPS/PPS（avc3 等参数集不全在 stsd 里的情况）
  function avcFromBitstream(sample) {
    var data = sample && sample.data;
    if (!data || data.length < 16) return null;
    var sizes = [4, 2];
    for (var si = 0; si < sizes.length; si++) {
      var header = sizes[si], p = 0, sps = null, pps = null;
      while (p + header <= data.length) {
        var len;
        if (header === 4) {
          len = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
        } else {
          len = (data[p] << 8) | data[p + 1];
        }
        p += header;
        if (!len || p + len > data.length) break;
        var t = data[p] & 0x1F;
        if (t === 7 && !sps) sps = data.subarray(p, p + len);
        else if (t === 8 && !pps) pps = data.subarray(p, p + len);
        p += len;
        if (sps && pps) break;
      }
      if (sps && pps && sps.length > 4) {
        return buildAvcRecord(sps[1], sps[2], sps[3], header - 1, [sps], [pps]);
      }
    }
    return null;
  }

  /* ---------------- 取样 ---------------- */
  function collect(mp4, videoId, audioId) {
    var out = { video: [], audio: [] };
    mp4.onSamples = function (id, user, samples) {
      var list = id === videoId ? out.video : (id === audioId ? out.audio : null);
      if (!list) return;
      for (var i = 0; i < samples.length; i++) list.push(samples[i]);
    };
    mp4.setExtractionOptions(videoId, null, { nbSamples: 2000 });
    if (audioId) mp4.setExtractionOptions(audioId, null, { nbSamples: 2000 });
    mp4.start();
    return out;
  }

  /* ---------------- 音频：解码 → 重采样 → AAC 编码 ---------------- */
  // AAC 的 AudioSpecificConfig（AAC-LC）
  var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function aacDescription(rate, channels) {
    var idx = AAC_RATES.indexOf(rate);
    if (idx < 0) return null;
    return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);
  }

  // 返回 { chunks: [{chunk, meta}], channels }；失败时抛错由调用方降级为无声
  async function encodeAudio(samples, track, opt) {
    if (!window.AudioEncoder || !window.AudioDecoder) throw unsupported('音频离线编码不可用');
    if (!samples.length) throw unsupported('没有音频样本');

    var info = track.audio || {};
    var rate = Math.round(info.sample_rate || 0);
    var channels = Math.max(1, Math.min(2, info.channel_count || 2));
    if (!rate) throw unsupported('未知的音频采样率');

    var asc = aacDescription(rate, channels);
    if (!asc) throw unsupported('不支持的音频采样率：' + rate);

    var decCfg = {
      codec: 'mp4a.40.2',
      sampleRate: rate,
      numberOfChannels: channels,
      description: asc
    };
    var decSupport = await AudioDecoder.isConfigSupported(decCfg);
    if (!decSupport || !decSupport.supported) throw unsupported('无法解码该音频');

    var list = samples.slice().sort(function (a, b) { return a.cts - b.cts; });
    var base = list[0].cts;
    var totalOut = Math.round(opt.duration * OUT_RATE);

    var encCfg = {
      codec: 'mp4a.40.2',
      sampleRate: OUT_RATE,
      numberOfChannels: channels,
      bitrate: 128000
    };
    var encSupport = await AudioEncoder.isConfigSupported(encCfg);
    if (!encSupport || !encSupport.supported) throw unsupported('无法编码 AAC 音频');

    var chunks = [];
    var encoder = new AudioEncoder({
      output: function (chunk, meta) { chunks.push({ chunk: chunk, meta: meta }); },
      error: function (e) { fatal = e; }
    });
    encoder.configure(encCfg);

    var fatal = null;
    var queue = [];        // 已解码但未消费的源音频：{start, chans:[Float32Array]}
    var cursor = 0;        // valueAt 的游标
    var qEnd = 0;          // 队列里可用的最后一个源样本下标
    var outIndex = 0;      // 已产生的输出样本数（按 OUT_RATE）
    var emitted = 0;       // 已送进编码器的样本数
    var fill = 0;
    var bufs = [];
    for (var c = 0; c < channels; c++) bufs.push(new Float32Array(BLOCK));

    var step = opt.speed * rate / OUT_RATE;
    var srcBase = opt.start * rate;

    function valueAt(i, ch) {
      if (!queue.length) return 0;
      if (cursor >= queue.length) cursor = queue.length - 1;
      while (cursor < queue.length && queue[cursor].start + queue[cursor].chans[ch].length <= i) cursor++;
      if (cursor >= queue.length) cursor = queue.length - 1;
      while (cursor > 0 && queue[cursor].start > i) cursor--;
      var item = queue[cursor];
      if (!item) return 0;
      var v = item.chans[ch][i - item.start];
      return v === undefined ? 0 : v;
    }

    function readAt(pos, ch) {
      if (!queue.length) return 0;
      if (pos <= 0) return valueAt(0, ch);
      if (step >= 1.5) {
        // 变速幅度大时对窗口取均值，抑制混叠
        var half = step / 2;
        var a = Math.floor(pos - half);
        var b = Math.ceil(pos + half);
        if (a < 0) a = 0;
        var sum = 0, n = 0;
        for (var i = a; i <= b; i++) { sum += valueAt(i, ch); n++; }
        return n ? sum / n : 0;
      }
      var i0 = Math.floor(pos);
      var f = pos - i0;
      var v0 = valueAt(i0, ch);
      var v1 = valueAt(i0 + 1, ch);
      return v0 + (v1 - v0) * f;
    }

    function flushBlock() {
      if (!fill) return;
      var data = new Float32Array(fill * channels);
      for (var c2 = 0; c2 < channels; c2++) {
        data.set(bufs[c2].subarray(0, fill), c2 * fill);
      }
      var ad = new AudioData({
        format: 'f32-planar',
        sampleRate: OUT_RATE,
        numberOfFrames: fill,
        numberOfChannels: channels,
        timestamp: Math.round(emitted / OUT_RATE * 1e6),
        data: data
      });
      encoder.encode(ad);
      ad.close();
      emitted += fill;
      fill = 0;
    }

    function pump() {
      while (outIndex < totalOut) {
        var pos = srcBase + outIndex * step;
        if (pos + 2 > qEnd) break;
        for (var c3 = 0; c3 < channels; c3++) bufs[c3][fill] = readAt(pos, c3);
        fill++;
        outIndex++;
        if (fill >= BLOCK) flushBlock();
        // 丢弃已消费完的源音频块，控制内存
        while (queue.length && queue[0].start + queue[0].chans[0].length <= pos) {
          queue.shift();
          if (cursor > 0) cursor--;
        }
      }
    }

    function onData(data) {
      if (fatal) { data.close(); return; }
      try {
        var frames = data.numberOfFrames;
        var startSample = Math.round(data.timestamp / 1e6 * rate);
        var planes = [];
        for (var c4 = 0; c4 < channels; c4++) {
          var arr = new Float32Array(frames);
          // 源声道不足时复用第 0 声道
          data.copyTo(arr, { planeIndex: Math.min(c4, data.numberOfChannels - 1), format: 'f32-planar' });
          planes.push(arr);
        }
        data.close();
        queue.push({ start: startSample, chans: planes });
        qEnd = startSample + frames;
        pump();
      } catch (err) {
        fatal = err;
        try { data.close(); } catch (e) {}
      }
    }

    var decoder = new AudioDecoder({ output: onData, error: function (e) { fatal = e; } });
    decoder.configure(decCfg);

    for (var i = 0; i < list.length; i++) {
      if (opt.isCancelled()) throw cancelled();
      if (fatal) throw fatal;
      if (outIndex >= totalOut) break;
      var s = list[i];
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round((s.cts - base) / s.timescale * 1e6),
        duration: Math.round(s.duration / s.timescale * 1e6),
        data: s.data
      }));
      if (decoder.decodeQueueSize > 24) {
        while (decoder.decodeQueueSize > 8) {
          if (fatal) throw fatal;
          await sleep(4);
        }
      }
      if (i % 40 === 0) {
        opt.onProgress('处理音频…', 0.02 + 0.18 * Math.min(1, outIndex / Math.max(1, totalOut)));
        await sleep(0);
      }
    }

    await decoder.flush();
    if (fatal) throw fatal;
    flushBlock();
    await encoder.flush();
    if (fatal) throw fatal;
    encoder.close();
    decoder.close();

    if (!chunks.length) throw unsupported('没有编码出音频数据');
    return { chunks: chunks, channels: channels };
  }

  /* ---------------- 视频：解码 → 抽帧缩放 → 编码 ---------------- */
  async function pickVideoConfig(w, h) {
    var bitrate = Math.max(600000, Math.round(w * h * FPS * 0.07));
    var codecs = (w * h > 1920 * 1088)
      ? ['avc1.640033', 'avc1.4D4033', 'avc1.64002A', 'avc1.4D402A']
      : ['avc1.4D4028', 'avc1.640028', 'avc1.4D401F', 'avc1.42E01E'];
    for (var i = 0; i < codecs.length; i++) {
      var cfg = { codec: codecs[i], width: w, height: h, bitrate: bitrate, framerate: FPS, avc: { format: 'avc' } };
      try {
        var r = await VideoEncoder.isConfigSupported(cfg);
        if (r && r.supported) return cfg;
      } catch (e) {}
    }
    return null;
  }

  async function encodeVideo(samples, avc, opt, muxer) {
    var cfg = await pickVideoConfig(opt.width, opt.height);
    if (!cfg) throw unsupported('当前设备不支持 H.264 编码');

    var totalOut = Math.max(1, Math.round(opt.duration * FPS));
    var nextOut = 0;
    var last = null;
    var fatal = null;

    var canvas = document.createElement('canvas');
    canvas.width = opt.width;
    canvas.height = opt.height;
    var ctx2d = canvas.getContext('2d', { alpha: false });
    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, opt.width, opt.height);

    var encoder = new VideoEncoder({
      output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); },
      error: function (e) { fatal = e; }
    });
    encoder.configure(cfg);

    function emitFrame(src) {
      ctx2d.drawImage(src, 0, 0, opt.width, opt.height);
      var vf = new VideoFrame(canvas, {
        timestamp: Math.round(nextOut * 1e6 / FPS),
        duration: Math.round(1e6 / FPS)
      });
      // 每 1 秒一个关键帧，保证各种播放器都能拖动进度条
      encoder.encode(vf, { keyFrame: nextOut % FPS === 0 });
      vf.close();
      nextOut++;
    }

    // 目标时间轴第 i 帧对应的源视频时间（秒）
    function srcTimeAt(i) {
      return opt.start + (i / FPS) * opt.speed;
    }

    function onFrame(frame) {
      if (fatal) { frame.close(); return; }
      if (nextOut >= totalOut) { frame.close(); return; }
      var ts = (frame.timestamp - baseTs) / 1e6;
      if (last) {
        while (nextOut < totalOut && srcTimeAt(nextOut) < ts) emitFrame(last);
      }
      if (nextOut >= totalOut) { frame.close(); return; }
      if (last) last.close();
      last = frame;
    }

    var decoder = new VideoDecoder({ output: onFrame, error: function (e) { fatal = e; } });
    decoder.configure({ codec: avc.codec, description: avc.description });

    var baseTs = samples[0].cts;
    var startTs = opt.start * samples[0].timescale;
    var firstIdx = 0;
    for (var k = 0; k < samples.length; k++) {
      if (samples[k].cts <= startTs) {
        if (samples[k].is_sync) firstIdx = k;
      } else if (samples[k].is_sync) {
        break;
      }
    }

    for (var i = firstIdx; i < samples.length; i++) {
      if (opt.isCancelled()) throw cancelled();
      if (fatal) throw fatal;
      if (nextOut >= totalOut) break;
      var s = samples[i];
      decoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round((s.cts - baseTs) / s.timescale * 1e6),
        duration: Math.round(s.duration / s.timescale * 1e6),
        data: s.data
      }));
      while (decoder.decodeQueueSize > 12 || encoder.encodeQueueSize > 8) {
        if (fatal) throw fatal;
        if (opt.isCancelled()) throw cancelled();
        await sleep(6);
        if (nextOut >= totalOut) break;
      }
      if (i % 10 === 0) {
        opt.onProgress('编码画面…', 0.2 + 0.79 * (nextOut / totalOut));
        await sleep(0);
      }
    }

    await decoder.flush();
    if (fatal) throw fatal;
    while (nextOut < totalOut && last) emitFrame(last);
    if (last) { last.close(); last = null; }
    await encoder.flush();
    if (fatal) throw fatal;
    encoder.close();
    decoder.close();

    if (!nextOut) throw unsupported('没有解码出画面');
    return nextOut;
  }

  /* ---------------- 主流程 ---------------- */
  async function run(opts) {
    if (!supported()) throw unsupported('当前浏览器不支持离线编码');

    var onProgress = opts.onProgress || function () {};
    var isCancelled = opts.isCancelled || function () { return false; };
    var duration = (opts.end - opts.start) / opts.speed;

    onProgress('读取并解析文件…', 0.01);
    var buffer = await opts.file.arrayBuffer();
    if (isCancelled()) throw cancelled();
    var parsed = await demux(buffer);
    var mp4 = parsed.mp4;
    var info = parsed.info;

    var vt = info.videoTracks && info.videoTracks[0];
    if (!vt) throw unsupported('没有找到视频轨道');

    var at = opts.withAudio && info.audioTracks ? info.audioTracks[0] : null;
    if (at && !/^mp4a/.test(at.codec || '')) at = null;

    onProgress('分离音视频轨道…', 0.02);
    var data = collect(mp4, vt.id, at ? at.id : 0);

    var avc = readAvc(mp4, vt.id);
    if (!avc) {
      // 参数集不在 stsd 里时，从第一个关键帧码流里找
      for (var v = 0; v < data.video.length; v++) {
        if (!data.video[v].is_sync) continue;
        avc = avcFromBitstream(data.video[v]);
        break;
      }
    }
    if (!avc) {
      throw unsupported('视频编码是 ' + (vt.codec || '未知') + '，离线编码只支持 H.264');
    }

    var audio = null;
    if (at) {
      try {
        audio = await encodeAudio(data.audio, at, {
          start: opts.start,
          speed: opts.speed,
          duration: duration,
          onProgress: onProgress,
          isCancelled: isCancelled
        });
      } catch (err) {
        if (err && err.name === 'OfflineCancelled') throw err;
        console.warn('音频离线处理失败，改为导出无声视频', err);
        audio = null;
      }
    }
    if (isCancelled()) throw cancelled();

    var muxer = new (libs().Muxer)({
      target: new (libs().Target)(),
      video: { codec: 'avc', width: opts.width, height: opts.height, frameRate: FPS },
      audio: audio ? { codec: 'aac', numberOfChannels: audio.channels, sampleRate: OUT_RATE } : undefined,
      fastStart: 'in-memory'
    });

    if (audio) {
      for (var i = 0; i < audio.chunks.length; i++) {
        muxer.addAudioChunk(audio.chunks[i].chunk, audio.chunks[i].meta);
      }
    }

    await encodeVideo(data.video, avc, {
      start: opts.start,
      speed: opts.speed,
      duration: duration,
      width: opts.width,
      height: opts.height,
      onProgress: onProgress,
      isCancelled: isCancelled
    }, muxer);

    onProgress('封装 MP4…', 0.995);
    await sleep(0);
    muxer.finalize();
    var bufferOut = muxer.target.buffer;

    return {
      blob: new Blob([bufferOut], { type: 'video/mp4' }),
      duration: duration,
      hasAudio: !!audio,
      width: opts.width,
      height: opts.height
    };
  }

  /* ---------------- 实时录制结果：重建 MP4 索引 ---------------- */
  // MediaRecorder 产出的是分片 MP4，很多播放器无法拖动进度条；
  // 解封装后重新封装成带索引的普通 MP4。
  async function rebuildMp4(blob) {
    if (!libs().mp4box || !libs().Muxer) return null;
    var parsed = await demux(await blob.arrayBuffer());
    var mp4 = parsed.mp4;
    var info = parsed.info;
    var vt = info.videoTracks && info.videoTracks[0];
    if (!vt) return null;
    var avc = readAvc(mp4, vt.id);
    if (!avc) return null;

    var at = info.audioTracks && info.audioTracks[0];
    if (at && !/^mp4a/.test(at.codec || '')) at = null;
    var data = collect(mp4, vt.id, at ? at.id : 0);
    if (!data.video.length) return null;

    var w = (vt.video && vt.video.width) || vt.track_width || 0;
    var h = (vt.video && vt.video.height) || vt.track_height || 0;
    w = Math.max(2, w - (w % 2));
    h = Math.max(2, h - (h % 2));
    if (!w || !h) return null;

    var rate = at ? Math.round((at.audio || {}).sample_rate || 0) : 0;
    var chans = at ? Math.max(1, Math.min(2, (at.audio || {}).channel_count || 2)) : 0;
    var asc = rate ? aacDescription(rate, chans) : null;
    var withAudio = !!(at && asc && data.audio.length);

    var muxer = new (libs().Muxer)({
      target: new (libs().Target)(),
      video: { codec: 'avc', width: w, height: h },
      audio: withAudio ? { codec: 'aac', numberOfChannels: chans, sampleRate: rate } : undefined,
      fastStart: 'in-memory'
    });

    var video = data.video.slice().sort(function (a, b) { return a.cts - b.cts; });
    var vbase = video[0].cts;
    for (var i = 0; i < video.length; i++) {
      var s = video[i];
      muxer.addVideoChunk(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round((s.cts - vbase) / s.timescale * 1e6),
        duration: Math.round(s.duration / s.timescale * 1e6),
        data: s.data
      }), i === 0 ? { decoderConfig: { codec: avc.codec, description: avc.description } } : undefined);
    }

    if (withAudio) {
      var audio = data.audio.slice().sort(function (a, b) { return a.cts - b.cts; });
      var abase = audio[0].cts;
      for (var j = 0; j < audio.length; j++) {
        var a2 = audio[j];
        muxer.addAudioChunk(new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round((a2.cts - abase) / a2.timescale * 1e6),
          duration: Math.round(a2.duration / a2.timescale * 1e6),
          data: a2.data
        }), j === 0 ? {
          decoderConfig: { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: chans, description: asc }
        } : undefined);
      }
    }

    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }

  window.OfflineExport = {
    supported: supported,
    run: run,
    rebuildMp4: rebuildMp4
  };
})();
