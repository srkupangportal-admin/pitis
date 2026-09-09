const express = require("express");
const dayjs = require("dayjs");
const { db } = require("../db/init");
const { requireAnyAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const catatanHarianCategories = {
  pemakanan: "Catatan Pemakanan",
  aktiviti: "Aktiviti Harian"
};
const catatanHarianDays = ["Isnin", "Selasa", "Rabu", "Khamis", "Jumaat", "Sabtu", "Ahad"];

router.use(requireAnyAuth);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getNoteBundle(noteId) {
  const note = db
    .prepare(
      `SELECT
         n.id,
         n.title,
         n.body,
         n.created_at,
         n.updated_at,
         cu.display_name AS created_by_name,
         uu.display_name AS updated_by_name
       FROM notes n
       JOIN users cu ON cu.id = n.created_by
       LEFT JOIN users uu ON uu.id = n.updated_by
       WHERE n.id = ?`
    )
    .get(noteId);

  if (!note) return null;

  const comments = db
    .prepare(
      `SELECT
         c.comment_text,
         c.created_at,
         u.display_name AS created_by_name
       FROM note_comments c
       JOIN users u ON u.id = c.created_by
       WHERE c.note_id = ?
       ORDER BY c.created_at ASC, c.id ASC`
    )
    .all(noteId);

  const logs = db
    .prepare(
      `SELECT
         l.action_type,
         l.log_details,
         l.created_at,
         u.display_name AS actor_name
       FROM note_logs l
       JOIN users u ON u.id = l.actor_user_id
       WHERE l.note_id = ?
       ORDER BY l.created_at DESC, l.id DESC`
    )
    .all(noteId);

  return { ...note, comments, logs };
}

function fetchNotesWithRelated() {
  const notes = db
    .prepare(
      `SELECT
         n.id,
         n.title,
         n.body,
         n.created_at,
         n.updated_at,
         cu.display_name AS created_by_name,
         uu.display_name AS updated_by_name
       FROM notes n
       JOIN users cu ON cu.id = n.created_by
       LEFT JOIN users uu ON uu.id = n.updated_by
       ORDER BY COALESCE(n.updated_at, n.created_at) DESC, n.id DESC`
    )
    .all();

  const comments = db
    .prepare(
      `SELECT
         c.id,
         c.note_id,
         c.comment_text,
         c.created_at,
         u.display_name AS created_by_name
       FROM note_comments c
       JOIN users u ON u.id = c.created_by
       ORDER BY c.created_at ASC, c.id ASC`
    )
    .all();

  const logs = db
    .prepare(
      `SELECT
         l.id,
         l.note_id,
         l.action_type,
         l.log_details,
         l.created_at,
         u.display_name AS actor_name
       FROM note_logs l
       JOIN users u ON u.id = l.actor_user_id
       ORDER BY l.created_at DESC, l.id DESC`
    )
    .all();

  const commentsByNote = new Map();
  comments.forEach((comment) => {
    const list = commentsByNote.get(comment.note_id) || [];
    list.push(comment);
    commentsByNote.set(comment.note_id, list);
  });

  const logsByNote = new Map();
  logs.forEach((log) => {
    const list = logsByNote.get(log.note_id) || [];
    list.push(log);
    logsByNote.set(log.note_id, list);
  });

  return notes.map((note) => ({
    ...note,
    comments: commentsByNote.get(note.id) || [],
    logs: logsByNote.get(note.id) || []
  }));
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function getCatatanHarianUsers() {
  return db.prepare(`
    SELECT id, username, display_name, role
    FROM users
    WHERE is_active = 1
    ORDER BY LOWER(display_name) ASC, LOWER(username) ASC
  `).all();
}

function getCatatanHarianChecklistItems(activeOnly = false) {
  const where = activeOnly ? "WHERE is_active = 1" : "";
  const rows = db.prepare(`
    SELECT id, category, item_text, is_active, created_at, updated_at
    FROM catatan_harian_checklist_items
    ${where}
    ORDER BY category ASC, is_active DESC, id ASC
  `).all();
  return {
    pemakanan: rows.filter((item) => item.category === "pemakanan"),
    aktiviti: rows.filter((item) => item.category === "aktiviti"),
    all: rows
  };
}

function getCatatanHarianReportItems(reportIds) {
  const ids = (reportIds || []).map((id) => Number(id || 0)).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT *
    FROM catatan_harian_report_items
    WHERE report_id IN (${placeholders})
    ORDER BY category ASC, id ASC
  `).all(...ids);
  rows.forEach((item) => {
    const list = map.get(item.report_id) || [];
    list.push(item);
    map.set(item.report_id, list);
  });
  return map;
}

function formatCatatanReport(report) {
  const items = report.items || [];
  return {
    ...report,
    pemakananItems: items.filter((item) => item.category === "pemakanan"),
    aktivitiItems: items.filter((item) => item.category === "aktiviti")
  };
}

function getCatatanHarianReports() {
  const reports = db.prepare(`
    SELECT
      r.*,
      u.display_name AS user_name,
      u.username AS username,
      cu.display_name AS created_by_name
    FROM catatan_harian_reports r
    JOIN users u ON u.id = r.user_id
    JOIN users cu ON cu.id = r.created_by
    ORDER BY r.tarikh DESC, r.id DESC
  `).all();
  const itemsByReport = getCatatanHarianReportItems(reports.map((report) => report.id));
  return reports.map((report) => formatCatatanReport({
    ...report,
    items: itemsByReport.get(report.id) || []
  }));
}

function getCatatanHarianReport(reportId) {
  const report = db.prepare(`
    SELECT
      r.*,
      u.display_name AS user_name,
      u.username AS username,
      cu.display_name AS created_by_name
    FROM catatan_harian_reports r
    JOIN users u ON u.id = r.user_id
    JOIN users cu ON cu.id = r.created_by
    WHERE r.id = ?
  `).get(reportId);
  if (!report) return null;
  const itemsByReport = getCatatanHarianReportItems([reportId]);
  return formatCatatanReport({
    ...report,
    items: itemsByReport.get(reportId) || []
  });
}

function getSelectedCatatanChecklistItems(selectedIds, activeOnly = false) {
  const ids = selectedIds.map((id) => Number(id || 0)).filter(Boolean);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const activeClause = activeOnly ? "AND is_active = 1" : "";
  return db.prepare(`
    SELECT id, category, item_text
    FROM catatan_harian_checklist_items
    WHERE id IN (${placeholders}) ${activeClause}
    ORDER BY category ASC, id ASC
  `).all(...ids);
}

function safeExportName(value) {
  return String(value || "catatan-harian").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function catatanReportFileBase(report) {
  return [report.hari, report.tarikh, report.user_name]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("_") || "catatan-harian";
}

function catatanReportHtml(report) {
  const listHtml = (items) => items.length
    ? items.map((item) => `<li>${escapeHtml(item.item_text)}</li>`).join("")
    : "<li>Tiada item dipilih</li>";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Catatan Harian</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.5; color: #1f2937; margin: 32px; }
    h1, h2 { color: #111827; }
    .meta { margin-bottom: 20px; color: #4b5563; }
    .catatan { white-space: pre-wrap; border: 1px solid #d1d5db; padding: 16px; border-radius: 8px; background: #f9fafb; }
    ul { padding-left: 20px; }
  </style>
</head>
<body>
  <h1>Catatan Harian</h1>
  <div class="meta">
    <strong>Nama:</strong> ${escapeHtml(report.user_name)}<br />
    <strong>Hari:</strong> ${escapeHtml(report.hari)}<br />
    <strong>Tarikh:</strong> ${escapeHtml(report.tarikh)}<br />
    <strong>Disediakan oleh:</strong> ${escapeHtml(report.created_by_name)} (${escapeHtml(report.created_at)})
  </div>
  <h2>Catatan Pemakanan</h2>
  <ul>${listHtml(report.pemakananItems)}</ul>
  <h2>Aktiviti Harian</h2>
  <ul>${listHtml(report.aktivitiItems)}</ul>
  <h2>Catatan</h2>
  <div class="catatan">${escapeHtml(report.catatan || "-")}</div>
</body>
</html>`;
}

function escapePdfText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function createSimplePdf(pages) {
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const contentIds = pages.map((page) => addObject(`<< /Length ${Buffer.byteLength(page.content, "binary")} >>\nstream\n${page.content}\nendstream`));
  const pageIds = contentIds.map((contentId) => addObject(`<< /Type /Page /Parent __PAGES__ 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  const pagesId = addObject(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  for (const pageId of pageIds) {
    objects[pageId - 1] = objects[pageId - 1].replace("__PAGES__", String(pagesId));
  }
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(chunks.join(""), "binary"));
    chunks.push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefOffset = Buffer.byteLength(chunks.join(""), "binary");
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach((offset) => chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`));
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(""), "binary");
}

function pdfText(x, y, text, size = 11) {
  return `BT /F1 ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdfText(text)}) Tj ET\n`;
}

function wrapPdfText(text, maxChars) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";
  words.forEach((word) => {
    if (!current) {
      current = word;
      return;
    }
    if (current.length + word.length + 1 <= maxChars) {
      current += ` ${word}`;
      return;
    }
    lines.push(current);
    current = word;
  });
  if (current) lines.push(current);
  return lines.length ? lines : ["-"];
}

