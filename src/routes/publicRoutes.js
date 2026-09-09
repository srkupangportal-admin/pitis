const express = require("express");
const dayjs = require("dayjs");
const crypto = require("crypto");
const fs = require("fs");
const { db, updateDailySnapshot } = require("../db/init");
const { getServerConfig } = require("../config/env");
const { parseStudentQrPayload } = require("../services/qrCodeService");
const {
  getLeaderboardSlideshowDurationMs,
  getLeaderboardSlideshowMode,
  getLeaderboardSlideshowStudentCount
} = require("../services/portalSettingsService");
const { buildSipPitisDashboard } = require("../services/sipPitisDashboardService");

const router = express.Router();
const serverConfig = getServerConfig();

const leaderboardQuery = `
  SELECT
    s.id,
    s.class_id,
    c.name AS class_name,
    COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname,
    NULLIF(s.photo_path, '') AS photo_url,
    COALESCE(SUM(pl.points), 0) AS total_points,
    COALESCE(SUM(CASE WHEN pl.points > 0 AND date(pl.awarded_at) >= date(?) THEN pl.points ELSE 0 END), 0) AS weekly_points,
    COALESCE(SUM(CASE WHEN pl.points > 0 AND date(pl.awarded_at) >= date(?, '-7 day') AND date(pl.awarded_at) < date(?) THEN pl.points ELSE 0 END), 0) AS previous_weekly_points,
    COUNT(DISTINCT CASE WHEN pl.points > 0 AND date(pl.awarded_at) >= date(?, '-21 day') THEN strftime('%Y-%W', pl.awarded_at) END) AS positive_weeks_4,
    COALESCE(SUM(CASE WHEN pl.points > 0 AND date(pl.awarded_at) >= date(?) THEN 1 ELSE 0 END), 0) AS weekly_award_count,
    last_log.awarded_at AS last_awarded_at,
    last_log.reason AS last_reason
  FROM students s
  JOIN classes c ON c.id = s.class_id
  LEFT JOIN point_logs pl ON pl.student_id = s.id
  LEFT JOIN (
    SELECT x.student_id, x.awarded_at, x.reason
    FROM point_logs x
    JOIN (
      SELECT student_id, MAX(awarded_at) AS max_awarded_at
      FROM point_logs
      WHERE points > 0
      GROUP BY student_id
    ) m ON m.student_id = x.student_id AND m.max_awarded_at = x.awarded_at
  ) last_log ON last_log.student_id = s.id
  WHERE s.class_id = ?
  GROUP BY s.id, s.class_id, c.name, s.name, s.full_name, s.photo_path, last_log.awarded_at, last_log.reason
  ORDER BY total_points DESC, c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC
`;

const schoolLeaderboardQuery = `
  SELECT
    s.id,
    s.class_id,
    c.name AS class_name,
    COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname,
    NULLIF(s.photo_path, '') AS photo_url,
    COALESCE(SUM(pl.points), 0) AS total_points,
    COALESCE(SUM(CASE WHEN pl.points > 0 AND date(pl.awarded_at) >= date(?) THEN pl.points ELSE 0 END), 0) AS weekly_points,
    last_log.awarded_at AS last_awarded_at,
    last_log.reason AS last_reason
  FROM students s
  JOIN classes c ON c.id = s.class_id
  LEFT JOIN point_logs pl ON pl.student_id = s.id
  LEFT JOIN (
    SELECT x.student_id, x.awarded_at, x.reason
    FROM point_logs x
    JOIN (
      SELECT student_id, MAX(awarded_at) AS max_awarded_at
      FROM point_logs
      WHERE points > 0
      GROUP BY student_id
    ) m ON m.student_id = x.student_id AND m.max_awarded_at = x.awarded_at
  ) last_log ON last_log.student_id = s.id
  GROUP BY s.id, s.class_id, c.name, s.name, s.full_name, s.photo_path, last_log.awarded_at, last_log.reason
  ORDER BY total_points DESC, c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC
`;

