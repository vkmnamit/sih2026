/**
 * Carousel page logic (public/carousel.html).
 *
 * Flow:
 *   1. On load, fetch all cards from GET /api/cards and derive the list of
 *      sources (there is no dedicated sources endpoint — the backend stores
 *      cards grouped per source, so the unique card.source values are it).
 *   2. "Generate" POSTs /api/cards/generate with format:"carousel".
 *   3. Carousel cards (format === "carousel") render as a swipeable
 *      Instagram-style deck: category tag, big display number, split heading,
 *      timeline events, and a bigEvent / visualNumber / takeaway box.
 *
 * Query param: ?source=file.pdf preselects a source and jumps straight to
 * its carousel if carousel cards already exist.
 */
(function () {
  'use strict';

  // ---------- elements ----------
  var selector = document.getElementById('selector');
  var sourceSelect = document.getElementById('sourceSelect');
  var genBtn = document.getElementById('genBtn');
  var genStatus = document.getElementById('genStatus');
  var topbar = document.getElementById('topbar');
  var topbarTitle = document.getElementById('topbarTitle');
  var backBtn = document.getElementById('backBtn');
  var wrapper = document.getElementById('wrapper');
  var carousel = document.getElementById('carousel');
  var dots = document.getElementById('dots');
  var likeBtn = document.getElementById('like');
  var likesEl = document.getElementById('likes');
  var captionEl = document.getElementById('caption');
  var captionText = document.getElementById('captionText');
  var tagsEl = document.getElementById('tags');

  // ---------- state ----------
  var cards = [];
  var index = 0;
  var source = '';
  var liked = false;

  // ---------- helpers ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setStatus(msg) {
    genStatus.textContent = msg || '';
  }

  // ---------- source list ----------
  async function loadSources() {
    try {
      var seen = {};
      var sources = [];

      try {
        var resCards = await fetch('/api/cards');
        var dataCards = await resCards.json();
        (dataCards.cards || []).forEach(function (c) {
          if (c.source && !seen[c.source]) {
            seen[c.source] = true;
            sources.push(c.source);
          }
        });
      } catch (e) {}

      try {
        var resStats = await fetch('/api/ask/_stats');
        var dataStats = await resStats.json();
        (dataStats.sourceNames || []).forEach(function (s) {
          if (s && !seen[s]) {
            seen[s] = true;
            sources.push(s);
          }
        });
      } catch (e) {}

      sources.sort();

      sourceSelect.innerHTML = '';
      if (sources.length === 0) {
        sourceSelect.innerHTML = '<option value="">No uploads yet — add a file on the home page</option>';
        genBtn.disabled = true;
        return;
      }
      sources.forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        sourceSelect.appendChild(opt);
      });

      // Preselect from ?source=… and auto-open if carousel cards exist
      var wanted = new URLSearchParams(window.location.search).get('source');
      if (wanted && sources.indexOf(wanted) !== -1) {
        sourceSelect.value = wanted;
        var pre = await fetch('/api/cards?source=' + encodeURIComponent(wanted) + '&format=carousel');
        var preData = await pre.json();
        if ((preData.cards || []).length > 0) openCarousel(preData.cards);
      }
      genBtn.disabled = false;
    } catch (err) {
      sourceSelect.innerHTML = '<option value="">Could not reach the server — is the backend running?</option>';
      genBtn.disabled = true;
    }
  }

  // ---------- generation ----------
  genBtn.addEventListener('click', async function () {
    var src = sourceSelect.value;
    if (!src) return;
    genBtn.disabled = true;
    setStatus('🧠 Generating carousel cards… this can take 1–3 minutes.');
    try {
      var res = await fetch('/api/cards/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: src, format: 'carousel' }),
      });
      var data = await res.json().catch(function () { return null; });
      if (!res.ok || !data || data.ok !== true) {
        throw new Error((data && data.error) || 'HTTP ' + res.status);
      }
      var carouselCards = (data.cards || []).filter(function (c) {
        return (c.format || 'post') === 'carousel';
      });
      if (carouselCards.length === 0) {
        setStatus('⚠️ No carousel cards produced — check the server logs and try again.');
        return;
      }
      setStatus('');
      openCarousel(carouselCards);
    } catch (err) {
      setStatus('Generation failed: ' + (err.message || err));
    } finally {
      genBtn.disabled = false;
    }
  });

  // ---------- carousel view ----------
  function openCarousel(list) {
    cards = list;
    index = 0;
    liked = false;
    likeBtn.textContent = 'Like';
    source = cards[0] ? cards[0].source : sourceSelect.value;
    topbarTitle.textContent = source || 'Eklavya';
    selector.style.display = 'none';
    topbar.style.display = 'flex';
    wrapper.style.display = 'block';
    document.getElementById('actions').style.display = 'flex';
    likesEl.style.display = 'block';
    document.getElementById('creator').style.display = 'flex';
    captionEl.style.display = 'block';
    render();
  }

  backBtn.addEventListener('click', function () {
    selector.style.display = 'block';
    topbar.style.display = 'none';
    wrapper.style.display = 'none';
    document.getElementById('actions').style.display = 'none';
    likesEl.style.display = 'none';
    document.getElementById('creator').style.display = 'none';
    captionEl.style.display = 'none';
  });

  function render() {
    carousel.style.transform = 'translateX(' + (-index * 100) + '%)';
    carousel.innerHTML = cards.map(renderCard).join('');

    dots.innerHTML = cards.map(function (_, i) {
      return '<div class="dot' + (i === index ? ' active' : '') + '"></div>';
    }).join('');

    var c = cards[index];
    captionText.textContent = ' ' + (c.description || c.name || '');
    tagsEl.textContent = '#' + (source || 'eklavya').replace(/[^a-z0-9]+/gi, '') + ' #eklavya #ailearning';
    likesEl.textContent = liked ? '2,506 likes' : '2,505 likes';
  }


  function renderCard(c, i) {
    var total = c.cardTotal || cards.length;
    var html = '<div class="card">';
    html += '<div class="counter">' + (i + 1) + ' / ' + total + '</div>';
    html += '<div class="card-content">';

    if (c.category) html += '<div class="category">' + escapeHtml(c.category) + '</div>';

    if (c.displayNumber) {
      var num = String(c.displayNumber);
      var splitAt = Math.max(num.length - 2, 0);
      html += '<div class="year">' + escapeHtml(num.slice(0, splitAt)) +
        '<span>' + escapeHtml(num.slice(splitAt)) + '</span></div>';
    }

    if (c.heading || c.headingHighlight) {
      html += '<div class="heading">' + escapeHtml(c.heading || '') +
        (c.headingHighlight ? ' <span class="highlight">' + escapeHtml(c.headingHighlight) + '</span>' : '') +
        '</div>';
    } else {
      html += '<div class="heading">' + escapeHtml(c.name || '') + '</div>';
    }

    if (c.description) html += '<div class="description">' + escapeHtml(c.description) + '</div>';

    if (c.events && c.events.length) {
      html += '<div class="timeline">';
      c.events.forEach(function (e) {
        html += '<div class="event' + (e.important ? ' important' : '') + '">' +
          '<div class="date">' + (e.important ? '\u2605 ' : '') + escapeHtml(e.date) + '</div>' +
          '<div class="event-text"><strong>' + escapeHtml(e.title) + '</strong>' +
          (e.description ? ' \u2014 ' + escapeHtml(e.description) : '') + '</div>' +
          '</div>';
      });
      html += '</div>';
    }

    if (c.bigEvent) {
      html += '<div class="big-event"><div class="small">' + escapeHtml(c.bigEvent.label || '') + '</div>' +
        '<h3>' + escapeHtml(c.bigEvent.title || '') + '</h3>' +
        '<p>' + escapeHtml(c.bigEvent.body || '') + '</p></div>';
    } else if (c.visualNumber) {
      html += '<div class="visual-number"><strong>' + escapeHtml(c.visualNumber.value || '') +
        '</strong><span>' + escapeHtml(c.visualNumber.label || '') + '</span></div>';
    } else if (c.takeaway) {
      html += '<div class="takeaway"><small>' + escapeHtml(c.takeaway.label || '') + '</small>' +
        '<p>' + escapeHtml(c.takeaway.text || '') + '</p></div>';
    }

    html += '</div></div>';
    return html;
  }


  // ---------- navigation: swipe + keys + drag ----------
  function goTo(i) {
    index = Math.max(0, Math.min(cards.length - 1, i));
    render();
  }

  var touchX = null;
  wrapper.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
  wrapper.addEventListener('touchend', function (e) {
    if (touchX === null) return;
    var dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) goTo(index + (dx < 0 ? 1 : -1));
    touchX = null;
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (wrapper.style.display === 'none') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goTo(index + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') goTo(index - 1);
  });

  var dragX = null;
  wrapper.addEventListener('mousedown', function (e) { dragX = e.clientX; });
  window.addEventListener('mouseup', function (e) {
    if (dragX === null) return;
    var dx = e.clientX - dragX;
    if (Math.abs(dx) > 60) goTo(index + (dx < 0 ? 1 : -1));
    dragX = null;
  });

  likeBtn.addEventListener('click', function () {
    liked = !liked;
    likeBtn.textContent = liked ? '\u2764\uFE0F' : 'Like';
    likesEl.textContent = liked ? '2,506 likes' : '2,505 likes';
  });

  // ---------- boot ----------
  loadSources();
})();