function buildCatatanHarianPdf(report) {
  const lines = [
    { text: "Catatan Harian", size: 18, gap: 24 },
    { text: `Nama: ${report.user_name}`, size: 11, gap: 16 },
    { text: `Hari: ${report.hari}`, size: 11, gap: 16 },
    { text: `Tarikh: ${report.tarikh}`, size: 11, gap: 16 },
    { text: `Disediakan oleh: ${report.created_by_name}`, size: 11, gap: 24 },
    { text: "Catatan Pemakanan", size: 14, gap: 18 },
    ...((report.pemakananItems.length ? report.pemakananItems : [{ item_text: "Tiada item dipilih" }]).map((item) => ({ text: `- ${item.item_text}`, size: 11, gap: 15 }))),
    { text: "Aktiviti Harian", size: 14, gap: 18 },
    ...((report.aktivitiItems.length ? report.aktivitiItems : [{ item_text: "Tiada item dipilih" }]).map((item) => ({ text: `- ${item.item_text}`, size: 11, gap: 15 }))),
    { text: "Catatan", size: 14, gap: 18 },
    ...wrapPdfText(report.catatan || "-", 82).map((line) => ({ text: line, size: 11, gap: 15 }))
  ];
  const pages = [];
  let content = "";
  let y = 790;
  lines.forEach((line) => {
    if (y < 60) {
      pages.push({ content });
      content = "";
      y = 790;
    }
    content += pdfText(48, y, line.text, line.size);
    y -= line.gap;
  });
  pages.push({ content });
  return createSimplePdf(pages);
}