function pitisTier(totalPoints) {
  const points = Number(totalPoints || 0);
  if (points >= 320) return { key: "gold", label: "Gold", range: "320+" };
  if (points >= 240) return { key: "silver", label: "Silver", range: "240–319" };
  if (points >= 160) return { key: "bronze", label: "Bronze", range: "160–239" };
  if (points >= 80) return { key: "rising", label: "Rising", range: "80–159" };
  return { key: "starter", label: "Starter", range: "0–79" };
}

function addPitisTiers(rows) {
  return (rows || []).map((row) => ({ ...row, tier: pitisTier(row.total_points) }));
}

function selectDailyFairSpotlights(rows, scopeKey, todayValue = dayjs().format("YYYY-MM-DD")) {
  const cutoff = dayjs(todayValue).subtract(30, "day");
  const awardedRows = (rows || []).filter((row) => row.last_awarded_at && Number(row.total_points || 0) > 0);
  const recentRows = awardedRows.filter((row) => {
    const awardedAt = dayjs(row.last_awarded_at);
    return awardedAt.isValid() && !awardedAt.isBefore(cutoff, "day");
  });
  const eligible = recentRows.length >= 3 ? recentRows : awardedRows;
  if (eligible.length <= 3) return eligible.slice();

  const epochDay = Math.floor(dayjs(todayValue).valueOf() / 86400000);
  const cycleLength = Math.ceil(eligible.length / 3);
  const cycleNumber = Math.floor(epochDay / cycleLength);
  const dayInCycle = ((epochDay % cycleLength) + cycleLength) % cycleLength;
  const shuffled = eligible.slice().sort((a, b) => {
    const scoreA = crypto.createHash("sha256").update(`${scopeKey}:${cycleNumber}:${a.id}`).digest("hex");
    const scoreB = crypto.createHash("sha256").update(`${scopeKey}:${cycleNumber}:${b.id}`).digest("hex");
    return scoreA.localeCompare(scoreB);
  });
  const start = dayInCycle * 3;
  return [0, 1, 2].map((offset) => shuffled[(start + offset) % shuffled.length]);
}

