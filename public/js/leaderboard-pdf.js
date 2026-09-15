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

  function sectionHtml(section, reportDate) {
    var rows = Array.isArray(section.rows) ? section.rows : [];
    var podium = rows.slice(0, 3).map(function (row, index) {
      return studentCard(row, index + 1);
    }).join("");
    var remaining = rows.slice(3).map(function (row) { return studentCard(row, 0); }).join("");
    if (!rows.length) remaining = '<p class="empty">No leaderboard records.</p>';
    return '<section class="leaderboard-poster">'
      + '<header><div class="school-mark">SRK</div><div><small>SEKOLAH RENDAH O.K.A.W.S.D KUPANG</small>'
      + '<h1>P.I.T.I.S LEADERS</h1><h2>' + escapeHtml(section.name || "Leaderboard") + '</h2></div>'
      + '<div class="generated">Noticeboard Edition<br>Leaderboard up to ' + escapeHtml(reportDate || new Date().toLocaleDateString()) + '</div></header>'
      + (podium ? '<div class="podium-grid">' + podium + '</div>' : '')
      + (remaining ? '<div class="student-grid">' + remaining + '</div>' : '')
      + '<footer>Positive Individuals That Inspire Society · Celebrate effort, growth and good choices</footer>'
      + '</section>';
  }

  function stylesheet() {
    return '@page{size:A4 portrait;margin:8mm}*{box-sizing:border-box}body{margin:0;background:#fff;font-family:Arial,sans-serif;color:#173c2d}'
      + '.leaderboard-poster{min-height:277mm;break-after:page;display:flex;flex-direction:column;padding:5mm;border:2px solid #d2ad43;border-radius:12px}'
      + '.leaderboard-poster:last-child{break-after:auto}header{display:grid;grid-template-columns:17mm 1fr auto;align-items:center;gap:4mm;padding:5mm;border-radius:10px;background:#194c39;color:#fff}'
      + '.school-mark{display:grid;place-items:center;width:17mm;height:17mm;border-radius:50%;background:#fff;color:#194c39;font-weight:900;border:3px solid #d2ad43}'
      + 'header small{font-size:7.5px;letter-spacing:1.2px}h1{margin:1mm 0 0;font-size:22px;letter-spacing:1.5px}h2{margin:1mm 0 0;color:#f3d46a;font-size:15px}.generated{text-align:right;font-size:8px;line-height:1.5}'
      + '.podium-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm;margin:5mm 0}.student-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:2.2mm;align-content:start}'
      + '.student-card{position:relative;display:grid;grid-template-columns:10mm 15mm minmax(0,1fr) 17mm;align-items:center;gap:2mm;min-height:19mm;padding:2mm;background:#f5f8f6;border:1px solid #c9d7d0;border-left:4px solid #2d785a;border-radius:8px;break-inside:avoid}'
      + '.student-card.podium{grid-template-columns:10mm 18mm minmax(0,1fr);padding:3mm 2mm;border:2px solid #d2ad43;background:#fffaf0}.student-card.podium .score{grid-column:2/4;display:flex;flex-direction:row;justify-content:center;gap:2mm}.place-1{transform:translateY(-2mm);background:#fff7d7!important}'
      + '.rank{font-size:14px;font-weight:900;text-align:center}.student-card img{width:15mm;height:15mm;object-fit:cover;border-radius:50%;border:2px solid #d2ad43}.podium img{width:18mm;height:18mm}'
      + '.student-copy{display:grid;min-width:0}.student-copy strong{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.student-copy span,.student-copy small{font-size:7.5px;color:#53675e}.reason{font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.score{display:grid;text-align:center}.score b{font-size:13px}.score span{font-size:6.5px;font-weight:800}.tier{margin-top:1mm;padding:1mm;border-radius:8px;background:#deebe5;color:#194c39;font-size:6.5px;font-style:normal;font-weight:800;text-transform:uppercase}'
      + '.tier.gold{background:#f4d56c}.tier.silver{background:#dce2e7}.tier.bronze{background:#e8c0a5}.crown{position:absolute;top:-4mm;left:50%;font-size:16px;color:#bd8d12}.empty{text-align:center;padding:20mm}'
      + 'footer{margin-top:auto;padding-top:4mm;text-align:center;color:#667970;font-size:8px;font-weight:700}';
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