router.get("/", (req, res) => {
  res.render("notes", {
    notes: fetchNotesWithRelated(),
    error: req.query.error || "",
    success: req.query.success || ""
  });
});

router.get("/catatan-harian", (req, res) => {
  res.render("catatan-harian", {
    users: getCatatanHarianUsers(),
    days: catatanHarianDays,
    checklist: getCatatanHarianChecklistItems(true),
    allChecklist: getCatatanHarianChecklistItems(false).all,
    reports: getCatatanHarianReports(),
    categories: catatanHarianCategories,
    form: {
      user_id: req.session.user ? req.session.user.id : "",
      hari: "",
      tarikh: dayjs().format("YYYY-MM-DD"),
      catatan: ""
    },
    error: req.query.error || "",
    success: req.query.success || ""
  });
});

router.post("/catatan-harian", (req, res) => {
  try {
    const userId = Number(req.body.user_id || 0);
    const hari = String(req.body.hari || "").trim();
    const tarikh = String(req.body.tarikh || "").trim();
    const catatan = String(req.body.catatan || "").trim();
    const selectedIds = normalizeArray(req.body.checklist_items).map((id) => Number(id || 0)).filter(Boolean);

    if (!userId || !catatanHarianDays.includes(hari) || !tarikh) {
      return res.redirect("/notes/catatan-harian?error=Nama%2C+hari%2C+dan+tarikh+diperlukan");
    }
    const selectedUser = db.prepare("SELECT id FROM users WHERE id = ? AND is_active = 1").get(userId);
    if (!selectedUser) {
      return res.redirect("/notes/catatan-harian?error=Nama+tidak+dijumpai");
    }
    if (!selectedIds.length) {
      return res.redirect("/notes/catatan-harian?error=Pilih+sekurang-kurangnya+satu+item+checklist");
    }

    const selectedItems = getSelectedCatatanChecklistItems(selectedIds, true);
    if (selectedItems.length !== selectedIds.length) {
      return res.redirect("/notes/catatan-harian?error=Checklist+item+tidak+sah");
    }

    const now = dayjs().toISOString();
    const actorId = Number(req.session.user.id);
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO catatan_harian_reports (user_id, hari, tarikh, catatan, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(userId, hari, tarikh, catatan || null, actorId, now, now);
      const reportId = Number(info.lastInsertRowid);
      const insertItem = db.prepare(`
        INSERT INTO catatan_harian_report_items (report_id, checklist_item_id, category, item_text)
        VALUES (?, ?, ?, ?)
      `);
      selectedItems.forEach((item) => insertItem.run(reportId, item.id, item.category, item.item_text));
      return reportId;
    });
    tx();
    return res.redirect("/notes/catatan-harian?success=Catatan+harian+disimpan");
  } catch (error) {
    return res.redirect(`/notes/catatan-harian?error=${encodeURIComponent(error.message || "Tidak dapat menyimpan catatan harian")}`);
  }
});