router.get("/", (req, res) => {
  const today = dayjs().format("YYYY-MM-DD");
  const nextSevenDays = dayjs().add(7, "day").format("YYYY-MM-DD");
  const calendarEvents = db
    .prepare(
      `SELECT ce.id, ce.title, ce.details, ce.event_date, ce.created_at
       FROM calendar_events ce
       WHERE ce.is_deleted = 0 AND ce.event_date >= ?`
    )
    .all(today)
    .map((row) => ({ ...row, sort_time: row.created_at || `${row.event_date} 00:00:00` }));

  const deviceBookingEvents = db
    .prepare(
      `SELECT b.id, b.booking_date, b.planned_start_time, b.class_name, b.subject, b.lesson_topic, b.venue, d.name AS device_name, d.code AS device_code
       FROM device_bookings b
       JOIN devices d ON d.id = b.device_id
       WHERE b.status <> 'cancelled' AND b.booking_date >= ?`
    )
    .all(today)
    .map((row) => ({
      id: `device-booking-${row.id}`,
      title: `${row.device_name} (${row.device_code}) - ${row.class_name}`,
      details: `Device booking for ${row.subject} at ${row.venue} (${row.planned_start_time})${row.lesson_topic ? ` | ${row.lesson_topic}` : ""}`,
      event_date: row.booking_date,
      sort_time: `${row.booking_date} ${row.planned_start_time || "00:00"}:00`
    }));

  const allUpcomingEvents = [...calendarEvents, ...deviceBookingEvents]
    .sort((a, b) => {
      if (a.event_date < b.event_date) return -1;
      if (a.event_date > b.event_date) return 1;
      if (a.sort_time < b.sort_time) return -1;
      if (a.sort_time > b.sort_time) return 1;
      return String(a.title).localeCompare(String(b.title));
    });
  const events = allUpcomingEvents.slice(0, 5);

  const totalStudents = Number(db.prepare("SELECT COUNT(*) AS total FROM students").get().total || 0);
  const sipPitisDashboard = buildSipPitisDashboard({});
  const currentUser = req.session.user || null;
  const showTeacherProgressWelcome = Boolean(
    req.session.showTeacherProgressWelcome
    && currentUser
    && String(currentUser.role || "").toLowerCase() === "teacher"
    && String(currentUser.userType || "").toLowerCase() === "teacher"
  );
  let teacherProgressWelcome = null;

  if (showTeacherProgressWelcome) {
    const progressDashboard = buildSipPitisDashboard({ includeAllTeachers: true });
    const currentWeekKey = progressDashboard.currentWeek ? progressDashboard.currentWeek.weekKey : "";
    const sortedTeachers = progressDashboard.allTeacherReports
      .map((teacher) => {
        const week = teacher.weeks.find((item) => item.weekKey === currentWeekKey) || null;
        return {
          id: Number(teacher.id),
          displayName: teacher.display_name || teacher.username || "Teacher",
          activeDays: week ? Number(week.activeDays || 0) : 0,
          requiredDays: week ? Number(week.requiredDays || 0) : 0,
          availableSchoolDays: week ? Number(week.availableSchoolDays || 0) : 0,
          percentage: week ? Number(week.achievementRate || 0) : 0,
          status: week ? String(week.status || "") : "Outside Term",
          days: week ? week.days.map((day) => ({
            date: day.date,
            label: day.label,
            shortLabel: day.shortLabel,
            type: day.type,
            counted: Boolean(day.counted),
            isFuture: Boolean(day.isFuture),
            isToday: day.date === today,
            exclusionReason: day.exclusionReason || "",
            dailyStatus: day.dailyStatus || ""
          })) : []
        };
      })
      .sort((a, b) => (
        b.percentage - a.percentage
        || b.activeDays - a.activeDays
        || a.displayName.localeCompare(b.displayName)
      ))
      .map((teacher, index) => ({ ...teacher, rank: index + 1 }));
    const loggedInTeacher = sortedTeachers.find((teacher) => teacher.id === Number(currentUser.id)) || null;

    teacherProgressWelcome = {
      term: Number(progressDashboard.currentTerm || progressDashboard.filters.term || 1),
      weekNumber: progressDashboard.currentWeek ? Number(progressDashboard.currentWeek.weekNumber || 0) : null,
      weekRange: progressDashboard.currentWeek ? progressDashboard.currentWeek.rangeLabel : "Outside the school term",
      teachers: sortedTeachers,
      currentTeacher: loggedInTeacher
    };
    delete req.session.showTeacherProgressWelcome;
  }
  const attendanceToday = db.prepare(
    `SELECT COUNT(DISTINCT CASE WHEN ar.is_present = 1 THEN ar.student_id END) AS present
     FROM attendance_sessions ats
     JOIN attendance_records ar ON ar.session_id = ats.id
     WHERE ats.attendance_date = ?`
  ).get(today);
  const studentsPresentToday = Number((attendanceToday && attendanceToday.present) || 0);
  const attendancePercentage = totalStudents > 0
    ? Math.round((studentsPresentToday / totalStudents) * 1000) / 10
    : 0;
  const upcomingSevenDayEvents = allUpcomingEvents.filter(
    (event) => event.event_date >= today && event.event_date <= nextSevenDays
  ).length;

  res.render("home", {
    events,
    dashboard: {
      totalStudents,
      studentsPresentToday,
      attendancePercentage,
      upcomingSevenDayEvents
    },
    sipPitisKpis: sipPitisDashboard.kpis,
    teacherProgressWelcome
  });
});

router.get("/downloads/school-portal-root-ca.crt", (req, res) => {
  if (!serverConfig.sslCaPath || !fs.existsSync(serverConfig.sslCaPath)) {
    return res.status(404).send("Certificate file not available");
  }

  res.setHeader("Content-Type", "application/x-x509-ca-cert");
  return res.download(serverConfig.sslCaPath, "school-portal-root-ca.crt");
});

router.get("/security/certificate", (req, res) => {
  res.render("security-certificate", {
    caDownloadPath: "/downloads/school-portal-root-ca.crt",
    httpsUrl: (res.locals.securitySetup && res.locals.securitySetup.httpsUrl) || ""
  });
});

