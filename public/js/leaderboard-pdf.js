(function () {
  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function tierFor(total) {
    var points = Number(total || 0);
    if (points >= 320) return { key: "gold", label: "Gold" };
    if (points >= 240) return { key: "silver", label: "Silver" };
    if (points >= 160) return { key: "bronze", label: "Bronze" };
    if (points >= 80) return { key: "rising", label: "Rising" };
    return { key: "starter", label: "Starter" };
  }

  function photoFor(row) {
    var photo = String(row.photo_url || "").trim() || "/img/student-placeholder.svg";
    try {
      return new URL(photo, window.location.origin).href;
    } catch (_) {
      return new URL("/img/student-placeholder.svg", window.location.origin).href;
    }
  }

  function studentCard(row, podiumPlace) {
    var tier = row.tier || tierFor(row.total_points);
    var podiumClass = podiumPlace ? " podium place-" + podiumPlace : "";
    var crown = podiumPlace === 1 ? '<span class="crown">♛</span>' : "";
    return '<article class="student-card' + podiumClass + '">'
      + crown
      + '<span class="rank">#' + escapeHtml(row.rank) + '</span>'
      + '<img src="' + escapeHtml(photoFor(row)) + '" alt="">'
      + '<div class="student-copy"><strong>' + escapeHtml(row.nickname || "Student") + '</strong>'
      + '<span>' + escapeHtml(row.class_name || "") + '</span>'
      + '<small>Weekly: ' + escapeHtml(Number(row.weekly_points || 0).toLocaleString()) + ' PITIS</small>'
      + '<small class="reason">' + escapeHtml(row.last_reason || "Keep growing") + '</small></div>'
      + '<div class="score"><b>' + escapeHtml(Number(row.total_points || 0).toLocaleString()) + '</b><span>PITIS</span>'
      + '<em class="tier ' + escapeHtml(tier.key || "starter") + '">' + escapeHtml(tier.label || "Starter") + '</em></div>'
      + '</article>';
  }

  function recognitionCard(title, row, detail) {
    if (!row) return "";
    return '<article class="recognition-card"><span>' + escapeHtml(title) + '</span>'
      + '<img src="' + escapeHtml(photoFor(row)) + '" alt="">'
      + '<div><strong>' + escapeHtml(row.nickname || "Student") + '</strong>'
      + '<small>' + escapeHtml(detail) + '</small></div></article>';
  }

  function sectionHtml(section, reportDate) {
    var rows = Array.isArray(section.rows) ? section.rows : [];
    var podium = rows.slice(0, 3).map(function (row, index) {
      return studentCard(row, index + 1);
    }).join("");
    var remaining = rows.slice(3).map(function (row) { return studentCard(row, 0); }).join("");
    var weeklyChampion = rows.slice().sort(function (a, b) { return Number(b.weekly_points || 0) - Number(a.weekly_points || 0) || Number(b.total_points || 0) - Number(a.total_points || 0); })[0];
    var mostConsistent = rows.slice().sort(function (a, b) { return Number(b.positive_weeks_4 || 0) - Number(a.positive_weeks_4 || 0) || Number(b.total_points || 0) - Number(a.total_points || 0); })[0];
    var mostActive = rows.slice().sort(function (a, b) { return Number(b.weekly_award_count || 0) - Number(a.weekly_award_count || 0) || Number(b.weekly_points || 0) - Number(a.weekly_points || 0); })[0];
    var recognition = recognitionCard("Weekly Champion", weeklyChampion, Number(weeklyChampion && weeklyChampion.weekly_points || 0).toLocaleString() + " PITIS this week")
      + recognitionCard("Most Consistent", mostConsistent, Number(mostConsistent && mostConsistent.positive_weeks_4 || 0) + " active weeks")
      + recognitionCard("Most Active", mostActive, Number(mostActive && mostActive.weekly_award_count || 0) + " positive awards");
    if (!rows.length) remaining = '<p class="empty">No leaderboard records.</p>';
    return '<section class="leaderboard-poster">'
      + '<header><img class="school-mark" src="' + escapeHtml(new URL('/images/brunei-school-logo.jpg', window.location.origin).href) + '" alt="School logo"><div><small>SEKOLAH RENDAH O.K.A.W.S.D KUPANG</small>'
      + '<h1>P.I.T.I.S LEADERS</h1><h2>' + escapeHtml(section.name || "Leaderboard") + '</h2></div>'
      + '<div class="generated">Noticeboard Edition<br>Leaderboard up to ' + escapeHtml(reportDate || new Date().toLocaleDateString()) + '</div></header>'
      + '<div class="poster-layout"><main>'
      + (podium ? '<div class="podium-grid">' + podium + '</div>' : '')
      + (remaining ? '<div class="student-grid">' + remaining + '</div>' : '')
      + '</main><aside class="recognition-grid">' + recognition + '</aside></div>'
      + '<footer>Positive Individuals That Inspire Society · Celebrate effort, growth and good choices</footer>'
      + '</section>';
  }

  function stylesheet() {
    return '@page{size:A4 landscape;margin:7mm}*{box-sizing:border-box}body{margin:0;background:#fff;font-family:Arial,sans-serif;color:#173c2d;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      + '.leaderboard-poster{height:196mm;break-after:page;display:flex;flex-direction:column;padding:4mm;border:1.5px solid #56a849;border-radius:10px;overflow:hidden}'
      + '.leaderboard-poster:last-child{break-after:auto}header{display:grid;grid-template-columns:16mm 1fr auto;align-items:center;gap:4mm;padding:3mm 4mm;border-radius:9px;background:#194c39;color:#fff}'
      + '.school-mark{width:16mm;height:16mm;object-fit:contain;border-radius:5px;background:#fff;border:1.5px solid #d2ad43}'
      + 'header small{font-size:7.5px;letter-spacing:1.1px}h1{margin:.5mm 0 0;font-size:20px;letter-spacing:1.2px}h2{margin:.5mm 0 0;color:#f3d46a;font-size:13px}.generated{text-align:right;font-size:8px;line-height:1.5}'
      + '.poster-layout{display:grid;grid-template-columns:minmax(0,1fr) 43mm;gap:3mm;min-height:0;flex:1;padding-top:3mm}.poster-layout main{min-width:0}.recognition-grid{display:grid;align-content:start;gap:2.5mm}'
      + '.podium-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3mm;margin:0 0 3mm}.student-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2mm;align-content:start}'
      + '.student-card{position:relative;display:grid;grid-template-columns:8mm 12mm minmax(0,1fr);align-items:center;gap:1.5mm;min-width:0;min-height:18mm;padding:1.8mm;background:#fff;border:1.2px solid #56a849;border-radius:6px;box-shadow:1px 1.5px 0 #d9e8d5;break-inside:avoid;overflow:hidden}'
      + '.student-card.podium{grid-template-columns:9mm 16mm minmax(0,1fr);min-height:28mm;padding:2.5mm;border-width:1.7px}.student-card.podium .score{grid-column:3;display:grid}.place-1{background:#fff9e8}.place-2{border-color:#7c978c}.place-3{border-color:#a56e47}'
      + '.rank{font-size:12px;font-weight:900;text-align:center}.student-card img{width:12mm;height:12mm;object-fit:cover;border-radius:4px;border:1.2px solid #bad4b4}.podium img{width:16mm;height:16mm}'
      + '.student-copy{display:grid;min-width:0;overflow:hidden}.student-copy strong{font-size:9.5px;line-height:1.05;max-height:21px;overflow:hidden;overflow-wrap:anywhere}.student-copy span,.student-copy small{font-size:6.8px;color:#53675e;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.reason{font-style:italic}'
      + '.score{display:none;text-align:center}.podium .score{display:grid}.score b{font-size:11px}.score span{font-size:6px;font-weight:800}.tier{margin-top:.7mm;padding:.7mm;border-radius:6px;background:#deebe5;color:#194c39;font-size:5.8px;font-style:normal;font-weight:800;text-transform:uppercase}'
      + '.recognition-card{display:grid;grid-template-columns:12mm minmax(0,1fr);grid-template-rows:auto 1fr;align-items:center;gap:1.2mm 2mm;min-width:0;min-height:29mm;padding:2.5mm;border:1.2px solid #56a849;border-radius:7px;background:#fff;overflow:hidden}.recognition-card>span{grid-column:1/-1;color:#245d43;font-size:8px;font-weight:900;text-transform:uppercase}.recognition-card img{width:12mm;height:12mm;object-fit:cover;border-radius:4px}.recognition-card div{display:grid;min-width:0}.recognition-card strong{font-size:9.5px;line-height:1.05;overflow-wrap:anywhere}.recognition-card small{font-size:7px;color:#53675e;overflow-wrap:anywhere}'
      + '.tier.gold{background:#f4d56c}.tier.silver{background:#dce2e7}.tier.bronze{background:#e8c0a5}.crown{position:absolute;top:-4mm;left:50%;font-size:16px;color:#bd8d12}.empty{text-align:center;padding:20mm}'
      + 'footer{margin-top:auto;padding-top:2mm;text-align:center;color:#667970;font-size:7.5px;font-weight:700}';
  }

  function waitForImages(printWindow) {
    var images = Array.prototype.slice.call(printWindow.document.images || []);
    return Promise.all(images.map(function (image) {
      if (image.complete) return Promise.resolve();
      return new Promise(function (resolve) {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    }));
  }

  function exportPdf(options) {
    var sections = options && Array.isArray(options.sections) ? options.sections : [];
    if (!sections.length) return false;
    var printWindow = options.printWindow || window.open("", "_blank");
    if (!printWindow) return false;
    printWindow.document.open();
    printWindow.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>PITIS Leaderboard Noticeboard</title><style>'
      + stylesheet() + '</style></head><body>' + sections.map(function (section) {
        return sectionHtml(section, options.reportDate);
      }).join("") + '</body></html>');
    printWindow.document.close();
    waitForImages(printWindow).then(function () {
      window.setTimeout(function () {
        printWindow.focus();
        printWindow.print();
      }, 200);
    });
    return true;
  }

  window.PitisLeaderboardPdf = { export: exportPdf };
})();