router.post("/catatan-harian/:id/edit", (req, res) => {
  try {
    const reportId = Number(req.params.id || 0);
    const existing = db.prepare("SELECT id FROM catatan_harian_reports WHERE id = ?").get(reportId);
    if (!existing) {
      return res.redirect("/notes/catatan-harian?error=Catatan+harian+tidak+dijumpai");
    }

    const userId = Number(req.body.user_id || 0);
    const hari = String(req.body.hari || "").trim();
    const tarikh = String(req.body.tarikh || "").trim();
    const catatan = String(req.body.catatan || "").trim();
    const selectedIds = normalizeArray(req.body.checklist_items).map((id) => Number(id || 0)).filter(Boolean);

    if (!userId || !catatanHarianDays.includes(hari) || !tarikh) {
      return res.redirect("/notes/catatan-harian?error=Nama%2C+hari%2C+dan+tarikh+diperlukan");
    }
    const selectedUser = db.prepare("SELECT id FROM users WHERE id = ? AND is_active = 1").get(userId);
    if (!selectedUser) {
      return res.redirect("/notes/catatan-harian?error=Nama+tidak+dijumpai");
    }
    if (!selectedIds.length) {
      return res.redirect("/notes/catatan-harian?error=Pilih+sekurang-kurangnya+satu+item+checklist");
    }

    const selectedItems = getSelectedCatatanChecklistItems(selectedIds, false);
    if (selectedItems.length !== selectedIds.length) {
      return res.redirect("/notes/catatan-harian?error=Checklist+item+tidak+sah");
    }

    const now = dayjs().toISOString();
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE catatan_harian_reports
        SET user_id = ?, hari = ?, tarikh = ?, catatan = ?, updated_at = ?
        WHERE id = ?
      `).run(userId, hari, tarikh, catatan || null, now, reportId);

      db.prepare("DELETE FROM catatan_harian_report_items WHERE report_id = ?").run(reportId);
      const insertItem = db.prepare(`
        INSERT INTO catatan_harian_report_items (report_id, checklist_item_id, category, item_text)
        VALUES (?, ?, ?, ?)
      `);
      selectedItems.forEach((item) => insertItem.run(reportId, item.id, item.category, item.item_text));
    });
    tx();
    return res.redirect("/notes/catatan-harian?success=Catatan+harian+dikemaskini");
  } catch (error) {
    return res.redirect(`/notes/catatan-harian?error=${encodeURIComponent(error.message || "Tidak dapat mengemaskini catatan harian")}`);
  }
});

router.post("/catatan-harian/delete-selected", requireRole("admin"), (req, res) => {
  try {
    const reportIds = normalizeArray(req.body.report_ids).map((id) => Number(id || 0)).filter(Boolean);
    if (!reportIds.length) {
      return res.redirect("/notes/catatan-harian?error=Pilih+sekurang-kurangnya+satu+catatan+untuk+dipadam");
    }
    const placeholders = reportIds.map(() => "?").join(", ");
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM catatan_harian_report_items WHERE report_id IN (${placeholders})`).run(...reportIds);
      return db.prepare(`DELETE FROM catatan_harian_reports WHERE id IN (${placeholders})`).run(...reportIds);
    });
    const result = tx();
    return res.redirect(`/notes/catatan-harian?success=${encodeURIComponent(`${result.changes} catatan harian dipadam`)}`);
  } catch (error) {
    return res.redirect(`/notes/catatan-harian?error=${encodeURIComponent(error.message || "Tidak dapat memadam catatan harian")}`);
  }
});

