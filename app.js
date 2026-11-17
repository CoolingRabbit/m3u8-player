(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const video = $('#video');
  const STORAGE = {
    channels: 'lanlive.channels.v1',
    current: 'lanlive.current.v1',
    settings: 'lanlive.settings.v1',
    scheduleRun: 'lanlive.schedule-run.v1'
  };
  const DEFAULT_CHANNEL = {
    id: 'bloomberg-tv-plus',
    name: 'Bloomberg TV+',
    url: 'https://liveprodusphoenixeast.akamaized.net/USPhx-HD/Channel-TX-USPhx-AWS-virginia-1/Source-USPhx-16k-1-s6lk2-BP-07-02-81ykIWnsMsg_live.m3u8'
  };
  const DEFAULT_SETTINGS = {
    appName: 'm3u8-player',
    auto: true,
    latency: 60,
    buffer: 180,
    scheduleEnabled: true,
    scheduleTime: '04:00',
    intervalEnabled: false,
    intervalMinutes: 60,
    volume: 0.72,
    muted: true
  };

  let channels = loadChannels();
  let currentId = readStorage(STORAGE.current, DEFAULT_CHANNEL.id);
  let settings = { ...DEFAULT_SETTINGS, ...readJson(STORAGE.settings, {}) };
  let hls = null;
  let loadGeneration = 0;
  let retryTimer = null;
  let retryAttempt = 0;
  let toastTimer = null;
  let controlsIdleTimer = null;
  let editingChannelId = null;
  let autoConfigured = false;
  let autoRecommendation = { latency: 6, buffer: 30, window: 0, targetDuration: 2 };
  let downloadEvents = [];
  let chartSamples = Array(30).fill(0);
  let streamStartedAt = performance.now();
  let intervalNextRun = Date.now() + Number(settings.intervalMinutes || 60) * 60000;
  let stallCount = 0;
  let previousStallCount = 0;
  let chartTick = 0;
  let fpsStart = 0;
  let fpsFrames = 0;
  let measuredFps = 0;
  let lastFrameSampleTime = 0;
  let lastTotalFrames = 0;
  let levelFps = 0;
  let levelBitrate = 0;

  function readStorage(key, fallback = null) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      showToast('浏览器未允许本地存储，设置仅在本次打开期间有效');
    }
  }

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function validChannel(channel) {
    if (!channel || typeof channel.name !== 'string' || typeof channel.url !== 'string') return false;
    try {
      return ['http:', 'https:'].includes(new URL(channel.url).protocol);
    } catch {
      return false;
    }
  }

  function loadChannels() {
    const saved = readJson(STORAGE.channels, null);
    if (!Array.isArray(saved)) return [{ ...DEFAULT_CHANNEL }];
    const valid = saved.filter(validChannel).map((channel) => ({
      id: String(channel.id || makeId()),
      name: channel.name.trim(),
      url: channel.url
    }));
    return valid.length ? valid : [{ ...DEFAULT_CHANNEL }];
  }

  function makeId() {
    return globalThis.crypto?.randomUUID?.() || `channel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function currentChannel() {
    return channels.find((channel) => channel.id === currentId) || channels[0];
  }

  function saveChannels() {
    writeStorage(STORAGE.channels, JSON.stringify(channels));
    writeStorage(STORAGE.current, currentId);
  }

  function saveSettings() {
    writeStorage(STORAGE.settings, JSON.stringify(settings));
  }

  function showToast(message) {
    $('#toastText').textContent = message;
    $('#toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2800);
  }

  function setStatus(text, state = 'ready') {
    $('#systemStatus').textContent = text;
    $('#statusDot').className = `status-dot${state === 'ready' ? '' : ` ${state}`}`;
  }

  function setLoading(visible, label = '正在连接直播流...') {
    $('#playerLoading').hidden = !visible;
    $('#loadingLabel').textContent = label;
    if (visible) $('#playerError').hidden = true;
  }

  function setReloadBusy(busy) {
    $('#reloadButton').classList.toggle('loading', busy);
    $('#reloadButton span').textContent = busy ? '正在重新连接...' : '立即重新拉流';
    $('#playerReloadButton').classList.toggle('loading', busy);
    $('#playerReloadButton').disabled = busy;
  }

  function createChannelCard(channel) {
    const url = new URL(channel.url);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `channel-card${channel.id === currentId ? ' active' : ''}`;
    card.dataset.id = channel.id;
    card.dataset.name = channel.name;
    card.dataset.domain = url.hostname;

    const logo = document.createElement('span');
    logo.className = 'channel-logo';
    logo.textContent = channel.name.trim().charAt(0).toUpperCase() || 'L';
    const content = document.createElement('span');
    const titleRow = document.createElement('span');
    titleRow.className = 'channel-title-row';
    const title = document.createElement('span');
    title.className = 'channel-name';
    title.textContent = channel.name;
    title.title = channel.name;
    const liveDot = document.createElement('span');
    liveDot.className = 'live-dot';
    const domain = document.createElement('span');
    domain.className = 'domain-tag';
    domain.title = url.hostname;
    domain.innerHTML = '<svg class="icon"><use href="#i-globe"/></svg>';
    const domainText = document.createElement('span');
    domainText.textContent = url.hostname;

    domain.appendChild(domainText);
    titleRow.append(title, liveDot);
    content.append(titleRow, domain);
    card.append(logo, content);
    card.addEventListener('click', () => selectChannel(channel.id));
    return card;
  }

  function renderChannels() {
    $('#channelList').replaceChildren(...channels.map(createChannelCard));
    $('#channelCount').textContent = channels.length;
    $('#channelTotal').textContent = `${channels.length} 路直播`;
    $('#deleteChannel').disabled = channels.length <= 1;
    filterChannels();
  }

  function filterChannels() {
    const keyword = $('#channelSearch').value.trim().toLowerCase();
    let visible = 0;
    $$('.channel-card').forEach((card) => {
      const matches = `${card.dataset.name} ${card.dataset.domain}`.toLowerCase().includes(keyword);
      card.classList.toggle('hidden', !matches);
      if (matches) visible += 1;
    });
    $('#emptySearch').classList.toggle('visible', visible === 0);
  }

  function updateChannelHeading() {
    const channel = currentChannel();
    currentId = channel.id;
    $('#currentChannel').textContent = channel.name;
    $('#channelIntro h2').textContent = channel.name;
    document.title = `${channel.name} · ${settings.appName}`;
    saveChannels();
  }

  function applyAppName(value) {
    settings.appName = value.trim().slice(0, 32) || DEFAULT_SETTINGS.appName;
    $('#appNameInput').value = settings.appName;
    saveSettings();
    updateChannelHeading();
  }

  function selectChannel(id) {
    if (id === currentId && (hls || video.src)) return;
    currentId = id;
    updateChannelHeading();
    renderChannels();
    loadStream('channel');
  }

  function openChannelDialog(channel = null) {
    editingChannelId = channel?.id || null;
    $('#channelForm').reset();
    $('#channelDialog h2').textContent = channel ? '编辑直播频道' : '添加直播频道';
    $('#channelForm button[type="submit"]').innerHTML = `<svg class="icon"><use href="${channel ? '#i-check' : '#i-plus'}"/></svg>${channel ? '保存修改' : '添加频道'}`;
    if (channel) {
      $('#channelName').value = channel.name;
      $('#channelUrl').value = channel.url;
    }
    $('#channelDialog').showModal();
    setTimeout(() => $('#channelName').focus(), 50);
  }

  function closeChannelDialog() {
    $('#channelDialog').close();
    $('#channelForm').reset();
    editingChannelId = null;
  }

  function resetMetrics() {
    downloadEvents = [];
    chartSamples = Array(30).fill(0);
    streamStartedAt = performance.now();
    stallCount = 0;
    measuredFps = 0;
    levelFps = 0;
    levelBitrate = 0;
    fpsStart = 0;
    fpsFrames = 0;
    ['#metricResolution', '#metricFps', '#metricBitrate', '#metricLatency', '#metricBuffer'].forEach((selector) => $(selector).classList.add('pending'));
    $('#metricResolution').textContent = '-- × --';
    $('#metricFps').innerHTML = '-- <small>FPS</small>';
    $('#metricBitrate').innerHTML = '-- <small>Mbps</small>';
    $('#metricLatency').innerHTML = '-- <small>秒</small>';
    $('#metricBuffer').innerHTML = '-- <small>秒</small>';
    $('#controlLatency').textContent = '-- 秒';
    $('#qualityPill').textContent = '自动识别';
    $('#bitrateFoot').textContent = '等待分片统计';
    $('#fpsFoot').textContent = '实时采样';
    $('#bufferFoot').textContent = '等待缓冲数据';
    $('.health-badge').textContent = '等待数据';
    $$('.health-summary strong')[0].textContent = '-- Mbps';
    $$('.health-summary strong')[1].textContent = '0 次';
    $$('.health-summary strong')[2].textContent = '--';
    updateChart();
  }

  function playbackConfig() {
    const latency = settings.auto ? autoRecommendation.latency : Number(settings.latency);
    const buffer = settings.auto ? autoRecommendation.buffer : Number(settings.buffer);
    return {
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 60,
      maxBufferLength: buffer,
      maxMaxBufferLength: Math.max(300, buffer),
      maxBufferSize: 200 * 1000 * 1000,
      liveSyncDuration: latency,
      liveMaxLatencyDuration: latency + Math.max(12, autoRecommendation.targetDuration * 4),
      maxLiveSyncPlaybackRate: 1.5,
      manifestLoadingMaxRetry: 2,
      manifestLoadingRetryDelay: 1000,
      levelLoadingMaxRetry: 3,
      levelLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: 3,
      fragLoadingRetryDelay: 1000
    };
  }

  function destroyStream() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
    $('#playerStage').classList.remove('playing');
  }

  function loadStream(reason = 'manual') {
    const channel = currentChannel();
    const generation = ++loadGeneration;
    if (reason !== 'retry') retryAttempt = 0;
    previousStallCount = stallCount;
    autoConfigured = false;
    resetIntervalCountdown();
    destroyStream();
    resetMetrics();
    $('#playerError').hidden = true;
    const loadingLabels = {
      scheduled: '每日定时重新拉流...',
      interval: '倒计时重新拉流...'
    };
    setLoading(true, loadingLabels[reason] || '正在连接直播流...');
    setReloadBusy(true);
    setStatus('正在连接直播', 'loading');
    $('#streamLabel').textContent = 'HLS · 正在连接';
    $('#optimizationToast span').textContent = '正在分析直播参数';

    if (window.Hls?.isSupported()) {
      hls = new Hls(playbackConfig());
      bindHlsEvents(generation);
      hls.loadSource(channel.url);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = channel.url;
      video.addEventListener('loadedmetadata', playVideo, { once: true });
    } else {
      showPlaybackError('当前浏览器不支持 HLS，请使用最新版 Edge、Chrome 或 Safari。');
    }
  }

  function bindHlsEvents(generation) {
    const active = () => generation === loadGeneration;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!active()) return;
      setStatus('直播清单已加载', 'loading');
      playVideo();
    });
    hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
      if (!active()) return;
      const details = data.details;
      $('#streamLabel').textContent = details.live ? 'HLS · LIVE' : 'HLS · VOD';
      if (settings.auto && !autoConfigured) {
        recommendAuto(details.totalduration, details.targetduration || 2, details.live);
        applyAutoRecommendation();
        autoConfigured = true;
      }
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      if (!active()) return;
      const level = hls.levels[data.level];
      if (!level) return;
      levelFps = Number(level.attrs?.['FRAME-RATE']) || 0;
      levelBitrate = Number(level.averageBitrate || level.bitrate) || 0;
      if (level.width && level.height) updateResolution(level.width, level.height);
      updateFallbackStats();
    });
    hls.on(Hls.Events.FRAG_BUFFERED, (_, data) => {
      if (!active()) return;
      const stats = data.stats || data.frag?.stats;
      const bytes = Number(stats?.loaded || stats?.total || 0);
      if (bytes > 0) downloadEvents.push({ time: performance.now(), bytes });
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!active() || !data.fatal) return;
      handleFatalError(data);
    });
  }

  function recommendAuto(windowSeconds, targetDuration = 2, live = true) {
    const target = Math.max(0.5, Number(targetDuration) || 2);
    if (!live || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      autoRecommendation = { latency: 0, buffer: 60, window: windowSeconds || 0, targetDuration: target };
    } else {
      const usable = Math.max(1.5, windowSeconds - target);
      const stabilityBoost = Math.min(8, previousStallCount * target * 0.5);
      const latency = Math.max(1.5, Math.min(24, usable * 0.65 + stabilityBoost, usable));
      const buffer = Math.max(Math.min(2, windowSeconds * 0.5), Math.min(60, windowSeconds * 0.8));
      autoRecommendation = {
        latency: Math.round(latency * 10) / 10,
        buffer: Math.round(buffer * 10) / 10,
        window: windowSeconds,
        targetDuration: target
      };
    }
    renderSettings();
  }

  function applyAutoRecommendation() {
    if (!hls || !settings.auto) return;
    hls.config.liveSyncDuration = autoRecommendation.latency;
    hls.config.liveMaxLatencyDuration = autoRecommendation.latency + Math.max(12, autoRecommendation.targetDuration * 4);
    hls.config.maxBufferLength = autoRecommendation.buffer;
    $('#optimizationToast span').textContent = `自动参数：延迟 ${autoRecommendation.latency} 秒 · 缓存 ${autoRecommendation.buffer} 秒`;
  }

  function handleFatalError(data) {
    retryAttempt += 1;
    const detail = data.response?.code ? `HTTP ${data.response.code}` : data.details || '播放错误';
    if (retryAttempt > 5) {
      showPlaybackError(`连续重连仍未成功（${detail}）。请检查网络、播放地址及服务端 CORS 设置。`);
      return;
    }
    const delay = Math.min(15000, 1000 * 2 ** (retryAttempt - 1));
    setLoading(true, `连接中断，${Math.ceil(delay / 1000)} 秒后进行第 ${retryAttempt} 次重连...`);
    setStatus('连接中断，等待重试', 'error');
    setReloadBusy(false);
    retryTimer = setTimeout(() => loadStream('retry'), delay);
  }

  function showPlaybackError(message) {
    setLoading(false);
    setReloadBusy(false);
    setStatus('直播连接失败', 'error');
    $('#playerError').hidden = false;
    $('#errorCopy').textContent = message;
    $('#streamLabel').textContent = 'HLS · 连接失败';
  }

  async function playVideo() {
    try {
      await video.play();
    } catch {
      setLoading(false);
      setReloadBusy(false);
      setStatus('点击播放按钮开始直播');
      updatePlayButton();
    }
  }

  function updatePlayButton() {
    const playing = !video.paused && !video.ended;
    $('#playButton use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    $('#playButton').setAttribute('aria-label', playing ? '暂停' : '播放');
    $('#playerStage').classList.toggle('playing', playing && video.readyState >= 2);
    $('#unmuteHint').hidden = !video.muted || !playing;
  }

  function updateResolution(width, height) {
    if (!width || !height) return;
    $('#metricResolution').textContent = `${width} × ${height}`;
    $('#metricResolution').classList.remove('pending');
    $('#qualityPill').textContent = `${height}p · 自动`;
  }

  function updateFallbackStats() {
    if (!measuredFps && levelFps) {
      $('#metricFps').innerHTML = `${levelFps.toFixed(2)} <small>FPS</small>`;
      $('#metricFps').classList.remove('pending');
      $('#fpsFoot').textContent = '直播清单标称';
    }
    if (!downloadEvents.length && levelBitrate) {
      $('#metricBitrate').innerHTML = `${(levelBitrate / 1000000).toFixed(2)} <small>Mbps</small>`;
      $('#metricBitrate').classList.remove('pending');
      $('#bitrateFoot').textContent = '直播清单标称';
    }
  }

  function bufferedAhead() {
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.currentTime >= video.buffered.start(index) - 0.5 && video.currentTime <= video.buffered.end(index)) {
        return Math.max(0, video.buffered.end(index) - video.currentTime);
      }
    }
    return 0;
  }

  function liveLatency() {
    if (!video.seekable.length) return null;
    const edge = video.seekable.end(video.seekable.length - 1);
    return Number.isFinite(edge) ? Math.max(0, edge - video.currentTime) : null;
  }

  function currentBitrate(now) {
    downloadEvents = downloadEvents.filter((event) => now - event.time <= 10000);
    if (!downloadEvents.length) return 0;
    const bytes = downloadEvents.reduce((sum, event) => sum + event.bytes, 0);
    const windowSeconds = Math.min(10, Math.max(1, (now - streamStartedAt) / 1000));
    return bytes * 8 / windowSeconds / 1000000;
  }

  function updateChart() {
    const max = Math.max(5, ...chartSamples) * 1.15;
    const points = chartSamples.map((value, index) => {
      const x = index * 500 / Math.max(1, chartSamples.length - 1);
      const y = 44 - value / max * 36;
      return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    $('.chart-line').setAttribute('d', points);
    $('.chart-area').setAttribute('d', `${points}L500 48L0 48Z`);
  }

  function updateStats() {
    const now = performance.now();
    const buffer = bufferedAhead();
    const latency = liveLatency();
    const bitrate = currentBitrate(now);

    if (video.videoWidth && video.videoHeight) updateResolution(video.videoWidth, video.videoHeight);
    if (latency !== null) {
      $('#metricLatency').innerHTML = `${latency.toFixed(1)} <small>秒</small>`;
      $('#metricLatency').classList.remove('pending');
      $('#controlLatency').textContent = `${latency.toFixed(1)} 秒`;
    }
    if (video.buffered.length) {
      $('#metricBuffer').innerHTML = `${buffer.toFixed(1)} <small>秒</small>`;
      $('#metricBuffer').classList.remove('pending');
      $('#bufferFoot').textContent = buffer >= autoRecommendation.targetDuration * 2 ? '缓冲状态良好' : '缓存偏低';
      $('#bufferFoot').classList.toggle('good', buffer >= autoRecommendation.targetDuration * 2);
    }
    if (bitrate > 0) {
      $('#metricBitrate').innerHTML = `${bitrate.toFixed(2)} <small>Mbps</small>`;
      $('#metricBitrate').classList.remove('pending');
      $('#bitrateFoot').textContent = '近 10 秒分片实测';
      $$('.health-summary strong')[0].textContent = `${bitrate.toFixed(2)} Mbps`;
    } else {
      updateFallbackStats();
    }

    const quality = video.getVideoPlaybackQuality?.();
    if (quality?.totalVideoFrames) {
      if (document.hidden) {
        lastFrameSampleTime = 0;
        lastTotalFrames = quality.totalVideoFrames;
      } else {
        const elapsed = now - lastFrameSampleTime;
        const frames = quality.totalVideoFrames - lastTotalFrames;
        if (lastFrameSampleTime && elapsed >= 2000 && frames >= 0) {
          measuredFps = frames * 1000 / elapsed;
          if (measuredFps > 1 && measuredFps < 240) {
            $('#metricFps').innerHTML = `${measuredFps.toFixed(2)} <small>FPS</small>`;
            $('#metricFps').classList.remove('pending');
            $('#fpsFoot').textContent = '解码帧计数实测';
          }
          lastFrameSampleTime = now;
          lastTotalFrames = quality.totalVideoFrames;
        } else if (!lastFrameSampleTime || frames < 0) {
          lastFrameSampleTime = now;
          lastTotalFrames = quality.totalVideoFrames;
        }
      }
      const dropRate = quality.droppedVideoFrames / quality.totalVideoFrames * 100;
      $$('.health-summary strong')[2].textContent = `${dropRate.toFixed(2)}%`;
    }
    $$('.health-summary strong')[1].textContent = `${stallCount} 次`;
    const badge = $('.health-badge');
    badge.className = 'health-badge';
    if (!video.paused && buffer < autoRecommendation.targetDuration && video.readyState < 3) {
      badge.textContent = '正在缓冲';
      badge.classList.add('warning');
    } else if (stallCount >= 3) {
      badge.textContent = '线路有波动';
      badge.classList.add('warning');
    } else if (bitrate > 0) {
      badge.textContent = '线路稳定';
    }

    chartTick += 1;
    if (chartTick % 2 === 0) {
      chartSamples.push(bitrate);
      chartSamples.shift();
      updateChart();
    }
  }

  function sampleFrames(now) {
    if (video.getVideoPlaybackQuality) return;
    if (document.hidden) {
      fpsStart = 0;
      fpsFrames = 0;
    } else {
      if (!fpsStart) fpsStart = now;
      fpsFrames += 1;
      if (now - fpsStart >= 2000) {
        measuredFps = fpsFrames * 1000 / (now - fpsStart);
        if (measuredFps > 1 && measuredFps < 240) {
          $('#metricFps').innerHTML = `${measuredFps.toFixed(2)} <small>FPS</small>`;
          $('#metricFps').classList.remove('pending');
          $('#fpsFoot').textContent = '画面回调实测';
        }
        fpsStart = now;
        fpsFrames = 0;
      }
    }
    video.requestVideoFrameCallback(sampleFrames);
  }

  function setRangeProgress(input) {
    const progress = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
    input.style.setProperty('--progress', `${progress}%`);
  }

  function renderSettings() {
    $('#autoToggle').checked = settings.auto;
    $('#scheduleToggle').checked = settings.scheduleEnabled;
    $('#scheduleTime').value = settings.scheduleTime;
    $('#scheduleTime').disabled = !settings.scheduleEnabled;
    $('.next-reload').style.opacity = settings.scheduleEnabled ? '1' : '0.42';
    $('#intervalToggle').checked = settings.intervalEnabled;
    $('#intervalMinutes').value = settings.intervalMinutes;
    $('#intervalMinutes').disabled = !settings.intervalEnabled;
    $('#intervalCountdownCard').style.opacity = settings.intervalEnabled ? '1' : '0.42';
    $('#latencyRange').disabled = settings.auto;
    $('#bufferRange').disabled = settings.auto;
    $('#latencyValue').classList.toggle('auto', settings.auto);
    $('#bufferValue').classList.toggle('auto', settings.auto);
    $('#smartCard').classList.toggle('manual', !settings.auto);
    $('.auto-status').classList.toggle('manual', !settings.auto);
    $('.auto-status').innerHTML = `<svg class="icon"><use href="#i-sparkles"/></svg>${settings.auto ? '智能优化已开启' : '手动参数模式'}`;

    const latency = settings.auto ? autoRecommendation.latency : Number(settings.latency);
    const buffer = settings.auto ? autoRecommendation.buffer : Number(settings.buffer);
    $('#latencyRange').min = settings.auto ? '1' : '5';
    $('#bufferRange').min = settings.auto ? '2' : '20';
    $('#latencyRange').step = settings.auto ? '0.1' : '1';
    $('#bufferRange').step = settings.auto ? '0.1' : '1';
    $('#latencyRange').value = latency;
    $('#bufferRange').value = buffer;
    $('#latencyValue').textContent = `${settings.auto ? '自动 · ' : ''}${latency} 秒`;
    $('#bufferValue').textContent = `${settings.auto ? '自动 · ' : ''}${buffer} 秒`;
    $('#smartLatency').innerHTML = `${latency} <small>秒</small>`;
    $('#smartBuffer').innerHTML = `${buffer} <small>秒</small>`;
    $('#smartTitle').textContent = settings.auto ? '已选择推荐参数' : '手动参数模式';
    $('#smartCopy').textContent = settings.auto
      ? autoRecommendation.window > 0
        ? `检测到直播窗口约 ${autoRecommendation.window.toFixed(1)} 秒，已结合分片时长与播放稳定性设置参数；实际能力受服务端窗口限制。`
        : '正在读取直播窗口，随后会结合分片时长、实时网速与卡顿情况自动平衡延迟和稳定性。'
      : '延迟和缓存由你手动设置，修改后会自动重新拉流以应用新参数。';
    setRangeProgress($('#latencyRange'));
    setRangeProgress($('#bufferRange'));
  }

  function scheduleKey(date = new Date()) {
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return `${day} ${settings.scheduleTime}`;
  }

  function scheduledTimeToday(now = new Date()) {
    const [hours, minutes] = settings.scheduleTime.split(':').map(Number);
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    return target;
  }

  function markCurrentScheduleDone() {
    const now = new Date();
    if (now >= scheduledTimeToday(now)) writeStorage(STORAGE.scheduleRun, scheduleKey(now));
  }

  function formatCountdown(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function updateNextReload() {
    if (!settings.scheduleEnabled) {
      $('#nextReload').textContent = '定时任务已关闭';
      return;
    }
    const now = new Date();
    const target = scheduledTimeToday(now);
    if (target <= now) target.setDate(target.getDate() + 1);
    const totalSeconds = Math.max(0, Math.floor((target - now) / 1000));
    $('#nextReload').textContent = formatCountdown(totalSeconds);
  }

  function resetIntervalCountdown() {
    const minutes = Math.max(1, Math.min(1440, Number(settings.intervalMinutes) || 60));
    intervalNextRun = Date.now() + minutes * 60000;
    updateIntervalReload();
  }

  function updateIntervalReload() {
    if (!settings.intervalEnabled) {
      $('#nextIntervalReload').textContent = '倒计时任务已关闭';
      return;
    }
    const totalSeconds = Math.max(0, Math.ceil((intervalNextRun - Date.now()) / 1000));
    $('#nextIntervalReload').textContent = formatCountdown(totalSeconds);
  }

  function checkSchedule() {
    updateNextReload();
    updateIntervalReload();
    const now = new Date();
    if (settings.scheduleEnabled && now >= scheduledTimeToday(now)) {
      const key = scheduleKey(now);
      if (readStorage(STORAGE.scheduleRun) !== key) {
        writeStorage(STORAGE.scheduleRun, key);
        showToast(`已到 ${settings.scheduleTime}，正在执行每日重新拉流`);
        loadStream('scheduled');
        return;
      }
    }
    if (settings.intervalEnabled && Date.now() >= intervalNextRun) {
      showToast(`已完成 ${settings.intervalMinutes} 分钟倒计时，正在重新拉流`);
      loadStream('interval');
    }
  }

  $('#addChannelTop').addEventListener('click', () => openChannelDialog());
  $('#addChannelBottom').addEventListener('click', () => openChannelDialog());
  $('#editChannel').addEventListener('click', () => openChannelDialog(currentChannel()));
  $('#closeDialog').addEventListener('click', closeChannelDialog);
  $('#cancelDialog').addEventListener('click', closeChannelDialog);
  $('#channelDialog').addEventListener('click', (event) => {
    if (event.target === $('#channelDialog')) closeChannelDialog();
  });
  $('#channelSearch').addEventListener('input', filterChannels);

  $('#channelForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('#channelName').value.trim();
    let url;
    try {
      url = new URL($('#channelUrl').value.trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      showToast('请输入有效的 HTTP 或 HTTPS 播放地址');
      return;
    }
    if (!name) return;

    if (editingChannelId) {
      const channel = channels.find((item) => item.id === editingChannelId);
      if (channel) {
        channel.name = name;
        channel.url = url.href;
      }
    } else {
      channels.push({ id: makeId(), name, url: url.href });
      currentId = channels.at(-1).id;
    }
    const successMessage = editingChannelId ? '频道修改已保存' : '频道已添加';
    saveChannels();
    updateChannelHeading();
    renderChannels();
    closeChannelDialog();
    loadStream('channel');
    showToast(successMessage);
  });

  $('#deleteChannel').addEventListener('click', () => {
    if (channels.length <= 1) return;
    const channel = currentChannel();
    if (!confirm(`确定删除频道“${channel.name}”吗？`)) return;
    channels = channels.filter((item) => item.id !== currentId);
    currentId = channels[0].id;
    saveChannels();
    updateChannelHeading();
    renderChannels();
    loadStream('channel');
    showToast('频道已删除');
  });

  $('#playButton').addEventListener('click', () => {
    if (video.paused) playVideo();
    else video.pause();
  });
  video.addEventListener('dblclick', toggleFullscreen);
  video.addEventListener('play', () => {
    updatePlayButton();
    showPlayerControls();
  });
  video.addEventListener('pause', () => {
    updatePlayButton();
    setLoading(false);
    setStatus('播放已暂停');
    clearTimeout(controlsIdleTimer);
    $('#playerCard').classList.remove('is-idle');
  });
  video.addEventListener('playing', () => {
    retryAttempt = 0;
    setLoading(false);
    setReloadBusy(false);
    setStatus('直播播放中');
    updatePlayButton();
    showPlayerControls();
  });
  video.addEventListener('canplay', () => {
    setLoading(false);
    setReloadBusy(false);
  });
  video.addEventListener('waiting', () => {
    if (video.paused) return;
    stallCount += 1;
    showPlayerControls();
    setLoading(true, '网络缓冲中...');
    setStatus('正在缓冲', 'loading');
  });
  video.addEventListener('loadedmetadata', () => {
    updateResolution(video.videoWidth, video.videoHeight);
  });
  video.addEventListener('volumechange', () => {
    settings.volume = video.volume;
    settings.muted = video.muted;
    saveSettings();
    $('#volumeSlider').value = Math.round(video.volume * 100);
    $('#muteButton').setAttribute('aria-label', video.muted ? '取消静音' : '静音');
    $('#muteButton').style.opacity = video.muted ? '0.55' : '1';
    updatePlayButton();
  });
  video.addEventListener('error', () => {
    if (!video.src && !hls) return;
    showPlaybackError('浏览器无法解码或读取当前直播流，请稍后重试。');
  });

  $('#muteButton').addEventListener('click', () => {
    if (video.muted && video.volume === 0) video.volume = 0.72;
    video.muted = !video.muted;
  });
  $('#volumeSlider').addEventListener('input', (event) => {
    video.volume = Number(event.target.value) / 100;
    video.muted = video.volume === 0;
  });

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('#playerCard').requestFullscreen();
    } catch {
      showToast('当前浏览器未允许全屏');
    }
  }

  function showPlayerControls() {
    const player = $('#playerCard');
    player.classList.remove('is-idle');
    player.classList.add('controls-visible');
    clearTimeout(controlsIdleTimer);
    if (document.fullscreenElement !== player || video.paused) return;
    controlsIdleTimer = setTimeout(() => {
      if (document.fullscreenElement === player && !video.paused) {
        player.classList.remove('controls-visible');
        player.classList.add('is-idle');
      }
    }, 3000);
  }

  async function openSettings() {
    if (document.fullscreenElement) await document.exitFullscreen();
    $('.settings-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#fullscreenButton').addEventListener('click', toggleFullscreen);
  $('#settingsButton').addEventListener('click', openSettings);
  $('#reloadButton').addEventListener('click', () => loadStream('manual'));
  $('#playerReloadButton').addEventListener('click', () => loadStream('manual'));
  $('#retryButton').addEventListener('click', () => loadStream('manual'));
  document.addEventListener('fullscreenchange', () => {
    $('#fullscreenButton').setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '全屏');
    showPlayerControls();
  });
  ['mousemove', 'pointerdown', 'touchstart'].forEach((eventName) => {
    $('#playerCard').addEventListener(eventName, showPlayerControls, { passive: true });
  });
  document.addEventListener('keydown', (event) => {
    showPlayerControls();
    if (event.target.closest('input, button, dialog')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (video.paused) playVideo();
      else video.pause();
    } else if (event.key.toLowerCase() === 'f') {
      toggleFullscreen();
    } else if (event.key.toLowerCase() === 'm') {
      video.muted = !video.muted;
    }
  });
  $('#appNameInput').addEventListener('change', (event) => applyAppName(event.target.value));
  $('#appNameInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.target.blur();
  });

  $('#autoToggle').addEventListener('change', (event) => {
    settings.auto = event.target.checked;
    saveSettings();
    renderSettings();
    loadStream('settings');
  });
  $('#latencyRange').addEventListener('input', (event) => {
    $('#latencyValue').textContent = `${event.target.value} 秒`;
    $('#smartLatency').innerHTML = `${event.target.value} <small>秒</small>`;
    setRangeProgress(event.target);
  });
  $('#bufferRange').addEventListener('input', (event) => {
    $('#bufferValue').textContent = `${event.target.value} 秒`;
    $('#smartBuffer').innerHTML = `${event.target.value} <small>秒</small>`;
    setRangeProgress(event.target);
  });
  $('#latencyRange').addEventListener('change', (event) => {
    settings.latency = Number(event.target.value);
    saveSettings();
    loadStream('settings');
  });
  $('#bufferRange').addEventListener('change', (event) => {
    settings.buffer = Number(event.target.value);
    saveSettings();
    loadStream('settings');
  });
  $('#scheduleToggle').addEventListener('change', (event) => {
    settings.scheduleEnabled = event.target.checked;
    if (settings.scheduleEnabled) settings.intervalEnabled = false;
    saveSettings();
    markCurrentScheduleDone();
    resetIntervalCountdown();
    renderSettings();
    updateNextReload();
    updateIntervalReload();
  });
  $('#scheduleTime').addEventListener('change', (event) => {
    settings.scheduleTime = event.target.value || '04:00';
    saveSettings();
    markCurrentScheduleDone();
    updateNextReload();
  });
  $('#intervalToggle').addEventListener('change', (event) => {
    settings.intervalEnabled = event.target.checked;
    if (settings.intervalEnabled) settings.scheduleEnabled = false;
    saveSettings();
    markCurrentScheduleDone();
    resetIntervalCountdown();
    renderSettings();
    updateNextReload();
    updateIntervalReload();
  });
  $('#intervalMinutes').addEventListener('change', (event) => {
    settings.intervalMinutes = Math.max(1, Math.min(1440, Math.round(Number(event.target.value)) || 60));
    event.target.value = settings.intervalMinutes;
    saveSettings();
    resetIntervalCountdown();
    renderSettings();
  });
  window.addEventListener('online', () => {
    showToast('网络已恢复，正在重新连接');
    loadStream('manual');
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkSchedule();
  });
  window.addEventListener('beforeunload', () => {
    clearTimeout(controlsIdleTimer);
    destroyStream();
  });

  if (!channels.some((channel) => channel.id === currentId)) currentId = channels[0].id;
  if (settings.intervalEnabled) settings.scheduleEnabled = false;
  settings.intervalMinutes = Math.max(1, Math.min(1440, Number(settings.intervalMinutes) || 60));
  video.volume = Math.max(0, Math.min(1, Number(settings.volume)));
  video.muted = settings.muted !== false;
  applyAppName(String(settings.appName || DEFAULT_SETTINGS.appName));
  renderChannels();
  renderSettings();
  updateNextReload();
  resetIntervalCountdown();
  markCurrentScheduleDone();
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(sampleFrames);
  else $('#fpsFoot').textContent = '使用清单标称值';
  loadStream('initial');
  setInterval(updateStats, 1000);
  setInterval(checkSchedule, 1000);
})();
