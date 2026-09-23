const leaderboardQuery = `
  SELECT
    s.id,
    s.class_id,
    c.name AS class_name,
    COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname,
    NULLIF(s.avatar_path, '') AS photo_url,
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
    SELECT student_id, awarded_at, reason
    FROM (
      SELECT student_id, awarded_at, reason,
             ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY awarded_at DESC, id DESC) AS row_number
      FROM point_logs
      WHERE points > 0
    ) ranked_logs
    WHERE row_number = 1
  ) last_log ON last_log.student_id = s.id
  WHERE s.class_id = ?
  GROUP BY s.id, s.class_id, c.name, s.name, s.full_name, s.avatar_path, last_log.awarded_at, last_log.reason
  ORDER BY total_points DESC, c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC
`;

const schoolLeaderboardQuery = `
  SELECT
    s.id,
    s.class_id,
    c.name AS class_name,
    COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname,
    NULLIF(s.avatar_path, '') AS photo_url,
    COALESCE(SUM(pl.points), 0) AS total_points,
    COALESCE(SUM(CASE WHEN pl.points > 0 AND date(pl.awarded_at) >= date(?) THEN pl.points ELSE 0 END), 0) AS weekly_points,
    last_log.awarded_at AS last_awarded_at,
    last_log.reason AS last_reason
  FROM students s
  JOIN classes c ON c.id = s.class_id
  LEFT JOIN point_logs pl ON pl.student_id = s.id
  LEFT JOIN (
    SELECT student_id, awarded_at, reason
    FROM (
      SELECT student_id, awarded_at, reason,
             ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY awarded_at DESC, id DESC) AS row_number
      FROM point_logs
      WHERE points > 0
    ) ranked_logs
    WHERE row_number = 1
  ) last_log ON last_log.student_id = s.id
  GROUP BY s.id, s.class_id, c.name, s.name, s.full_name, s.avatar_path, last_log.awarded_at, last_log.reason
  ORDER BY total_points DESC, c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC
`;

const datedSchoolLeaderboardQuery = `
  SELECT
    s.id,
    s.class_id,
    c.name AS class_name,
    COALESCE(NULLIF(s.name, ''), s.full_name) AS nickname,
    NULLIF(s.avatar_path, '') AS photo_url,
    COALESCE(SUM(CASE WHEN date(pl.awarded_at, '+8 hours') <= date(?) THEN pl.points ELSE 0 END), 0) AS total_points,
    COALESCE(SUM(CASE WHEN pl.points > 0 AND date(pl.awarded_at, '+8 hours') BETWEEN date(?) AND date(?) THEN pl.points ELSE 0 END), 0) AS weekly_points,
    (
      SELECT x.awarded_at FROM point_logs x
      WHERE x.student_id = s.id AND x.points > 0 AND date(x.awarded_at, '+8 hours') <= date(?)
      ORDER BY x.awarded_at DESC, x.id DESC LIMIT 1
    ) AS last_awarded_at,
    (
      SELECT x.reason FROM point_logs x
      WHERE x.student_id = s.id AND x.points > 0 AND date(x.awarded_at, '+8 hours') <= date(?)
      ORDER BY x.awarded_at DESC, x.id DESC LIMIT 1
    ) AS last_reason
  FROM students s
  JOIN classes c ON c.id = s.class_id
  LEFT JOIN point_logs pl ON pl.student_id = s.id
  GROUP BY s.id, s.class_id, c.name, s.name, s.full_name, s.avatar_path
  ORDER BY total_points DESC, c.name ASC, COALESCE(NULLIF(s.name, ''), s.full_name) ASC
`;

module.exports = { leaderboardQuery, schoolLeaderboardQuery, datedSchoolLeaderboardQuery };