router.get("/catatan-harian/:id/export.doc", (req, res) => {
  const report = getCatatanHarianReport(Number(req.params.id || 0));
  if (!report) return res.status(404).send("Catatan harian not found");
  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=${safeExportName(catatanReportFileBase(report))}.doc`);
  return res.send(catatanReportHtml(report));
});

router.get("/catatan-harian/:id/export.pdf", (req, res) => {
  const report = getCatatanHarianReport(Number(req.params.id || 0));
  if (!report) return res.status(404).send("Catatan harian not found");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=${safeExportName(catatanReportFileBase(report))}.pdf`);
  return res.send(buildCatatanHarianPdf(report));
});

router.post("/catatan-harian/checklist/add", requireRole("admin"), (req, res) => {
  const category = String(req.body.category || "").trim();
  const itemText = String(req.body.item_text || "").trim();
  if (!catatanHarianCategories[category] || !itemText) {
    return res.redirect("/notes/catatan-harian?error=Kategori+dan+item+checklist+diperlukan");
  }
  const now = dayjs().toISOString();
  db.prepare(`
    INSERT INTO catatan_harian_checklist_items (category, item_text, is_active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `).run(category, itemText, now, now);
  return res.redirect("/notes/catatan-harian?success=Checklist+item+ditambah");
});

router.post("/catatan-harian/checklist/:id/edit", requireRole("admin"), (req, res) => {
  const itemId = Number(req.params.id || 0);
  const category = String(req.body.category || "").trim();
  const itemText = String(req.body.item_text || "").trim();
  const isActive = req.body.is_active ? 1 : 0;
  if (!itemId || !catatanHarianCategories[category] || !itemText) {
    return res.redirect("/notes/catatan-harian?error=Checklist+item+tidak+sah");
  }
  db.prepare(`
    UPDATE catatan_harian_checklist_items
    SET category = ?, item_text = ?, is_active = ?, updated_at = ?
    WHERE id = ?
  `).run(category, itemText, isActive, dayjs().toISOString(), itemId);
  return res.redirect("/notes/catatan-harian?success=Checklist+item+dikemaskini");
});

router.post("/catatan-harian/checklist/:id/delete", requireRole("admin"), (req, res) => {
  const itemId = Number(req.params.id || 0);
  if (!itemId) {
    return res.redirect("/notes/catatan-harian?error=Checklist+item+tidak+sah");
  }
  db.prepare("DELETE FROM catatan_harian_checklist_items WHERE id = ?").run(itemId);
  return res.redirect("/notes/catatan-harian?success=Checklist+item+dipadam");
});