router.get("/qr-quiz/:token", (req, res) => {
  const quiz = getQrQuizByToken(req.params.token);
  if (!quiz) return res.status(404).send("QR Quiz not found");
  const options = getQrQuizStudentOptions(quiz);
  res.render("qr-quiz-student", {
    quiz,
    classes: options.classes,
    students: options.students,
    result: null,
    error: req.query.error || null
  });
});

router.get("/qr-quiz/:token/result/:studentId", (req, res) => {
  const quiz = getQrQuizByToken(req.params.token);
  if (!quiz) return res.status(404).send("QR Quiz not found");
  const studentId = Number(req.params.studentId || 0);
  const result = getQrQuizResult(quiz.id, studentId);
  if (!result) return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}`);
  res.render("qr-quiz-result", { quiz, result });
});

router.post("/qr-quiz/:token/submit", (req, res) => {
  const quiz = getQrQuizByToken(req.params.token);
  if (!quiz) return res.status(404).send("QR Quiz not found");
  if (quiz.status !== "active") {
    return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}?error=${encodeURIComponent("This quiz is not active")}`);
  }

  const studentId = Number(req.body.student_id || 0);
  if (!studentId) {
    return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}?error=${encodeURIComponent("Select your name before submitting")}`);
  }

  const student = db.prepare(`
    SELECT s.id, s.class_id, s.full_name, c.name AS class_name
    FROM students s
    JOIN classes c ON c.id = s.class_id
    WHERE s.id = ?
  `).get(studentId);

  if (!student) {
    return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}?error=${encodeURIComponent("Student not found")}`);
  }

  if (!studentMatchesQrQuizTarget(quiz, student)) {
    return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}?error=${encodeURIComponent("This quiz is for another class")}`);
  }

  const existing = getQrQuizResult(quiz.id, student.id);
  if (existing) {
    return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}/result/${student.id}`);
  }

  const answerRows = db.prepare("SELECT id, correct_answer FROM qr_quiz_questions WHERE quiz_id = ? ORDER BY position ASC").all(quiz.id);
  if (!answerRows.length) {
    return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}?error=${encodeURIComponent("This quiz has no questions")}`);
  }

  let answers;
  try {
    answers = answerRows.map((question) => {
      const selected = normalizeQrAnswer(req.body[`answer_${question.id}`]);
      if (!selected) {
        throw new Error("Answer every question before submitting");
      }
      return {
        questionId: Number(question.id),
        selected,
        isCorrect: selected === question.correct_answer ? 1 : 0
      };
    });
  } catch (error) {
    return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}?error=${encodeURIComponent(error.message || "Answer every question before submitting")}`);
  }

  const score = answers.reduce((sum, answer) => sum + Number(answer.isCorrect || 0), 0);
  const pointsPerCorrect = Number(quiz.award_enabled) === 1 ? Number(quiz.points_per_correct || 0) : 0;
  const pitisAwarded = pointsPerCorrect > 0 ? score * pointsPerCorrect : 0;
  const now = dayjs().toISOString();
  const actorUserId = Number(quiz.created_by || getKioskSystemUserId());

  try {
    const tx = db.transaction(() => {
      const responseInfo = db.prepare(`
        INSERT INTO qr_quiz_responses
          (quiz_id, student_id, class_id, score, total_questions, pitis_awarded, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(quiz.id, student.id, student.class_id, score, answerRows.length, pitisAwarded, now);

      const responseId = Number(responseInfo.lastInsertRowid);
      const insertAnswer = db.prepare(`
        INSERT INTO qr_quiz_response_answers (response_id, question_id, selected_answer, is_correct)
        VALUES (?, ?, ?, ?)
      `);
      answers.forEach((answer) => {
        insertAnswer.run(responseId, answer.questionId, answer.selected, answer.isCorrect);
      });

      if (pitisAwarded > 0) {
        db.prepare(`
          INSERT INTO point_logs (student_id, class_id, points, reason, awarded_by, awarded_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(student.id, student.class_id, pitisAwarded, `QR Quiz: ${quiz.title}`, actorUserId, now);
        updateDailySnapshot(student.id);
      }
    });

    tx();
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}/result/${student.id}`);
    }
    return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}?error=${encodeURIComponent(error.message || "Unable to submit quiz")}`);
  }

  return res.redirect(`/qr-quiz/${encodeURIComponent(req.params.token)}/result/${student.id}`);
});

