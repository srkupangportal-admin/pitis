(function () {
  var table = document.getElementById("leaderboardTable");
  if (!table) return;

  var classId = table.getAttribute("data-class-id");
  var rowsContainer = document.getElementById("leaderboardRows");
  var podiumContainer = document.getElementById("leaderboardPodium");
  var progressContainer = document.getElementById("leaderboardProgressCard");
  var recognitionContainer = document.getElementById("leaderboardRecognitionGrid");
  var nearbyContainer = document.getElementById("leaderboardNearbyRows");
  var lastUpdated = document.getElementById("lastUpdated");
  var initialRowsEl = document.getElementById("leaderboardInitialRows");
  var spotlightRowsEl = document.getElementById("leaderboardSpotlightRows");
  var menuBtn = document.getElementById("leaderboardMenuBtn");
  var menuPanel = document.getElementById("leaderboardMenuPanel");
  var sortMenuItems = Array.prototype.slice.call(document.querySelectorAll("[data-sort-mode]"));
  var slideshowBtn = document.getElementById("leaderboardSlideshowBtn");
  var slideshowMenuBtn = document.getElementById("leaderboardSlideshowMenuBtn");
  var pdfBtn = document.getElementById("leaderboardPdfBtn");
  var pdfMenuBtn = document.getElementById("leaderboardPdfMenuBtn");
  var pdfModal = document.getElementById("leaderboardPdfModal");
  var pdfCloseBtn = document.getElementById("leaderboardPdfCloseBtn");
  var pdfGenerateBtn = document.getElementById("leaderboardPdfGenerateBtn");
  var pdfToDate = document.getElementById("leaderboardPdfToDate");
  var pdfStatus = document.getElementById("leaderboardPdfStatus");
  var slideshowModal = document.getElementById("leaderboardSlideshowModal");
  var slideshowCloseBtn = document.getElementById("leaderboardSlideshowCloseBtn");
  var slideshowFullscreenBtn = document.getElementById("leaderboardSlideshowFullscreenBtn");
  var slideshowGrid = document.getElementById("leaderboardSlideshowGrid");
  var celebrationLayer = document.getElementById("leaderboardCelebrationLayer");
  var dailySpotlight = document.getElementById("leaderboardDailySpotlight");
  var mountainBtn = document.getElementById("leaderboardMountainBtn");
  var mountainModal = document.getElementById("leaderboardMountainModal");
  var mountainStage = document.getElementById("leaderboardMountainStage");
  var mountainStudents = document.getElementById("leaderboardMountainStudents");
  var mountainReplayBtn = document.getElementById("leaderboardMountainReplayBtn");
  var mountainFullscreenBtn = document.getElementById("leaderboardMountainFullscreenBtn");
  var mountainCloseBtn = document.getElementById("leaderboardMountainCloseBtn");
  var photoModal = document.getElementById("leaderboardPhotoModal");
  var photoModalImg = document.getElementById("leaderboardPhotoModalImg");
  var photoModalName = document.getElementById("leaderboardPhotoModalName");
  var photoModalCloseBtn = document.getElementById("leaderboardPhotoModalCloseBtn");

  var sortMode = "desc";
  var latestRows = [];
  var latestRankedRows = [];
  var latestSpotlightRows = [];
  var focusedStudentId = null;
  var lastPodiumSignature = "";
  var slideshowTimer = null;
  var mountainTimers = [];
  var slideshowIndex = 0;
  var slideshowDurationMs = Math.max(1500, Math.min(30000, Number(table.getAttribute("data-slideshow-duration-ms") || 4000)));
  var slideshowMode = String(table.getAttribute("data-slideshow-mode") || "points");
  var configuredSlideshowStudentCount = Math.max(1, Math.min(12, Number(table.getAttribute("data-slideshow-student-count") || 8)));
  var className = String(table.getAttribute("data-class-name") || "Class");

  function parseInitialRows() {
    if (!initialRowsEl) return [];
    try {
      return JSON.parse(initialRowsEl.textContent || "[]");
    } catch (_) {
      return [];
    }
  }

  function avatarFromRow(row) {
    var photo = String(row.photo_url || "").trim();
    if (photo) return photo;
    return "/img/student-placeholder.svg";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function photoButton(photoUrl, name, imgClass) {
    var safeName = escapeHtml(name);
    var safePhoto = escapeHtml(photoUrl);
    return (
      '<button type="button" class="leaderboard-photo-button" data-photo-src="' + safePhoto + '" data-photo-name="' + safeName + '" aria-label="Open larger photo of ' + safeName + '">' +
        '<img class="' + imgClass + '" src="' + safePhoto + '" alt="' + safeName + '" />' +
      '</button>'
    );
  }

  function sortRows(rows, mode) {
    return rows.slice().sort(function (a, b) {
      var pa = Number(a.total_points || 0);
      var pb = Number(b.total_points || 0);
      if (pa !== pb) return mode === "asc" ? pa - pb : pb - pa;
      var na = String(a.nickname || "").toLowerCase();
      var nb = String(b.nickname || "").toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });
  }

  function withRanks(rows, pointsKey) {
    var rankKey = pointsKey || "total_points";
    var prevPts = null;
    var prevRank = 0;
    return rows.map(function (row, index) {
      var pts = Number(row[rankKey] || 0);
      var rank = (prevPts !== null && pts === prevPts) ? prevRank : (index + 1);
      prevPts = pts;
      prevRank = rank;
      return {
        id: row.id,
        nickname: String(row.nickname || "?"),
        photo_url: avatarFromRow(row),
        total_points: Number(row.total_points || 0),
        weekly_points: Number(row.weekly_points || 0),
        previous_weekly_points: Number(row.previous_weekly_points || 0),
        positive_weeks_4: Number(row.positive_weeks_4 || 0),
        weekly_award_count: Number(row.weekly_award_count || 0),
        tier: row.tier || tierFor(row.total_points),
        leaderboard_points: pts,
        rank: rank,
        class_name: row.class_name || "",
        last_awarded_at: row.last_awarded_at || "",
        last_reason: row.last_reason || ""
      };
    });
  }

  function ordinal(rank) {
    var n = Number(rank);
    var mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return n + "th";
    var mod10 = n % 10;
    if (mod10 === 1) return n + "st";
    if (mod10 === 2) return n + "nd";
    if (mod10 === 3) return n + "rd";
    return n + "th";
  }

  function shortDate(iso) {
    if (!iso) return "-";
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleDateString();
  }

  function safeReason(reason) {
    var text = String(reason || "").trim();
    return text || "-";
  }

  function totalPitisText(total) {
    return Number(total || 0).toLocaleString() + " pitis";
  }

  function tierFor(total) {
    var points = Number(total || 0);
    if (points >= 320) return { key: "gold", label: "Gold", range: "320+" };
    if (points >= 240) return { key: "silver", label: "Silver", range: "240–319" };
    if (points >= 160) return { key: "bronze", label: "Bronze", range: "160–239" };
    if (points >= 80) return { key: "rising", label: "Rising", range: "80–159" };
    return { key: "starter", label: "Starter", range: "0–79" };
  }

  function tierBadge(row) {
    var tier = row.tier || tierFor(row.total_points);
    return '<span class="pitis-tier pitis-tier-' + escapeHtml(tier.key) + '" title="' + escapeHtml(tier.range) + ' P.I.T.I.S.">' + escapeHtml(tier.label) + ' tier</span>';
  }

  function exportClassLeaderboardPdf() {
    if (!pdfModal) return;
    if (pdfStatus) pdfStatus.textContent = "";
    pdfModal.classList.remove("hidden");
    pdfModal.setAttribute("aria-hidden", "false");
    if (menuPanel) menuPanel.classList.add("hidden");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
  }

  function closeClassLeaderboardPdf() {
    if (!pdfModal) return;
    pdfModal.classList.add("hidden");
    pdfModal.setAttribute("aria-hidden", "true");
  }

  function generateClassLeaderboardPdf() {
    var toDate = pdfToDate ? pdfToDate.value : "";
    var reservedWindow = window.open("", "_blank");
    if (!reservedWindow) {
      if (pdfStatus) pdfStatus.textContent = "Allow pop-ups for this site to export the PDF.";
      return;
    }
    var query = new URLSearchParams({ classIds: classId });
    if (toDate) query.set("to", toDate);
    fetch("/api/leaderboard-export?" + query.toString())
      .then(function (response) {
        if (!response.ok) throw new Error("Unable to generate dated leaderboard.");
        return response.json();
      })
      .then(function (data) {
        var orderedRows = (data.rows || []).slice().sort(function (a, b) {
          var pointDifference = Number(b.total_points || 0) - Number(a.total_points || 0);
          if (pointDifference) return pointDifference;
          return String(a.nickname || "").localeCompare(String(b.nickname || ""));
        });
        var rows = withRanks(orderedRows, "total_points");
        var opened = window.PitisLeaderboardPdf && window.PitisLeaderboardPdf.export({
          sections: [{ name: className, rows: rows }],
          reportDate: data.toDate,
          printWindow: reservedWindow
        });
        if (!opened) throw new Error("Unable to open the printable leaderboard.");
        closeClassLeaderboardPdf();
      })
      .catch(function (error) {
        reservedWindow.close();
        if (pdfStatus) pdfStatus.textContent = error.message || "Unable to export PDF.";
      });
  }

  function studentDetailHref(row) {
    return "/teacher/students/" + encodeURIComponent(row.id || "");
  }

  function podiumCard(row, slotClass, place) {
    var medalLabel = place === 1 ? "Gold Champion" : place === 2 ? "Silver Star" : "Bronze Star";
    return (
      '<article class="podium-card animated-podium-card ' + slotClass + '" style="--podium-place:' + place + '">' +
        (place === 1 ? '<div class="podium-crown" aria-hidden="true">♛</div>' : '') +
        '<div class="podium-medal">' + place + '</div>' +
        '<div class="podium-student">' +
          photoButton(row.photo_url, row.nickname, "podium-photo") +
          '<a class="podium-name student-detail-link" href="' + studentDetailHref(row) + '">' + escapeHtml(row.nickname) + '</a>' +
          '<div class="podium-class-chip">' + escapeHtml(row.class_name || "Class champion") + '</div>' +
          tierBadge(row) +
          '<div class="podium-points">' + totalPitisText(row.total_points) + '</div>' +
        '</div>' +
        '<div class="podium-step"><strong>' + place + '</strong><span>' + medalLabel + '</span></div>' +
      '</article>'
    );
  }

  function listRow(row) {
    return (
      '<article class="leaderboard-ranked-card" data-focus-student-id="' + escapeHtml(row.id) + '">' +
        '<strong class="leaderboard-ranked-number">#' + row.rank + '</strong>' +
        photoButton(row.photo_url, row.nickname, "avatar-photo") +
        '<div class="leaderboard-ranked-copy"><a class="student-detail-link" href="' + studentDetailHref(row) + '"><strong>' + escapeHtml(row.nickname) + '</strong></a>' +
          '<span>This week: ' + Number(row.weekly_points || 0).toLocaleString() + ' · Last week: ' + Number(row.previous_weekly_points || 0).toLocaleString() + '</span>' +
          '<div class="leaderboard-weekly-progress" role="progressbar" aria-label="Weekly progress for ' + escapeHtml(row.nickname) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + row.weekly_progress + '"><i style="width:' + row.weekly_progress + '%"></i></div>' +
          '<span>Accumulated: ' + Number(row.total_points || 0).toLocaleString() + ' pitis · ' + escapeHtml(movementText(row)) + '</span></div>' +
        tierBadge(row) +
        '<span class="pitis-total-badge" aria-label="Accumulated P.I.T.I.S">' + totalPitisText(row.total_points) + '</span>' +
      '</article>'
    );
  }

  function rankForMotivation(rows) {
    var classOrder = rows.slice().sort(function (a, b) {
      var totalDifference = Number(b.total_points || 0) - Number(a.total_points || 0);
      if (totalDifference) return totalDifference;
      return String(a.nickname || "").localeCompare(String(b.nickname || ""));
    });
    var ranked = withRanks(classOrder, "total_points");
    var weeklyMaximum = Math.max.apply(null, ranked.map(function (row) { return Number(row.weekly_points || 0); }).concat([1]));
    return ranked.map(function (row) {
      row.previous_rank = row.rank;
      row.rank_movement = 0;
      row.weekly_progress = Math.round((Number(row.weekly_points || 0) / weeklyMaximum) * 100);
      return row;
    });
  }

  function movementText(row) {
    var movement = Number(row.rank_movement || 0);
    if (movement > 0) return "Up " + movement + " place" + (movement === 1 ? "" : "s");
    if (movement < 0) return "Keep going";
    return "Holding steady";
  }

  function focusStudent(row) {
    if (!row || !progressContainer || !nearbyContainer) return;
    focusedStudentId = String(row.id);
    try { window.localStorage.setItem("pitis-leaderboard-focus-" + classId, focusedStudentId); } catch (_) {}
    var index = latestRankedRows.findIndex(function (item) { return String(item.id) === focusedStudentId; });
    var nextRow = index > 0 ? latestRankedRows[index - 1] : null;
    var gap = nextRow ? Math.max(0, Number(nextRow.total_points || 0) - Number(row.total_points || 0)) : 0;
    var progressValue = nextRow ? Math.max(12, Math.min(94, Math.round((Number(row.weekly_points || 0) / Math.max(1, Number(row.weekly_points || 0) + gap)) * 100))) : 100;
    var options = latestRankedRows.map(function (student) {
      return '<option value="' + escapeHtml(student.id) + '"' + (String(student.id) === focusedStudentId ? ' selected' : '') + '>#' + student.rank + ' ' + escapeHtml(student.nickname) + '</option>';
    }).join("");
    progressContainer.innerHTML =
      '<div class="leaderboard-progress-person">' + photoButton(row.photo_url, row.nickname, "leaderboard-progress-photo") +
        '<div class="leaderboard-progress-copy"><label for="leaderboardFocusSelect">Student progress</label><select id="leaderboardFocusSelect" class="leaderboard-focus-select">' + options + '</select>' +
        '<div class="leaderboard-progress-rank"><strong>#' + row.rank + '</strong><span class="leaderboard-movement ' + (row.rank_movement > 0 ? 'is-up' : '') + '">' + escapeHtml(movementText(row)) + '</span></div>' +
        tierBadge(row) +
        '<div class="leaderboard-progress-points"><strong>' + Number(row.total_points || 0).toLocaleString() + '</strong><span>pitis</span></div></div></div>' +
      '<div class="leaderboard-progress-goal"><div><strong>' + (nextRow ? gap + ' pitis to reach #' + nextRow.rank : 'You are the class leader!') + '</strong><span>' + Number(row.weekly_points || 0).toLocaleString() + ' positive pitis this week</span></div>' +
        '<div class="leaderboard-goal-track" role="progressbar" aria-label="Progress to the next position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progressValue + '"><span style="width:' + progressValue + '%"></span></div>' +
        '<p>' + (nextRow ? 'Your next achievable step is ' + escapeHtml(nextRow.nickname) + ' at #' + nextRow.rank + '.' : 'Keep setting a positive example for your class.') + '</p></div>';

    var start = Math.max(0, Math.min(latestRankedRows.length - 5, index - 2));
    nearbyContainer.innerHTML = latestRankedRows.slice(start, start + 5).map(function (student) {
      return '<button type="button" class="leaderboard-nearby-row ' + (String(student.id) === focusedStudentId ? 'is-focused' : '') + '" data-nearby-student-id="' + escapeHtml(student.id) + '">' +
        '<strong>#' + student.rank + '</strong><img src="' + escapeHtml(student.photo_url) + '" alt="" /><span>' + escapeHtml(student.nickname) + '</span>' + tierBadge(student) + '<b>' + Number(student.total_points || 0).toLocaleString() + ' pitis</b></button>';
    }).join("");
  }

  function renderAllRankings() {
    if (!nearbyContainer) return;
    nearbyContainer.innerHTML = latestRankedRows.map(function (student) {
      return '<a class="leaderboard-nearby-row" href="' + studentDetailHref(student) + '">' +
        '<strong>#' + student.rank + '</strong><img src="' + escapeHtml(student.photo_url) + '" alt="" /><span>' + escapeHtml(student.nickname) + '</span>' + tierBadge(student) + '<b>' + Number(student.total_points || 0).toLocaleString() + ' pitis</b></a>';
    }).join("");
  }

  function recognitionCard(kind, title, row, detail) {
    if (!row) return "";
    var icon = kind === "climber" ? "★" : kind === "helper" ? "✓" : "+";
    return '<article class="leaderboard-recognition-card ' + kind + '">' +
      '<div class="leaderboard-recognition-photo-stack"><span class="leaderboard-recognition-icon" aria-hidden="true">' + icon + '</span><img src="' + escapeHtml(row.photo_url) + '" alt="' + escapeHtml(row.nickname) + '" /></div>' +
      '<div class="leaderboard-recognition-copy"><strong class="leaderboard-recognition-award">' + escapeHtml(title) + '</strong><b>' + escapeHtml(row.nickname) + '</b>' + tierBadge(row) + '<em>' + escapeHtml(detail) + '</em><small>Last awarded: ' + shortDate(row.last_awarded_at) + '</small><small>Reason: ' + escapeHtml(safeReason(row.last_reason)) + '</small></div></article>';
  }

  function renderRecognition() {
    if (!recognitionContainer || !latestRankedRows.length) return;
    var weeklyChampion = latestRankedRows.slice().sort(function (a, b) { return Number(b.weekly_points || 0) - Number(a.weekly_points || 0) || Number(b.total_points || 0) - Number(a.total_points || 0); })[0];
    var mostConsistent = latestRankedRows.slice().sort(function (a, b) { return Number(b.positive_weeks_4 || 0) - Number(a.positive_weeks_4 || 0) || Number(b.weekly_points || 0) - Number(a.weekly_points || 0) || Number(b.total_points || 0) - Number(a.total_points || 0); })[0];
    var mostActive = latestRankedRows.slice().sort(function (a, b) { return Number(b.weekly_award_count || 0) - Number(a.weekly_award_count || 0) || Number(b.weekly_points || 0) - Number(a.weekly_points || 0) || Number(b.total_points || 0) - Number(a.total_points || 0); })[0];
    recognitionContainer.innerHTML =
      recognitionCard("climber", "Weekly Champion", weeklyChampion, Number(weeklyChampion.weekly_points || 0) + " pitis this week") +
      recognitionCard("helper", "Most Consistent", mostConsistent, Number(mostConsistent.positive_weeks_4 || 0) + " of the last 4 weeks") +
      recognitionCard("personal", "Most Active", mostActive, Number(mostActive.weekly_award_count || 0) + " positive awards this week");
  }

  function renderDailySpotlight() {
    if (!dailySpotlight || !latestRankedRows.length) return;
    var selected = latestSpotlightRows[0] || latestRankedRows[new Date().getDate() % latestRankedRows.length];
    var row = latestRankedRows.find(function (item) { return String(item.id) === String(selected.id); }) || latestRankedRows[0];
    dailySpotlight.innerHTML = '<div class="daily-spotlight-label"><span>★</span><div><small>DAILY SPOTLIGHT</small><strong>Today we celebrate</strong></div></div>' +
      '<img src="' + escapeHtml(row.photo_url) + '" alt="' + escapeHtml(row.nickname) + '">' +
      '<div class="daily-spotlight-score"><strong>' + Number(row.total_points || 0).toLocaleString() + '</strong><span>accumulated pitis</span></div>' +
      '<div class="daily-spotlight-copy"><h2>' + escapeHtml(row.nickname) + '</h2>' + tierBadge(row) + '<p>' + escapeHtml(safeReason(row.last_reason)) + '</p></div>';
  }

  function render(rows) {
    var ranked = rankForMotivation(rows);
    latestRankedRows = ranked;

    var top = ranked.slice(0, 3);
    var rest = ranked.slice(3);
    if (sortMode === "asc") rest.reverse();

    var arrangedTop = [
      top[0] ? { row: top[0], place: 1, slot: "first" } : null,
      top[1] ? { row: top[1], place: 2, slot: "second" } : null,
      top[2] ? { row: top[2], place: 3, slot: "third" } : null
    ].filter(Boolean);
    var podiumSignature = arrangedTop.map(function (entry) {
      return [entry.row.id, entry.row.weekly_points, entry.place].join(":");
    }).join("|");
    if (podiumSignature !== lastPodiumSignature) {
      podiumContainer.classList.add("animated-podium");
      podiumContainer.innerHTML = arrangedTop.map(function (entry) {
        return podiumCard(entry.row, entry.slot, entry.place);
      }).join("");
      lastPodiumSignature = podiumSignature;
    }
    if (rowsContainer) rowsContainer.innerHTML = rest.map(listRow).join("");
    renderRecognition();
    renderDailySpotlight();
  }

  function chunkRows(rows, size) {
    var groups = [];
    for (var i = 0; i < rows.length; i += size) {
      groups.push(rows.slice(i, i + size));
    }
    return groups;
  }

  function slideshowPageSize() {
    var viewportMax = 4;
    if (window.innerWidth >= 720) viewportMax = 8;
    if (window.innerWidth >= 1000 && window.innerHeight >= 600) viewportMax = 18;
    var adaptiveMinimum = viewportMax >= 18 ? 18 : (viewportMax >= 8 ? 8 : 1);
    var configuredTarget = Math.max(adaptiveMinimum, configuredSlideshowStudentCount);
    return Math.max(1, Math.min(configuredTarget, viewportMax));
  }

  function slideshowGroups() {
    var rows = latestRankedRows.slice();
    if (slideshowMode === "class") {
      rows.sort(function (a, b) {
        var ca = String(a.class_name || "").toLowerCase();
        var cb = String(b.class_name || "").toLowerCase();
        if (ca < cb) return -1;
        if (ca > cb) return 1;
        return Number(b.total_points || 0) - Number(a.total_points || 0);
      });
    }
    return chunkRows(rows, slideshowPageSize()).map(function (group) {
      return { type: "grid", rows: group };
    });
  }

  function presentationSlide(slide) {
    var awards = slide.page === 1 && recognitionContainer ? recognitionContainer.innerHTML : '';
    return '<section class="leaderboard-presentation-slide"><header><div><small>WEEKLY CLASS LEADERS</small><h2>' + escapeHtml(document.querySelector('.leaderboard-sub').textContent) + '</h2></div><strong>' + slide.page + ' / 2</strong></header>' +
      (awards ? '<div class="leaderboard-presentation-awards">' + awards + '</div>' : '') +
      '<div class="leaderboard-presentation-list">' + slide.rows.map(slideshowStudentCard).join('') + '</div></section>';
  }

  function cloneOverviewSection(element) {
    if (!element) return "";
    var clone = element.cloneNode(true);
    clone.removeAttribute("id");
    Array.prototype.slice.call(clone.querySelectorAll("[id]")).forEach(function (node) { node.removeAttribute("id"); });
    var select = clone.querySelector("select");
    if (select) {
      var selectedLabel = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : "Student progress";
      var label = clone.querySelector("label");
      if (label) label.remove();
      var name = document.createElement("strong");
      name.className = "leaderboard-overview-student-name";
      name.textContent = selectedLabel.replace(/^#\d+\s*/, "");
      select.replaceWith(name);
    }
    return clone.outerHTML;
  }

  function slideshowOverviewCard() {
    return '<section class="leaderboard-overview-slide" aria-label="Class motivation overview">' +
      cloneOverviewSection(document.querySelector(".leaderboard-class-leaders-layout")) +
      '<div class="leaderboard-overview-message">Every positive action moves you forward. Every pitis counts!</div></section>';
  }

  function parseSpotlightRows() {
    if (!spotlightRowsEl) return [];
    try { return JSON.parse(spotlightRowsEl.textContent || "[]"); } catch (_) { return []; }
  }

  function spotlightCard(row, place) {
    var title = "Today’s P.I.T.I.S Spotlight";
    return '<article class="leaderboard-spotlight-card spotlight-place-' + place + '">'
      + '<div class="leaderboard-spotlight-kicker">Daily Student Spotlight</div>'
      + '<div class="leaderboard-spotlight-medal">★</div>'
      + '<a class="student-detail-link" href="' + studentDetailHref(row) + '"><img class="leaderboard-spotlight-photo" src="' + escapeHtml(row.photo_url) + '" alt="' + escapeHtml(row.nickname) + '" /></a>'
      + '<div class="leaderboard-spotlight-copy">'
      + '<h2>' + escapeHtml(row.nickname) + '</h2>'
      + '<div class="leaderboard-spotlight-title">' + title + '</div>'
      + (row.class_name ? '<div class="leaderboard-slideshow-class-chip">' + escapeHtml(row.class_name) + '</div>' : '')
      + '<div class="leaderboard-spotlight-stats"><strong>' + Number(row.total_points || 0).toLocaleString() + '</strong><span>Total P.I.T.I.S</span><strong>' + Number(row.weekly_points || 0).toLocaleString() + '</strong><span>Positive points this week</span></div>'
      + '<p>Latest recognition: <strong>' + escapeHtml(safeReason(row.last_reason)) + '</strong></p>'
      + '</div></article>';
  }

  function fitSpotlightName() {
    window.requestAnimationFrame(function () {
      var nameEl = slideshowGrid && slideshowGrid.querySelector(".leaderboard-spotlight-copy h2");
      if (!nameEl) return;
      nameEl.style.fontSize = "";
      var size = Number.parseFloat(window.getComputedStyle(nameEl).fontSize) || 38;
      var minimumSize = window.innerWidth <= 700 ? 14 : 16;
      while (size > minimumSize && nameEl.scrollWidth > nameEl.clientWidth) {
        size -= 2;
        nameEl.style.fontSize = size + "px";
      }
    });
  }

  function celebrate(intensity) {
    if (!celebrationLayer || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    celebrationLayer.innerHTML = "";
    var colors = ["#d6aa36", "#2f7a5d", "#f2d56b", "#ffffff", "#b56f47"];
    var count = intensity === "champion" ? 28 : 16;
    for (var i = 0; i < count; i += 1) {
      var piece = document.createElement("span");
      piece.className = "leaderboard-celebration-piece";
      piece.style.setProperty("--x", (4 + Math.random() * 92) + "%");
      piece.style.setProperty("--delay", (Math.random() * .35) + "s");
      piece.style.setProperty("--drift", ((Math.random() - .5) * 130) + "px");
      piece.style.background = colors[i % colors.length];
      celebrationLayer.appendChild(piece);
    }
    window.setTimeout(function () { celebrationLayer.innerHTML = ""; }, 2300);
  }

  function slideshowStudentCard(row) {
    return (
      '<article class="leaderboard-slideshow-student-card">' +
        '<div class="leaderboard-slideshow-rank">' + ordinal(row.rank) + '</div>' +
        '<a class="student-detail-link" href="' + studentDetailHref(row) + '"><img class="leaderboard-slideshow-photo" src="' + escapeHtml(row.photo_url) + '" alt="' + escapeHtml(row.nickname) + '" /></a>' +
        '<a class="leaderboard-slideshow-name student-detail-link" href="' + studentDetailHref(row) + '">' + escapeHtml(row.nickname) + '</a>' +
        (row.class_name ? '<div class="leaderboard-slideshow-class-chip">' + escapeHtml(row.class_name) + '</div>' : '') +
        tierBadge(row) +
        '<div class="leaderboard-slideshow-points">' + totalPitisText(row.total_points) + '</div>' +
      '</article>'
    );
  }

  function renderSlideshowSlide(index) {
    var groups = slideshowGroups();
    var slide = groups[index];
    if (!slide || !slideshowModal || !slideshowGrid) return;
    slideshowIndex = index;
    slideshowGrid.classList.toggle("is-spotlight", slide.type === "spotlight");
    slideshowGrid.classList.toggle("is-overview", slide.type === "overview");
    slideshowGrid.classList.toggle("is-presentation", slide.type === "presentation");
    if (slide.type === "presentation") {
      slideshowGrid.setAttribute("data-slide-size", String(slide.rows.length));
      slideshowGrid.innerHTML = presentationSlide(slide);
      return;
    }
    if (slide.type === "overview") {
      slideshowGrid.setAttribute("data-slide-size", "overview");
      slideshowGrid.innerHTML = slideshowOverviewCard();
      return;
    }
    if (slide.type === "spotlight") {
      slideshowGrid.setAttribute("data-slide-size", "spotlight");
      slideshowGrid.innerHTML = spotlightCard(slide.row, slide.place);
      fitSpotlightName();
      celebrate(slide.place === 1 ? "champion" : "spotlight");
      return;
    }
    slideshowGrid.setAttribute("data-slide-size", String(slide.rows.length || slideshowPageSize()));
    slideshowGrid.innerHTML = slide.rows.map(slideshowStudentCard).join("");
  }

  function isFullscreenActive() {
    return !!document.fullscreenElement;
  }

  function syncFullscreenButton() {
    if (!slideshowFullscreenBtn) return;
    slideshowFullscreenBtn.textContent = isFullscreenActive() ? "Exit Fullscreen" : "Fullscreen";
  }

  function clearSlideshowTimer() {
    if (slideshowTimer) {
      window.clearInterval(slideshowTimer);
      slideshowTimer = null;
    }
  }

  function startSlideshow() {
    if (!latestRankedRows.length || !slideshowModal) return;
    var groups = slideshowGroups();
    if (!groups.length) return;
    clearSlideshowTimer();
    renderSlideshowSlide(0);
    slideshowModal.classList.remove("hidden");
    slideshowModal.setAttribute("aria-hidden", "false");
    celebrate("champion");
    slideshowTimer = window.setInterval(function () {
      var nextIndex = (slideshowIndex + 1) % groups.length;
      renderSlideshowSlide(nextIndex);
    }, slideshowDurationMs);
  }

  function stopSlideshow() {
    clearSlideshowTimer();
    if (isFullscreenActive() && document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    }
    if (!slideshowModal) return;
    slideshowModal.classList.add("hidden");
    slideshowModal.setAttribute("aria-hidden", "true");
    if (slideshowGrid) slideshowGrid.innerHTML = "";
  }

  function toggleSlideshowFullscreen() {
    if (!slideshowModal) return;
    if (isFullscreenActive()) {
      if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
      return;
    }
    if (slideshowModal.requestFullscreen) {
      slideshowModal.requestFullscreen().catch(function () {});
    }
  }

  function openPhotoModal(src, name) {
    if (!photoModal || !photoModalImg) return;
    photoModalImg.src = src;
    photoModalImg.alt = name || "Student photo";
    if (photoModalName) photoModalName.textContent = name || "Student photo";
    photoModal.classList.remove("hidden");
    photoModal.setAttribute("aria-hidden", "false");
  }

  function closePhotoModal() {
    if (!photoModal) return;
    photoModal.classList.add("hidden");
    photoModal.setAttribute("aria-hidden", "true");
    if (photoModalImg) photoModalImg.removeAttribute("src");
  }

  function setSortMode(nextMode) {
    sortMode = nextMode;
    sortMenuItems.forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-sort-mode") === sortMode);
    });
    render(latestRows);
  }

  function refresh() {
    fetch("/api/leaderboard/" + classId)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        latestRows = data.rows || [];
        latestSpotlightRows = data.spotlightRows || [];
        render(latestRows);
        if (lastUpdated) lastUpdated.textContent = "Last updated: " + new Date(data.timestamp).toLocaleString();
      })
      .catch(function () {});
  }

  if (menuBtn && menuPanel) {
    menuBtn.addEventListener("click", function () {
      var isOpen = !menuPanel.classList.contains("hidden");
      menuPanel.classList.toggle("hidden", isOpen);
      menuBtn.setAttribute("aria-expanded", String(!isOpen));
    });

    document.addEventListener("click", function (e) {
      if (!menuPanel.classList.contains("hidden") && !menuPanel.contains(e.target) && !menuBtn.contains(e.target)) {
        menuPanel.classList.add("hidden");
        menuBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  if (slideshowBtn) {
    slideshowBtn.addEventListener("click", startSlideshow);
  }
  if (slideshowMenuBtn) {
    slideshowMenuBtn.addEventListener("click", function () {
      startSlideshow();
      if (menuPanel) menuPanel.classList.add("hidden");
      if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
    });
  }
  if (slideshowCloseBtn) {
    slideshowCloseBtn.addEventListener("click", stopSlideshow);
  }
  if (slideshowFullscreenBtn) {
    slideshowFullscreenBtn.addEventListener("click", toggleSlideshowFullscreen);
  }
  if (pdfBtn) pdfBtn.addEventListener("click", exportClassLeaderboardPdf);
  if (pdfMenuBtn) pdfMenuBtn.addEventListener("click", exportClassLeaderboardPdf);
  if (pdfCloseBtn) pdfCloseBtn.addEventListener("click", closeClassLeaderboardPdf);
  if (pdfGenerateBtn) pdfGenerateBtn.addEventListener("click", generateClassLeaderboardPdf);
  if (pdfModal) pdfModal.addEventListener("click", function (event) {
    if (event.target === pdfModal) closeClassLeaderboardPdf();
  });
  if (pdfToDate && !pdfToDate.value) {
    var pdfLocalToday = new Date();
    pdfLocalToday.setMinutes(pdfLocalToday.getMinutes() - pdfLocalToday.getTimezoneOffset());
    pdfToDate.value = pdfLocalToday.toISOString().slice(0, 10);
    pdfToDate.max = pdfToDate.value;
  }
  if (mountainBtn) mountainBtn.addEventListener("click", startMountainPath);
  if (mountainReplayBtn) mountainReplayBtn.addEventListener("click", playMountainPath);
  if (mountainCloseBtn) mountainCloseBtn.addEventListener("click", stopMountainPath);
  if (mountainFullscreenBtn) mountainFullscreenBtn.addEventListener("click", function () {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    else if (mountainModal && mountainModal.requestFullscreen) mountainModal.requestFullscreen().catch(function () {});
  });
  if (slideshowModal) {
    slideshowModal.addEventListener("click", function (event) {
      if (event.target === slideshowModal) stopSlideshow();
    });
  }
  document.addEventListener("click", function (event) {
    var photoBtn = event.target.closest ? event.target.closest(".leaderboard-photo-button") : null;
    if (photoBtn) {
      openPhotoModal(photoBtn.getAttribute("data-photo-src") || "", photoBtn.getAttribute("data-photo-name") || "");
      return;
    }
    var nearbyBtn = event.target.closest ? event.target.closest("[data-nearby-student-id]") : null;
    if (nearbyBtn) {
      var nearbyStudent = latestRankedRows.find(function (row) { return String(row.id) === String(nearbyBtn.getAttribute("data-nearby-student-id")); });
      focusStudent(nearbyStudent);
      return;
    }
    var leaderboardRow = event.target.closest ? event.target.closest("[data-focus-student-id]") : null;
    if (leaderboardRow && !(event.target.closest && event.target.closest("a, button"))) {
      var selectedRow = latestRankedRows.find(function (row) { return String(row.id) === String(leaderboardRow.getAttribute("data-focus-student-id")); });
      focusStudent(selectedRow);
    }
  });
  if (progressContainer) {
    progressContainer.addEventListener("change", function (event) {
      if (!event.target || event.target.id !== "leaderboardFocusSelect") return;
      var selected = latestRankedRows.find(function (row) { return String(row.id) === String(event.target.value); });
      focusStudent(selected);
    });
  }

  function clearMountainTimers() {
    mountainTimers.forEach(function (timer) { window.clearTimeout(timer); });
    mountainTimers = [];
  }

  function mountainPosition(index, total) {
    var t = total <= 1 ? 1 : index / (total - 1);
    var points = [[8,89],[19,81],[28,67],[38,61],[47,45],[57,47],[67,31],[77,32],[85,17],[93,8]];
    var scaled = t * (points.length - 1);
    var a = points[Math.floor(scaled)];
    var b = points[Math.min(points.length - 1, Math.ceil(scaled))];
    var f = scaled - Math.floor(scaled);
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f };
  }

  function playMountainPath() {
    if (!mountainStudents || !latestRankedRows.length) return;
    clearMountainTimers();
    mountainStudents.innerHTML = '';
    var total = latestRankedRows.length;
    var nodes = latestRankedRows.map(function (row, index) {
      var target = mountainPosition(total - 1 - index, total);
      var node = document.createElement('div');
      node.className = 'mountain-student';
      node.style.setProperty('--base-x', (10 + (index * 80 / Math.max(1, total - 1))) + '%');
      node.style.setProperty('--base-y', '89%');
      node.style.setProperty('--target-x', target.x + '%');
      node.style.setProperty('--target-y', target.y + '%');
      node.innerHTML = '<b>#' + row.rank + '</b><img src="' + escapeHtml(row.photo_url) + '" alt=""><span>' + escapeHtml(row.nickname) + '</span>';
      mountainStudents.appendChild(node);
      return node;
    });
    var nextMoveDelay = 1700;
    nodes.slice().sort(function () { return Math.random() - .5; }).forEach(function (node) {
      nextMoveDelay += 2000 + Math.random() * 1000;
      mountainTimers.push(window.setTimeout(function () { node.classList.add('is-climbing'); }, nextMoveDelay));
    });
  }

  function startMountainPath() {
    if (!mountainModal) return;
    mountainModal.classList.remove('hidden');
    mountainModal.setAttribute('aria-hidden', 'false');
    playMountainPath();
    if (mountainModal.requestFullscreen) mountainModal.requestFullscreen().catch(function () {});
  }

  function stopMountainPath() {
    clearMountainTimers();
    if (document.fullscreenElement === mountainModal && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    mountainModal.classList.add('hidden');
    mountainModal.setAttribute('aria-hidden', 'true');
  }
  if (photoModalCloseBtn) {
    photoModalCloseBtn.addEventListener("click", closePhotoModal);
  }
  if (photoModal) {
    photoModal.addEventListener("click", function (event) {
      if (event.target === photoModal) closePhotoModal();
    });
  }
  document.addEventListener("fullscreenchange", syncFullscreenButton);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      stopSlideshow();
      closePhotoModal();
    }
  });

  sortMenuItems.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setSortMode(btn.getAttribute("data-sort-mode") || "desc");
      if (menuPanel) menuPanel.classList.add("hidden");
      if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
    });
  });

  latestRows = parseInitialRows();
  latestSpotlightRows = parseSpotlightRows();
  render(latestRows);
  syncFullscreenButton();
  setInterval(refresh, 3000);
})();
