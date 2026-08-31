/**
 * Eklavya — 30–60s Video Reels Studio & Vertical Player Logic (public/reels.js)
 */
(function () {
  'use strict';

  // ---------- Elements ----------
  const sourceSelect = document.getElementById('sourceSelect');
  const durationSelect = document.getElementById('durationSelect');
  const genReelsBtn = document.getElementById('genReelsBtn');
  const statusBadge = document.getElementById('statusBadge');
  const chaptersSidebar = document.getElementById('chaptersSidebar');

  const viewport = document.getElementById('viewport');
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

  // ---------- Helpers ----------
  function formatTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function setStatus(msg, type = 'idle') {
    statusBadge.className = `status-pill ${type}`;
    statusBadge.innerHTML = `<span>${msg}</span>`;
  }

  // ---------- Source Loading ----------
  async function loadVideoSources() {
    try {
      const res = await fetch('/api/reels');
      const data = await res.json();
      const sources = data.sources || [];

      sourceSelect.innerHTML = '';
      if (sources.length === 0) {
        sourceSelect.innerHTML = '<option value="">No video uploads found — upload an .mp4 on Home</option>';
        genReelsBtn.disabled = true;
        setStatus('No videos', 'idle');
        return;
      }

      sources.forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.source;
        const count = (s.reels || []).length;
        opt.textContent = `${s.source} (${count ? `${count} reels ready` : 'no reels yet'})`;
        sourceSelect.appendChild(opt);
      });

      // Query parameter ?source=... preselection
      const paramSource = new URLSearchParams(window.location.search).get('source');
      if (paramSource && sources.some((s) => s.source === paramSource)) {
        sourceSelect.value = paramSource;
      }

      genReelsBtn.disabled = false;
      onSourceChanged();
    } catch (err) {
      sourceSelect.innerHTML = '<option value="">Could not load video sources</option>';
      setStatus('Backend unreachable', 'failed');
    }
  }

  sourceSelect.addEventListener('change', onSourceChanged);

  async function onSourceChanged() {
    currentSource = sourceSelect.value;
    if (!currentSource) return;

    // Update query string without full reload
    const url = new URL(window.location);
    url.searchParams.set('source', currentSource);
    window.history.replaceState({}, '', url);

    await fetchReelsForSource(currentSource);
  }

  async function fetchReelsForSource(source) {
    try {
      setStatus('Fetching reels...', 'generating');
      const res = await fetch(`/api/reels?source=${encodeURIComponent(source)}`);
      const data = await res.json();

      if (data.status === 'generating') {
        setStatus('⚡ Generating 30–60s Reels...', 'generating');
        startPolling(source);
      } else if (data.status === 'ready' || (data.reels && data.reels.length > 0)) {
        setStatus(`✅ ${data.reels.length} Reels Ready`, 'ready');
        stopPolling();
      } else {
        setStatus('Ready to generate', 'idle');
        stopPolling();
      }

      reelList = data.reels || [];
      if (reelList.length > 0) {
        renderChapters();
        loadReel(0);
      } else {
        renderEmptyState(source, data.videoAvailable);
      }
    } catch (err) {
      setStatus('Error loading reels', 'failed');
    }
  }

  function renderEmptyState(source, videoAvailable) {
    chaptersSidebar.innerHTML = '';
    hookTitle.textContent = `No 30–60s Reels for "${source}"`;
    hookDesc.textContent = videoAvailable
      ? 'Click "Generate 30–60s Reels" above to slice this lecture into viral, captioned vertical clips.'
      : 'Source video file is not available on disk.';
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
    setStatus(`🧠 Generating ${targetDurationSec}s reels...`, 'generating');

    try {
      const res = await fetch('/api/reels/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: currentSource, targetDurationSec }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to start');

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
        if (data.status === 'ready' || (data.reels && data.reels.length > 0)) {
          stopPolling();
          setStatus(`✅ ${data.reels.length} Reels Ready`, 'ready');
          genReelsBtn.disabled = false;
          reelList = data.reels || [];
          renderChapters();
          loadReel(0);
        } else if (data.status === 'failed') {
          stopPolling();
          setStatus(`Render failed: ${data.error || 'Check server logs'}`, 'failed');
          genReelsBtn.disabled = false;
        }
      } catch { /* continue polling */ }
    }, 4000);
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
      card.innerHTML = `
        <div class="chapter-num">Clip ${idx + 1} of ${reelList.length}</div>
        <div class="chapter-title">${escapeHtml(reel.title || `Clip #${idx + 1}`)}</div>
        <div class="chapter-time">⏱️ ${formatTime(reel.startSec)} – ${formatTime(reel.endSec)} (${Math.round(reel.endSec - reel.startSec)}s)</div>
      `;
      card.addEventListener('click', () => loadReel(idx));
      chaptersSidebar.appendChild(card);
    });
  }

  // ---------- Reel Playback & Presentation ----------
  function loadReel(index) {
    if (!reelList || reelList.length === 0) return;
    currentIndex = Math.max(0, Math.min(reelList.length - 1, index));
    const reel = reelList[currentIndex];

    // UI Updates
    reelCountBadge.textContent = `Reel ${currentIndex + 1} of ${reelList.length}`;
    const dur = Math.round(reel.endSec - reel.startSec);
    timeRangePill.textContent = `⏱️ ${formatTime(reel.startSec)} – ${formatTime(reel.endSec)} (${dur}s)`;
    hookTitle.textContent = reel.title || `Clip #${currentIndex + 1}`;
    hookDesc.textContent = reel.summary || reel.transcript || 'Bite-sized educational clip';

    tagsRow.innerHTML = `
      <span class="tag-badge">#${escapeHtml((reel.source || 'ai').replace(/[^a-z0-9]/gi, ''))}</span>
      <span class="tag-badge">#Clip${currentIndex + 1}</span>
      <span class="tag-badge">#${dur}Seconds</span>
    `;

    // Highlight chapter in sidebar
    Array.from(chaptersSidebar.children).forEach((ch, i) => {
      ch.classList.toggle('active', i === currentIndex);
    });

    // Load Video Stream
    const videoUrl = reel.fileUrl || reel.sourceVideoUrl;
    if (mainVideo.src !== videoUrl && !mainVideo.src.endsWith(videoUrl)) {
      mainVideo.src = videoUrl;
      blurVideo.src = videoUrl;
    }

    // Set segment bounds for clipping
    mainVideo.dataset.startSec = reel.startSec;
    mainVideo.dataset.endSec = reel.endSec;

    // Reset video position to start of clip
    const isFullRenderedReel = reel.fileUrl && reel.fileUrl.startsWith('/reels/');
    if (!isFullRenderedReel && typeof reel.startSec === 'number') {
      mainVideo.currentTime = reel.startSec;
      blurVideo.currentTime = reel.startSec;
    } else {
      mainVideo.currentTime = 0;
      blurVideo.currentTime = 0;
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

    // Reset likes
    isLiked = false;
    likeBtn.classList.remove('liked');
    likeCount.textContent = '1.4k';

    updateCaptionDisplay(mainVideo.currentTime);
  }

  // ---------- Video Events & Synchronized Captions ----------
  mainVideo.addEventListener('timeupdate', () => {
    if (!reelList || reelList.length === 0) return;
    const reel = reelList[currentIndex];
    const isFullRenderedReel = reel.fileUrl && reel.fileUrl.startsWith('/reels/');

    const start = isFullRenderedReel ? 0 : reel.startSec;
    const end = isFullRenderedReel ? (mainVideo.duration || reel.endSec - reel.startSec) : reel.endSec;
    const duration = Math.max(1, end - start);
    const progress = Math.max(0, Math.min(1, (mainVideo.currentTime - start) / duration));

    progressFill.style.width = `${progress * 100}%`;

    // Loop clip bounds
    if (mainVideo.currentTime >= end) {
      mainVideo.currentTime = start;
      blurVideo.currentTime = start;
      mainVideo.play().catch(() => {});
    }

    // Sync blur video in case of drift
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

    // Fallback: display hook title or transcript snippet
    captionText.textContent = reel.title || 'Learning with Eklavya';
  }

  // ---------- Play / Pause Toggle ----------
  viewport.addEventListener('click', (e) => {
    // Don't toggle play if clicked on an action button or progress bar
    if (e.target.closest('.action-column') || e.target.closest('.progress-bar-wrap')) return;

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
    const isFull = reel.fileUrl && reel.fileUrl.startsWith('/reels/');
    const start = isFull ? 0 : reel.startSec;
    const duration = isFull ? (mainVideo.duration || reel.endSec - reel.startSec) : (reel.endSec - reel.startSec);

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

  // Mouse wheel scroll navigation (with debounce)
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

  // Keyboard navigation (Arrow Up / Down)
  document.addEventListener('keydown', (e) => {
    if (summaryModal.classList.contains('open') || transcriptModal.classList.contains('open')) return;
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
    a.href = reel.fileUrl || reel.sourceVideoUrl;
    a.download = `${(reel.title || 'reel').replace(/[^a-z0-9]/gi, '_')}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  summaryBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const reel = reelList[currentIndex];
    if (!reel) return;
    modalHookTitle.textContent = reel.title || 'Key Takeaway';
    modalSummaryText.textContent = reel.summary || reel.transcript || 'No summary available.';
    modalTimestampText.textContent = `⏱️ Timestamp Window: ${formatTime(reel.startSec)} – ${formatTime(reel.endSec)} (${Math.round(reel.endSec - reel.startSec)}s)`;
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
    modalTranscriptText.textContent = reel.transcript || 'No transcript text available for this segment.';
    transcriptModal.classList.add('open');
  });

  closeTranscript.addEventListener('click', () => transcriptModal.classList.remove('open'));
  transcriptModal.addEventListener('click', (e) => {
    if (e.target === transcriptModal) transcriptModal.classList.remove('open');
  });

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- Boot ----------
  loadVideoSources();
})();