router.post("/add", (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    const body = String(req.body.body || "").trim();
    if (!title || !body) {
      return res.redirect("/notes?error=Title+and+note+content+are+required");
    }

    const now = dayjs().toISOString();
    const userId = Number(req.session.user.id);
    const info = db
      .prepare(
        `INSERT INTO notes (title, body, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(title, body, userId, now, userId, now);

    db.prepare(
      `INSERT INTO note_logs (note_id, action_type, log_details, actor_user_id, created_at)
       VALUES (?, 'create', ?, ?, ?)`
    ).run(Number(info.lastInsertRowid), "Note created", userId, now);

    return res.redirect("/notes?success=Note+saved");
  } catch (error) {
    return res.redirect(`/notes?error=${encodeURIComponent(error.message || "Unable to save note")}`);
  }
});

router.post("/update/:id", (req, res) => {
  try {
    const noteId = Number(req.params.id || 0);
    const title = String(req.body.title || "").trim();
    const body = String(req.body.body || "").trim();
    if (!noteId || !title || !body) {
      return res.redirect("/notes?error=Note+title+and+content+are+required");
    }

    const existing = db.prepare("SELECT id FROM notes WHERE id = ?").get(noteId);
    if (!existing) {
      return res.redirect("/notes?error=Note+not+found");
    }

    const now = dayjs().toISOString();
    const userId = Number(req.session.user.id);
    db.prepare(
      `UPDATE notes
       SET title = ?, body = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`
    ).run(title, body, userId, now, noteId);

    db.prepare(
      `INSERT INTO note_logs (note_id, action_type, log_details, actor_user_id, created_at)
       VALUES (?, 'edit', ?, ?, ?)`
    ).run(noteId, "Note edited", userId, now);

    return res.redirect("/notes?success=Note+updated");
  } catch (error) {
    return res.redirect(`/notes?error=${encodeURIComponent(error.message || "Unable to update note")}`);
  }
});

router.post("/comment/:id", (req, res) => {
  try {
    const noteId = Number(req.params.id || 0);
    const commentText = String(req.body.comment_text || "").trim();
    if (!noteId || !commentText) {
      return res.redirect("/notes?error=Comment+cannot+be+empty");
    }

    const existing = db.prepare("SELECT id FROM notes WHERE id = ?").get(noteId);
    if (!existing) {
      return res.redirect("/notes?error=Note+not+found");
    }

    const now = dayjs().toISOString();
    const userId = Number(req.session.user.id);
    db.prepare(
      `INSERT INTO note_comments (note_id, comment_text, created_by, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(noteId, commentText, userId, now);

    db.prepare(
      `INSERT INTO note_logs (note_id, action_type, log_details, actor_user_id, created_at)
       VALUES (?, 'comment', ?, ?, ?)`
    ).run(noteId, "Comment added", userId, now);

    return res.redirect("/notes?success=Comment+saved");
  } catch (error) {
    return res.redirect(`/notes?error=${encodeURIComponent(error.message || "Unable to save comment")}`);
  }
});

router.get("/export/:id", (req, res) => {
  const noteId = Number(req.params.id || 0);
  const note = getNoteBundle(noteId);
  if (!note) {
    return res.status(404).send("Note not found");
  }

  const safeTitle = String(note.title || "note").replace(/[^a-zA-Z0-9_-]/g, "_");
  const commentsHtml = note.comments.length
    ? note.comments
        .map(
          (comment) =>
            `<li><strong>${escapeHtml(comment.created_by_name)}</strong> (${escapeHtml(comment.created_at)}): ${escapeHtml(comment.comment_text)}</li>`
        )
        .join("")
    : "<li>No comments</li>";

  const logHtml = note.logs.length
    ? note.logs
        .map(
          (log) =>
            `<li><strong>${escapeHtml(log.action_type)}</strong> - ${escapeHtml(log.log_details || "")} (${escapeHtml(log.actor_name)} | ${escapeHtml(log.created_at)})</li>`
        )
        .join("")
    : "<li>No activity log</li>";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(note.title)}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.5; color: #1f2937; margin: 32px; }
    h1, h2 { color: #111827; }
    .meta { margin-bottom: 20px; color: #4b5563; }
    .note-body { white-space: pre-wrap; border: 1px solid #d1d5db; padding: 16px; border-radius: 8px; background: #f9fafb; }
    ul { padding-left: 20px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(note.title)}</h1>
  <div class="meta">
    Created by ${escapeHtml(note.created_by_name)} on ${escapeHtml(note.created_at)}
    ${note.updated_at ? `<br/>Updated by ${escapeHtml(note.updated_by_name || note.created_by_name)} on ${escapeHtml(note.updated_at)}` : ""}
  </div>
  <h2>Note</h2>
  <div class="note-body">${escapeHtml(note.body)}</div>
  <h2>Comments</h2>
  <ul>${commentsHtml}</ul>
  <h2>Activity Log</h2>
  <ul>${logHtml}</ul>
</body>
</html>`;

  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=${safeTitle}.doc`);
  return res.send(html);
});

router.get("/email/:id", (req, res) => {
  const noteId = Number(req.params.id || 0);
  const note = getNoteBundle(noteId);
  if (!note) {
    return res.redirect("/notes?error=Note+not+found");
  }

  const commentLines = note.comments.length
    ? note.comments.map((comment) => `- ${comment.created_by_name} (${comment.created_at}): ${comment.comment_text}`).join("\n")
    : "No comments";

  const body = [
    `Title: ${note.title}`,
    `Created by: ${note.created_by_name} on ${note.created_at}`,
    note.updated_at ? `Updated by: ${note.updated_by_name || note.created_by_name} on ${note.updated_at}` : "",
    "",
    "Note:",
    note.body,
    "",
    "Comments:",
    commentLines
  ].filter(Boolean).join("\n");

  const mailto = `mailto:?subject=${encodeURIComponent("Shared Note: " + note.title)}&body=${encodeURIComponent(body)}`;
  return res.redirect(mailto);
});

module.exports = router;
