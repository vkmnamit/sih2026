/**
 * Eklavya — 30–60s Video Reels Studio & Vertical Player Logic (public/reels.js)
 *
 * Implements the Eklavya Reel Manifest architecture:
 *   Upload Video (via modal or dropzone)
 *        ↓
 *   POST /api/ingest/video
 *        ↓
 *   GET /api/reels?source=...
 *        ↓
 *   Reel Manifest (reels: [{ id, start, end, duration, title, video, captions, transcript, takeaways }])
 *        ↓
 *   Vertical 9:16 Reel Player (Hook Title, Captions, Takeaways Sheet, Swipe ↑/↓)
 */
(function () {
  'use strict';

  // ---------- Elements ----------
  const sourceSelect = document.getElementById('sourceSelect');
  const durationSelect = document.getElementById('durationSelect');
  const genReelsBtn = document.getElementById('genReelsBtn');
  const statusBadge = document.getElementById('statusBadge');
  const chaptersSidebar = document.getElementById('chaptersSidebar');

  // Reels Feed (below the player)
  const reelsFeedWrap = document.getElementById('reelsFeedWrap');
  const reelsFeed = document.getElementById('reelsFeed');
  const reelsFeedCount = document.getElementById('reelsFeedCount');

  const viewport = document.getElementById('viewport');
  const viewportEmpty = document.getElementById('viewportEmpty');
  const emptyUploadBtn = document.getElementById('emptyUploadBtn');
  const mainVideo = document.getElementById('mainVideo');
  const blurVideo = document.getElementById('blurVideo');
  const playPulse = document.getElementById('playPulse');
  const reelCountBadge = document.getElementById('reelCountBadge');
  const timeRangePill = document.getElementById('timeRangePill');
  const captionText = document.getElementById('captionText');
  const hookTitle = document.getElementById('hookTitle');
  const hookDesc = document.getElementById('hookDesc');
  const tagsRow = document.getElementById('tagsRow');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');

  const likeBtn = document.getElementById('likeBtn');
  const likeCount = document.getElementById('likeCount');
  const summaryBtn = document.getElementById('summaryBtn');
  const transcriptBtn = document.getElementById('transcriptBtn');
  const muteBtn = document.getElementById('muteBtn');
  const muteLabel = document.getElementById('muteLabel');
  const downloadBtn = document.getElementById('downloadBtn');

  // Modals
  const openUploadBtn = document.getElementById('openUploadBtn');
  const uploadModal = document.getElementById('uploadModal');
  const closeUpload = document.getElementById('closeUpload');
  const cancelUploadBtn = document.getElementById('cancelUploadBtn');
  const uploadDropzone = document.getElementById('uploadDropzone');
  const videoFileInput = document.getElementById('videoFileInput');
  const uploadFileBadge = document.getElementById('uploadFileBadge');
  const uploadFileName = document.getElementById('uploadFileName');
  const uploadFileSize = document.getElementById('uploadFileSize');
  const uploadFileClear = document.getElementById('uploadFileClear');
  const submitUploadBtn = document.getElementById('submitUploadBtn');
  const uploadProgress = document.getElementById('uploadProgress');
  const uploadStatus = document.getElementById('uploadStatus');

  const summaryModal = document.getElementById('summaryModal');
  const closeSummary = document.getElementById('closeSummary');
  const modalHookTitle = document.getElementById('modalHookTitle');
  const modalSummaryText = document.getElementById('modalSummaryText');
  const modalTimestampText = document.getElementById('modalTimestampText');

  const transcriptModal = document.getElementById('transcriptModal');
  const closeTranscript = document.getElementById('closeTranscript');
  const modalTranscriptText = document.getElementById('modalTranscriptText');

  // ---------- State ----------
  let currentSource = '';
  let reelList = [];
  let currentIndex = 0;
  let isLiked = false;
  let isMuted = false;
  let isPlaying = false;
  let pollTimer = null;
  let selectedUploadFile = null;
  let knownReelIds = new Set();
  let feedSource = '';

  // ---------- Helpers ----------
  function formatTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function setStatus(msg, type = 'idle') {
    statusBadge.className = `status-pill ${type}`;
    statusBadge.innerHTML = `<span>${msg}</span>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- Upload Modal Handlers ----------
  function openUpload() {
    uploadModal.classList.add('open');
    setUploadFile(null);
    uploadStatus.textContent = '';
  }
  function closeUploadModal() {
    uploadModal.classList.remove('open');
    setUploadFile(null);
  }

  openUploadBtn.addEventListener('click', openUpload);
  if (emptyUploadBtn) emptyUploadBtn.addEventListener('click', openUpload);
  closeUpload.addEventListener('click', closeUploadModal);
  cancelUploadBtn.addEventListener('click', closeUploadModal);
  uploadModal.addEventListener('click', (e) => {
    if (e.target === uploadModal) closeUploadModal();
  });

  uploadDropzone.addEventListener('click', () => videoFileInput.click());
  videoFileInput.addEventListener('change', () => setUploadFile(videoFileInput.files[0]));
  uploadDropzone.addEventListener('dragover', (e) => { e.preventDefault(); uploadDropzone.classList.add('drag'); });
  uploadDropzone.addEventListener('dragleave', () => uploadDropzone.classList.remove('drag'));
  uploadDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadDropzone.classList.remove('drag');
    if (e.dataTransfer.files.length) setUploadFile(e.dataTransfer.files[0]);
  });
  uploadFileClear.addEventListener('click', (e) => {
    e.stopPropagation();
    setUploadFile(null);
  });

  function setUploadFile(file) {
    selectedUploadFile = file || null;
    if (selectedUploadFile) {
      uploadFileName.textContent = selectedUploadFile.name;
      uploadFileSize.textContent = formatBytes(selectedUploadFile.size);
      uploadFileBadge.classList.add('show');
      submitUploadBtn.disabled = false;
    } else {
      uploadFileBadge.classList.remove('show');
      submitUploadBtn.disabled = true;
      videoFileInput.value = '';
    }
  }

  submitUploadBtn.addEventListener('click', async () => {
    if (!selectedUploadFile) return;

    submitUploadBtn.disabled = true;
    uploadProgress.classList.add('show');
    uploadStatus.textContent = '⏳ Step 1/3 — Uploading & transcribing audio with Whisper…';

    try {
      const fd = new FormData();
      fd.append('file', selectedUploadFile, selectedUploadFile.name);

      const res = await fetch('/api/ingest/video', {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Upload failed');

      uploadStatus.textContent = '🧠 Step 2/3 — AI is sectioning video into 30–60s clips…';
      const targetDurationSec = Number(durationSelect.value) || 45;

      // Auto-trigger reel generation immediately after upload
      await fetch('/api/reels/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: data.fileName, targetDurationSec }),
      });

      uploadStatus.textContent = '✅ Step 3/3 — Reels are being rendered! Opening player…';

      setTimeout(async () => {
        closeUploadModal();
        await loadVideoSources(data.fileName, true);
      }, 800);
    } catch (err) {
      uploadStatus.textContent = `❌ Failed: ${err.message}`;
      submitUploadBtn.disabled = false;
      uploadProgress.classList.remove('show');
    }
  });

  // ---------- Source Loading ----------
  async function loadVideoSources(preferredSource = '', alreadyGenerating = false) {
    try {
      const res = await fetch('/api/reels');
      const data = await res.json();
      const sources = data.sources || [];

      sourceSelect.innerHTML = '';
      if (sources.length === 0) {
        sourceSelect.innerHTML = '<option value="">No videos found — click "Upload Video"</option>';
        genReelsBtn.disabled = true;
        setStatus('No videos', 'idle');
        renderEmptyState('', false);
        return;
      }

      sources.forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.source;
        const count = (s.reels || []).length;
        const isProcessing = s.status === 'processing' || s.status === 'generating';
        const isReady = s.status === 'completed' || s.status === 'ready';
        const statusLabel = isProcessing ? '⏳ Rendering...' : isReady ? `${count} reels ✓` : 'no reels yet';
        opt.textContent = `${s.source} (${statusLabel})`;
        sourceSelect.appendChild(opt);
      });

      const paramSource = preferredSource || new URLSearchParams(window.location.search).get('source');
      const matchedSource = sources.find((s) => s.source === paramSource || s.source === preferredSource);
      if (matchedSource) {
        sourceSelect.value = matchedSource.source;
      }

      genReelsBtn.disabled = false;

      // If this was just uploaded and generation is already kicked off, start polling directly
      if (alreadyGenerating && matchedSource) {
        currentSource = matchedSource.source;
        setStatus('⚡ Rendering 30–60s clips...', 'generating');
        viewportEmpty.style.display = 'none';
        startPolling(matchedSource.source);
        // Also fetch the manifest now so any pre-built sections display
        fetchReelsForSource(matchedSource.source);
      } else {
        onSourceChanged();
      }
    } catch (err) {
      sourceSelect.innerHTML = '<option value="">Could not load video sources</option>';
      setStatus('Backend unreachable', 'failed');
    }
  }

  sourceSelect.addEventListener('change', onSourceChanged);

  async function onSourceChanged() {
    currentSource = sourceSelect.value;
    if (!currentSource) return;

    const url = new URL(window.location);
    url.searchParams.set('source', currentSource);
    window.history.replaceState({}, '', url);

    await fetchReelsForSource(currentSource);
  }

  async function fetchReelsForSource(source) {
    // Reset feed tracking when switching sources so cards re-animate in
    if (source !== feedSource) {
      knownReelIds = new Set();
      feedSource = source;
    }
    try {
      setStatus('Loading manifest...', 'generating');
      const res = await fetch(`/api/reels?source=${encodeURIComponent(source)}`);
      const data = await res.json();

      reelList = data.reels || [];

      if (data.status === 'processing' || data.status === 'generating') {
        const readyCount = reelList.filter((r) => r.status === 'ready').length;
        setStatus(`⚡ Rendering clips (${readyCount}/${reelList.length} ready)...`, 'generating');
        startPolling(source);
      } else if (data.status === 'completed' || data.status === 'ready' || reelList.length > 0) {
        setStatus(`✅ ${reelList.length} Reels Ready`, 'ready');
        stopPolling();
      } else {
        setStatus('Ready to generate', 'idle');
        stopPolling();
      }

      if (reelList.length > 0) {
        viewportEmpty.style.display = 'none';
        renderChapters();
        renderFeed();
        loadReel(currentIndex < reelList.length ? currentIndex : 0);
      } else {
        renderEmptyState(source, data.videoAvailable);
      }
    } catch (err) {
      setStatus('Error loading reels', 'failed');
    }
  }

  function renderEmptyState(source, videoAvailable) {
    chaptersSidebar.innerHTML = '';
    reelsFeedWrap.style.display = 'none';
    reelsFeed.innerHTML = '';
    viewportEmpty.style.display = 'flex';
    hookTitle.textContent = source ? `No Reels for "${source}"` : 'No Video Loaded';
    hookDesc.textContent = 'Upload a video or click "Slice into 30–60s Reels" to generate vertical clips.';
    reelCountBadge.textContent = '0 Reels';
    timeRangePill.textContent = '0:00';
    captionText.textContent = 'Ready for generation';
    progressFill.style.width = '0%';
  }

  // ---------- Generation Trigger ----------
  genReelsBtn.addEventListener('click', async () => {
    if (!currentSource) return;
    const targetDurationSec = Number(durationSelect.value) || 45;

    genReelsBtn.disabled = true;
    setStatus(`🧠 Sectioning 30–60s clips…`, 'generating');

    try {
      const res = await fetch('/api/reels/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: currentSource, targetDurationSec }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to start');

      await fetchReelsForSource(currentSource);
      startPolling(currentSource);
    } catch (err) {
      setStatus(`Failed: ${err.message}`, 'failed');
      genReelsBtn.disabled = false;
    }
  });

  function startPolling(source) {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/reels?source=${encodeURIComponent(source)}`);
        const data = await res.json();
        const prevList = reelList;
        reelList = data.reels || [];

        if (reelList.length > 0) {
          viewportEmpty.style.display = 'none';
          renderChapters();
          renderFeed();
          if (reelList[currentIndex] && prevList[currentIndex]?.status !== 'ready' && reelList[currentIndex].status === 'ready') {
            loadReel(currentIndex, true);
          }
        }

        if (data.status === 'completed' || (reelList.length > 0 && reelList.every((r) => r.status === 'ready'))) {
          stopPolling();
          setStatus(`✅ ${reelList.length} Reels Ready`, 'ready');
          genReelsBtn.disabled = false;
        } else if (data.status === 'processing') {
          const readyCount = reelList.filter((r) => r.status === 'ready').length;
          setStatus(`⚡ Rendering clips (${readyCount}/${reelList.length} ready)...`, 'generating');
        } else if (data.status === 'failed') {
          stopPolling();
          setStatus(`Render failed: ${data.error || 'Check server logs'}`, 'failed');
          genReelsBtn.disabled = false;
        }
      } catch { /* continue polling */ }
    }, 3000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ---------- Chapters Sidebar ----------
  function renderChapters() {
    chaptersSidebar.innerHTML = '';
    reelList.forEach((reel, idx) => {
      const card = document.createElement('div');
      card.className = `chapter-card ${idx === currentIndex ? 'active' : ''}`;
      const isClipReady = reel.status === 'ready' || !reel.status;
      const statusIcon = isClipReady ? '✓ Ready' : '⏳ Rendering...';
      const statusColor = isClipReady ? 'var(--accent-3)' : 'var(--yellow)';

      const start = reel.start ?? reel.startSec ?? 0;
      const end = reel.end ?? reel.endSec ?? 0;
      const dur = reel.duration ?? reel.durationSec ?? Math.round(end - start);

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
          <div class="chapter-num">Clip ${idx + 1} of ${reelList.length}</div>
          <span style="font-size:10px; font-weight:700; color:${statusColor};">${statusIcon}</span>
        </div>
        <div class="chapter-title">${escapeHtml(reel.title || `Clip #${idx + 1}`)}</div>
        <div class="chapter-time">⏱️ ${formatTime(start)} – ${formatTime(end)} (${dur}s)</div>
      `;
      card.addEventListener('click', () => loadReel(idx));
      chaptersSidebar.appendChild(card);
    });
  }

  // ---------- Reels Feed (below the player) ----------
  function renderFeed() {
    if (!reelList || reelList.length === 0) {
      reelsFeedWrap.style.display = 'none';
      reelsFeed.innerHTML = '';
      return;
    }
    reelsFeedWrap.style.display = 'block';

    const readyCount = reelList.filter((r) => r.status === 'ready' || !r.status).length;
    reelsFeedCount.textContent = `${readyCount}/${reelList.length} ready`;

    const scrollTop = reelsFeed.scrollTop;
    reelsFeed.innerHTML = '';

    reelList.forEach((reel, idx) => {
      const id = reel.id || `reel-${idx}`;
      const isNew = !knownReelIds.has(id);
      knownReelIds.add(id);

      const start = reel.start ?? reel.startSec ?? 0;
      const end = reel.end ?? reel.endSec ?? 0;
      const dur = reel.duration ?? reel.durationSec ?? Math.round(end - start);
      const isClipReady = reel.status === 'ready' || !reel.status;
      const statusBadge = isClipReady
        ? '<span class="feed-badge ready">✓ Ready</span>'
        : '<span class="feed-badge rendering">⏳ Rendering</span>';
      const takeaway = (reel.takeaways && reel.takeaways.length > 0)
        ? reel.takeaways[0]
        : (reel.summary || reel.transcript || '');

      const card = document.createElement('div');
      card.className = `feed-card${idx === currentIndex ? ' active' : ''}${isNew ? ' slide-in' : ''}`;
      card.dataset.reelId = id;
      card.innerHTML = `
        <div class="feed-num">${idx + 1}</div>
        <div class="feed-body">
          <div class="feed-top">
            <span class="feed-title">${escapeHtml(reel.title || `Clip #${idx + 1}`)}</span>
            <span class="feed-badge">${dur}s</span>
            ${statusBadge}
          </div>
          ${takeaway ? `<div class="feed-takeaway">💡 ${escapeHtml(takeaway)}</div>` : ''}
          <div class="feed-time">⏱️ ${formatTime(start)} – ${formatTime(end)}</div>
        </div>
      `;
      card.addEventListener('click', () => {
        loadReel(idx);
        const stage = document.querySelector('.stage-wrap');
        if (stage) stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      reelsFeed.appendChild(card);
    });

    // Restore scroll position so polling rebuilds don't interrupt browsing
    reelsFeed.scrollTop = scrollTop;

    // Keep the active card visible inside the feed container (never scrolls page)
    const activeEl = reelsFeed.children[currentIndex];
    if (activeEl) {
      const top = activeEl.offsetTop - reelsFeed.offsetTop;
      const bottom = top + activeEl.offsetHeight;
      if (top < reelsFeed.scrollTop || bottom > reelsFeed.scrollTop + reelsFeed.clientHeight) {
        reelsFeed.scrollTop = top - reelsFeed.clientHeight / 2 + activeEl.offsetHeight / 2;
      }
    }
  }

  /** Highlight the active card in the feed without a full rebuild. */
  function syncFeedActive() {
    Array.from(reelsFeed.children).forEach((el, i) => {
      el.classList.toggle('active', i === currentIndex);
    });
  }

  // ---------- Reel Playback & Presentation ----------
  function loadReel(index, preserveTime = false) {
    if (!reelList || reelList.length === 0) return;
    currentIndex = Math.max(0, Math.min(reelList.length - 1, index));
    const reel = reelList[currentIndex];

    viewportEmpty.style.display = 'none';

    const start = reel.start ?? reel.startSec ?? 0;
    const end = reel.end ?? reel.endSec ?? 0;
    const dur = reel.duration ?? reel.durationSec ?? Math.round(end - start);

    // UI Updates
    reelCountBadge.textContent = `Reel ${currentIndex + 1} of ${reelList.length}`;
    timeRangePill.textContent = `⏱️ ${formatTime(start)} – ${formatTime(end)} (${dur}s)`;
    hookTitle.textContent = reel.title || `Clip #${currentIndex + 1}`;
    
    // Takeaways snippet or summary
    if (reel.takeaways && reel.takeaways.length > 0) {
      hookDesc.textContent = `💡 ${reel.takeaways[0]}`;
    } else {
      hookDesc.textContent = reel.summary || reel.transcript || 'Bite-sized educational clip';
    }

    tagsRow.innerHTML = `
      <span class="tag-badge">#${escapeHtml((reel.source || 'ai').replace(/[^a-z0-9]/gi, ''))}</span>
      <span class="tag-badge">#Clip${currentIndex + 1}</span>
      <span class="tag-badge">#${dur}Seconds</span>
    `;

    Array.from(chaptersSidebar.children).forEach((ch, i) => {
      ch.classList.toggle('active', i === currentIndex);
    });
    syncFeedActive();

    // Choose Video Source
    const isRendered = reel.status === 'ready' && reel.video;
    const videoUrl = isRendered ? (reel.video || reel.fileUrl) : `/uploads/${encodeURIComponent(reel.source)}`;

    if (mainVideo.src !== videoUrl && !mainVideo.src.endsWith(videoUrl)) {
      mainVideo.src = videoUrl;
      blurVideo.src = videoUrl;
    }

    if (!preserveTime) {
      if (isRendered) {
        mainVideo.currentTime = 0;
        blurVideo.currentTime = 0;
      } else {
        mainVideo.currentTime = start;
        blurVideo.currentTime = start;
      }
    }

    mainVideo.muted = isMuted;
    blurVideo.muted = true;

    mainVideo.play().then(() => {
      isPlaying = true;
      blurVideo.play().catch(() => {});
    }).catch(() => {
      isPlaying = false;
      showPulseIcon('▶');
    });

    isLiked = false;
    likeBtn.classList.remove('liked');
    likeCount.textContent = '1.4k';

    updateCaptionDisplay(mainVideo.currentTime);
  }

  // ---------- Video Events & Synchronized Captions ----------
  mainVideo.addEventListener('timeupdate', () => {
    if (!reelList || reelList.length === 0) return;
    const reel = reelList[currentIndex];
    const isRendered = reel.status === 'ready' && reel.video;

    const start = isRendered ? 0 : (reel.start ?? reel.startSec ?? 0);
    const end = isRendered ? (mainVideo.duration || (reel.duration ?? 45)) : (reel.end ?? reel.endSec ?? 45);
    const duration = Math.max(1, end - start);
    const progress = Math.max(0, Math.min(1, (mainVideo.currentTime - start) / duration));

    progressFill.style.width = `${progress * 100}%`;

    // Loop bounds
    if (mainVideo.currentTime >= end) {
      mainVideo.currentTime = start;
      blurVideo.currentTime = start;
      mainVideo.play().catch(() => {});
    }

    if (Math.abs(blurVideo.currentTime - mainVideo.currentTime) > 0.3) {
      blurVideo.currentTime = mainVideo.currentTime;
    }

    updateCaptionDisplay(mainVideo.currentTime);
  });

  function updateCaptionDisplay(curTime) {
    const reel = reelList[currentIndex];
    if (!reel) return;

    if (reel.cues && reel.cues.length > 0) {
      const activeCue = reel.cues.find((c) => curTime >= c.startSec && curTime <= c.endSec);
      if (activeCue) {
        captionText.innerHTML = escapeHtml(activeCue.text).replace(
          /([A-Za-z0-9_-]+)/,
          '<span class="highlight">$1</span>'
        );
        return;
      }
    }

    captionText.textContent = reel.title || 'Learning with Eklavya';
  }

  // ---------- Play / Pause Toggle ----------
  viewport.addEventListener('click', (e) => {
    if (e.target.closest('.action-column') || e.target.closest('.progress-bar-wrap') || e.target.closest('.viewport-empty')) return;

    if (mainVideo.paused) {
      mainVideo.play().then(() => {
        blurVideo.play().catch(() => {});
        isPlaying = true;
        showPulseIcon('▶');
      });
    } else {
      mainVideo.pause();
      blurVideo.pause();
      isPlaying = false;
      showPulseIcon('⏸');
    }
  });

  function showPulseIcon(symbol) {
    playPulse.textContent = symbol;
    playPulse.classList.add('show');
    setTimeout(() => playPulse.classList.remove('show'), 600);
  }

  // ---------- Progress Bar Seeking ----------
  progressBar.addEventListener('click', (e) => {
    const reel = reelList[currentIndex];
    if (!reel) return;
    const rect = progressBar.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const isRendered = reel.status === 'ready' && reel.video;
    const start = isRendered ? 0 : (reel.start ?? reel.startSec ?? 0);
    const duration = isRendered ? (mainVideo.duration || (reel.duration ?? 45)) : (reel.duration ?? (reel.end - reel.start));

    const seekTo = start + (ratio * duration);
    mainVideo.currentTime = seekTo;
    blurVideo.currentTime = seekTo;
  });

  // ---------- Navigation Gestures (Swipe / Scroll / Keyboard) ----------
  let touchStartY = 0;
  viewport.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  viewport.addEventListener('touchend', (e) => {
    const diffY = touchStartY - e.changedTouches[0].clientY;
    if (Math.abs(diffY) > 45) {
      if (diffY > 0) nextReel();
      else prevReel();
    }
  }, { passive: true });

  let wheelLock = false;
  viewport.addEventListener('wheel', (e) => {
    if (wheelLock) return;
    if (Math.abs(e.deltaY) > 30) {
      wheelLock = true;
      if (e.deltaY > 0) nextReel();
      else prevReel();
      setTimeout(() => { wheelLock = false; }, 400);
    }
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (summaryModal.classList.contains('open') || transcriptModal.classList.contains('open') || uploadModal.classList.contains('open')) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') nextReel();
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') prevReel();
    else if (e.key === ' ') {
      e.preventDefault();
      if (mainVideo.paused) mainVideo.play();
      else mainVideo.pause();
    }
  });

  function nextReel() {
    if (currentIndex < reelList.length - 1) loadReel(currentIndex + 1);
  }
  function prevReel() {
    if (currentIndex > 0) loadReel(currentIndex - 1);
  }

  // ---------- Action Buttons ----------
  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isLiked = !isLiked;
    likeBtn.classList.toggle('liked', isLiked);
    likeCount.textContent = isLiked ? '1.5k' : '1.4k';
  });

  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isMuted = !isMuted;
    mainVideo.muted = isMuted;
    muteBtn.textContent = isMuted ? '🔇' : '🔊';
    muteLabel.textContent = isMuted ? 'Muted' : 'Sound';
  });

  downloadBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const reel = reelList[currentIndex];
    if (!reel) return;
    const a = document.createElement('a');
    a.href = reel.video || reel.fileUrl || `/uploads/${encodeURIComponent(reel.source)}`;
    a.download = `${(reel.title || 'reel').replace(/[^a-z0-9]/gi, '_')}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  summaryBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const reel = reelList[currentIndex];
    if (!reel) return;
    modalHookTitle.textContent = reel.title || 'Key Takeaways';

    const start = reel.start ?? reel.startSec ?? 0;
    const end = reel.end ?? reel.endSec ?? 0;
    const dur = reel.duration ?? reel.durationSec ?? Math.round(end - start);

    if (reel.takeaways && reel.takeaways.length > 0) {
      modalSummaryText.innerHTML = `<ul style="margin:0; padding-left:18px; line-height:1.7;">${reel.takeaways.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
    } else {
      modalSummaryText.textContent = reel.summary || reel.transcript || 'No summary available.';
    }

    modalTimestampText.textContent = `⏱️ Clip Window: ${formatTime(start)} – ${formatTime(end)} (${dur}s)`;
    summaryModal.classList.add('open');
  });

  closeSummary.addEventListener('click', () => summaryModal.classList.remove('open'));
  summaryModal.addEventListener('click', (e) => {
    if (e.target === summaryModal) summaryModal.classList.remove('open');
  });

  transcriptBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const reel = reelList[currentIndex];
    if (!reel) return;
    modalTranscriptText.textContent = reel.transcript || 'No transcript available for this segment.';
    transcriptModal.classList.add('open');
  });

  closeTranscript.addEventListener('click', () => transcriptModal.classList.remove('open'));
  transcriptModal.addEventListener('click', (e) => {
    if (e.target === transcriptModal) transcriptModal.classList.remove('open');
  });

  // ---------- Boot ----------
  loadVideoSources();
})();