function getKioskSystemUserId() {
  const adminUser = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
  if (adminUser && adminUser.id) return Number(adminUser.id);
  const anyUser = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get();
  return anyUser && anyUser.id ? Number(anyUser.id) : 1;
}

function getKioskSessionType(now) {
  return now.format("HH:mm") < "12:00" ? "morning" : "afternoon";
}

function getMatchingKioskRewardRule(logTime) {
  return db.prepare(`
    SELECT id, label, start_time, end_time, points
    FROM kiosk_reward_rules
    WHERE COALESCE(is_active, 1) = 1
      AND start_time <= ?
      AND end_time >= ?
    ORDER BY start_time ASC, end_time ASC, id ASC
    LIMIT 1
  `).get(logTime, logTime) || null;
}

function getStudentTotalPoints(studentId) {
  return Number(db.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM point_logs WHERE student_id = ?").get(studentId).total || 0);
}

function getQrQuizByToken(token) {
  const quiz = db.prepare(`
    SELECT q.*, c.name AS class_name
    FROM qr_quizzes q
    LEFT JOIN classes c ON c.id = q.target_class_id
    WHERE q.access_token = ? AND q.status <> 'archived'
  `).get(String(token || "").trim());
  if (!quiz) return null;
  quiz.questions = db.prepare(`
    SELECT id, position, question_text, option_a, option_b, option_c
    FROM qr_quiz_questions
    WHERE quiz_id = ?
    ORDER BY position ASC
  `).all(quiz.id);
  quiz.targetClasses = db.prepare(`
    SELECT COALESCE(c.id, qtc.class_id) AS id, qtc.class_name AS name
    FROM qr_quiz_target_classes qtc
    LEFT JOIN classes c ON c.name = qtc.class_name
    WHERE qtc.quiz_id = ?
    ORDER BY qtc.class_name ASC
  `).all(quiz.id);
  if (!quiz.targetClasses.length && quiz.class_name) {
    quiz.targetClasses = [{ id: quiz.target_class_id, name: quiz.class_name }];
  }
  quiz.target_class_names = quiz.targetClasses.map((cls) => cls.name).join(", ") || quiz.class_name || "";
  return quiz;
}

function getQrQuizStudentOptions(quiz) {
  const classes = quiz.target_type === "class" && quiz.targetClasses.length
    ? quiz.targetClasses
    : db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  if (quiz.target_type === "class") {
    const targetClassNames = classes.map((cls) => String(cls.name || "").trim()).filter(Boolean);
    if (!targetClassNames.length) return { classes, students: [] };
    const placeholders = targetClassNames.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT s.id, s.class_id, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, c.name AS class_name
      FROM students s
      JOIN classes c ON c.id = s.class_id
      WHERE c.name IN (${placeholders})
      ORDER BY c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC, s.full_name ASC
    `).all(...targetClassNames);
    return { classes, students: rows };
  }

  const rows = db.prepare(`
    SELECT s.id, s.class_id, s.full_name, COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, c.name AS class_name
    FROM students s
    JOIN classes c ON c.id = s.class_id
    ORDER BY c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC, s.full_name ASC
  `).all();
  return {
    classes,
    students: rows
  };
}

function studentMatchesQrQuizTarget(quiz, student) {
  if (!quiz || quiz.target_type !== "class") return true;
  const names = (quiz.targetClasses || []).map((cls) => String(cls.name || "").trim()).filter(Boolean);
  if (names.length && student.class_name) {
    return names.includes(String(student.class_name || "").trim());
  }
  const ids = (quiz.targetClasses || []).map((cls) => Number(cls.id)).filter(Boolean);
  return ids.includes(Number(student.class_id));
}

function getQrQuizResult(quizId, studentId) {
  return db.prepare(`
    SELECT r.*, q.title, q.award_enabled, q.points_per_correct, s.full_name,
           COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname, c.name AS class_name
    FROM qr_quiz_responses r
    JOIN qr_quizzes q ON q.id = r.quiz_id
    JOIN students s ON s.id = r.student_id
    JOIN classes c ON c.id = r.class_id
    WHERE r.quiz_id = ? AND r.student_id = ?
  `).get(quizId, studentId);
}

function normalizeQrAnswer(value) {
  const answer = String(value || "").trim().toUpperCase();
  return ["A", "B", "C"].includes(answer) ? answer : "";
}

function syncKioskAttendance(student, attendanceDate, sessionType, actorUserId, actorLabel, timestamp) {
  const findSession = db.prepare("SELECT id FROM attendance_sessions WHERE class_id = ? AND attendance_date = ? AND session_type = ?");
  const insertSession = db.prepare("INSERT INTO attendance_sessions (class_id, attendance_date, session_type, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?)");
  const updateSession = db.prepare("UPDATE attendance_sessions SET recorded_by = ?, recorded_at = ? WHERE id = ?");
  const findRecord = db.prepare("SELECT id FROM attendance_records WHERE session_id = ? AND student_id = ?");
  const insertRecord = db.prepare("INSERT INTO attendance_records (session_id, student_id, is_present, absence_reason) VALUES (?, ?, 1, NULL)");
  const updateRecord = db.prepare("UPDATE attendance_records SET is_present = 1, absence_reason = NULL WHERE id = ?");
  const insertLog = db.prepare(`
    INSERT INTO attendance_logs (class_id, attendance_date, action_type, actor_user_id, actor_label, details, created_at)
    VALUES (?, ?, 'save', ?, ?, ?, ?)
  `);

  let sessionId;
  const existingSession = findSession.get(student.class_id, attendanceDate, sessionType);
  if (existingSession && existingSession.id) {
    sessionId = Number(existingSession.id);
    updateSession.run(actorUserId, timestamp, sessionId);
  } else {
    sessionId = Number(insertSession.run(student.class_id, attendanceDate, sessionType, actorUserId, timestamp).lastInsertRowid);
  }

  const existingRecord = findRecord.get(sessionId, student.id);
  if (existingRecord && existingRecord.id) {
    updateRecord.run(existingRecord.id);
  } else {
    insertRecord.run(sessionId, student.id);
  }

  insertLog.run(student.class_id, attendanceDate, actorUserId, actorLabel, `${student.full_name} marked present by kiosk for ${sessionType}.`, timestamp);
}

router.get("/kiosk", (req, res) => {
  res.render("kiosk", {
    error: req.query.error || null,
    success: req.query.success || null
  });
});

router.get("/leaderboard", (req, res) => {
  const weekStart = dayjs().subtract((dayjs().day() + 6) % 7, "day").format("YYYY-MM-DD");
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();
  const schoolRows = addPitisTiers(db.prepare(schoolLeaderboardQuery).all(weekStart));
  const schoolTop10 = schoolRows.slice(0, 10);
  const schoolSpotlightRows = selectDailyFairSpotlights(schoolRows, "whole-school");

  res.render("leaderboard-classes", {
    classes,
    schoolTop10,
    schoolRows,
    schoolSpotlightRows,
    slideshowDurationMs: getLeaderboardSlideshowDurationMs(),
    slideshowMode: getLeaderboardSlideshowMode(),
    slideshowStudentCount: getLeaderboardSlideshowStudentCount()
  });
});

router.get("/leaderboard/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!cls) return res.status(404).send("Class not found");
  const classes = db.prepare("SELECT id, name FROM classes ORDER BY name").all();

  const weekStart = dayjs().subtract((dayjs().day() + 6) % 7, "day").format("YYYY-MM-DD");
  const rows = addPitisTiers(db.prepare(leaderboardQuery).all(weekStart, weekStart, weekStart, weekStart, weekStart, classId));
  const spotlightRows = selectDailyFairSpotlights(rows, `class-${classId}`);

  res.render("leaderboard", {
    cls,
    classes,
    rows,
    spotlightRows,
    generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    slideshowDurationMs: getLeaderboardSlideshowDurationMs(),
    slideshowMode: getLeaderboardSlideshowMode(),
    slideshowStudentCount: getLeaderboardSlideshowStudentCount()
  });
});

router.get("/api/leaderboard/:classId", (req, res) => {
  const classId = Number(req.params.classId);
  const weekStart = dayjs().subtract((dayjs().day() + 6) % 7, "day").format("YYYY-MM-DD");
  const rows = addPitisTiers(db.prepare(leaderboardQuery).all(weekStart, weekStart, weekStart, weekStart, weekStart, classId));
  const spotlightRows = selectDailyFairSpotlights(rows, `class-${classId}`);

  res.json({ rows, spotlightRows, timestamp: dayjs().toISOString() });
});

router.post("/api/kiosk/scan", (req, res) => {
  try {
    const qrText = String(req.body.qr_text || "").trim();
    if (!qrText) {
      return res.status(400).json({ success: false, error: "QR text is required" });
    }

    const parsed = parseStudentQrPayload(qrText);
    const student = db.prepare(`
      SELECT s.id, s.student_id, s.qr_token, s.full_name, s.class_id, c.name AS class_name
      FROM students s
      JOIN classes c ON c.id = s.class_id
      WHERE s.id = ? AND s.student_id = ? AND s.qr_token = ?
    `).get(parsed.student_pk, parsed.student_id, parsed.qr_token);

    if (!student) {
      return res.status(404).json({ success: false, error: "Student not found for this QR code" });
    }

    const now = dayjs();
    const attendanceDate = now.format("YYYY-MM-DD");
    const logTime = now.format("HH:mm");
    const scannedAt = now.toISOString();
    const sessionType = getKioskSessionType(now);
    const actorUserId = getKioskSystemUserId();
    const actorLabel = "Kiosk Scanner";

    const existingScan = db.prepare(`
      SELECT id, scanned_at, points_awarded, total_points_after
      FROM kiosk_scan_logs
      WHERE student_id = ? AND attendance_date = ? AND session_type = ?
    `).get(student.id, attendanceDate, sessionType);

    if (existingScan) {
      return res.status(409).json({
        success: false,
        error: `${student.full_name} has already logged attendance for ${sessionType} today.`,
        studentName: student.full_name,
        className: student.class_name,
        sessionType,
        scanTime: logTime,
        totalPoints: getStudentTotalPoints(student.id)
      });
    }

    const rewardRule = getMatchingKioskRewardRule(logTime);
    const pointsAwarded = rewardRule ? Number(rewardRule.points || 0) : 0;

    const tx = db.transaction(() => {
      syncKioskAttendance(student, attendanceDate, sessionType, actorUserId, actorLabel, scannedAt);
      if (pointsAwarded !== 0) {
        db.prepare(`
          INSERT INTO point_logs (student_id, class_id, points, reason, awarded_by, awarded_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          student.id,
          student.class_id,
          pointsAwarded,
          `Kiosk attendance: ${rewardRule ? rewardRule.label : sessionType}`,
          actorUserId,
          scannedAt
        );
        updateDailySnapshot(student.id);
      }
      const totalPointsAfter = getStudentTotalPoints(student.id);
      db.prepare(`
        INSERT INTO kiosk_scan_logs
          (student_id, class_id, attendance_date, session_type, scanned_at, log_time, rule_label, points_awarded, total_points_after, qr_payload, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success')
      `).run(
        student.id,
        student.class_id,
        attendanceDate,
        sessionType,
        scannedAt,
        logTime,
        rewardRule ? rewardRule.label : null,
        pointsAwarded,
        totalPointsAfter,
        qrText
      );
      return totalPointsAfter;
    });

    const totalPoints = tx();

    return res.json({
      success: true,
      studentName: student.full_name,
      className: student.class_name,
      sessionType,
      scanTime: logTime,
      pointsAwarded,
      totalPoints,
      ruleLabel: rewardRule ? rewardRule.label : "No matching reward rule"
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Unable to process kiosk scan" });
  }
});

module.exports = router;
