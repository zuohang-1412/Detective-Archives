import type { DatabaseClient } from "../db/types.js";
import { queryRows } from "../db/types.js";

interface ProductAnalyticsRow {
  periodStart: string;
  periodEnd: string;
  archiveListVisitors: number;
  archiveDetailVisitors: number;
  archiveDetailRate: number;
  workDetailVisitors: number;
  officialLinkVisitors: number;
  officialLinkRate: number;
  newUsers: number;
  firstShelfUsers: number;
  firstShelfRate: number;
  completedWorks: number;
  completedWithReview: number;
  completedReviewRate: number;
  day7Eligible: number;
  day7Retained: number;
  day7RetentionRate: number;
  day30Eligible: number;
  day30Retained: number;
  day30RetentionRate: number;
  publishedComments: number;
  reportedComments: number;
  commentReportRate: number;
  moderationDecisions: number;
  averageModerationHours: number | null;
  handledAppeals: number;
  approvedAppeals: number;
  appealRecoveryRate: number;
}

export async function getProductAnalytics(database: DatabaseClient, periodDays: number) {
  const result = await queryRows<ProductAnalyticsRow>(database, `
    WITH period AS (
      SELECT NOW() - make_interval(days => $1::int) AS period_start, NOW() AS period_end
    ),
    archive_list_visitors AS (
      SELECT DISTINCT event.visitor_hash
      FROM catalog_view_events event, period
      WHERE event.event_type = 'DETECTIVE_LIST_VIEW'
        AND event.created_at >= period.period_start
        AND event.created_at < period.period_end
    ),
    archive_detail_visitors AS (
      SELECT DISTINCT event.visitor_hash
      FROM catalog_view_events event
      CROSS JOIN period
      WHERE event.event_type = 'DETECTIVE_DETAIL_VIEW'
        AND event.created_at >= period.period_start
        AND event.created_at < period.period_end
        AND EXISTS (
          SELECT 1 FROM catalog_view_events listed
          WHERE listed.visitor_hash = event.visitor_hash
            AND listed.event_type = 'DETECTIVE_LIST_VIEW'
            AND listed.created_at >= period.period_start
            AND listed.created_at <= event.created_at
        )
    ),
    work_detail_visitors AS (
      SELECT DISTINCT event.visitor_hash
      FROM catalog_view_events event, period
      WHERE event.event_type = 'WORK_DETAIL_VIEW'
        AND event.created_at >= period.period_start
        AND event.created_at < period.period_end
    ),
    official_link_visitors AS (
      SELECT DISTINCT click.visitor_hash
      FROM work_link_click_events click
      JOIN work_links link ON link.id = click.work_link_id
      CROSS JOIN period
      WHERE click.created_at >= period.period_start
        AND click.created_at < period.period_end
        AND click.visitor_hash IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM catalog_view_events viewed
          WHERE viewed.visitor_hash = click.visitor_hash
            AND viewed.event_type = 'WORK_DETAIL_VIEW'
            AND viewed.target_id = link.work_id
            AND viewed.created_at >= period.period_start
            AND viewed.created_at <= click.created_at
        )
    ),
    new_user_cohort AS (
      SELECT account.id, account.created_at
      FROM users account, period
      WHERE account.role = 'USER'
        AND account.created_at >= period.period_start
        AND account.created_at < period.period_end - INTERVAL '7 days'
    ),
    first_shelf AS (
      SELECT cohort.id, MIN(shelf.first_added_at) AS first_shelf_at
      FROM new_user_cohort cohort
      LEFT JOIN shelf_engagement_facts shelf ON shelf.user_id = cohort.id
      GROUP BY cohort.id
    ),
    completed_works AS (
      SELECT shelf.user_id, shelf.work_id, shelf.first_completed_at AS completed_at
      FROM shelf_engagement_facts shelf, period
      WHERE shelf.first_completed_at >= period.period_start
        AND shelf.first_completed_at < period.period_end
    ),
    retention_cohort AS (
      SELECT account.id, (account.created_at AT TIME ZONE 'UTC')::date AS joined_date
      FROM users account, period
      WHERE account.role = 'USER'
        AND account.created_at >= period.period_start
        AND account.created_at < period.period_end
    ),
    published_comments AS (
      SELECT comment.id
      FROM comments comment, period
      WHERE comment.published_at IS NOT NULL
        AND comment.created_at >= period.period_start
        AND comment.created_at < period.period_end
    ),
    first_moderation_decisions AS (
      SELECT content.created_at, MIN(record.created_at) AS decided_at
      FROM (
        SELECT id, 'REVIEW'::text AS target_type, created_at FROM reviews
        UNION ALL
        SELECT id, 'COMMENT'::text AS target_type, created_at FROM comments
      ) content
      JOIN moderation_records record
        ON record.target_type = content.target_type
        AND record.target_id = content.id
        AND record.action IN ('PUBLISH', 'REJECT')
      CROSS JOIN period
      WHERE content.created_at >= period.period_start
        AND content.created_at < period.period_end
      GROUP BY content.id, content.target_type, content.created_at
    )
    SELECT
      period.period_start AS "periodStart",
      period.period_end AS "periodEnd",
      (SELECT COUNT(*)::int FROM archive_list_visitors) AS "archiveListVisitors",
      (SELECT COUNT(*)::int FROM archive_detail_visitors) AS "archiveDetailVisitors",
      COALESCE(ROUND(
        100.0 * (SELECT COUNT(*) FROM archive_detail_visitors)
        / NULLIF((SELECT COUNT(*) FROM archive_list_visitors), 0), 2
      ), 0)::float AS "archiveDetailRate",
      (SELECT COUNT(*)::int FROM work_detail_visitors) AS "workDetailVisitors",
      (SELECT COUNT(*)::int FROM official_link_visitors) AS "officialLinkVisitors",
      COALESCE(ROUND(
        100.0 * (SELECT COUNT(*) FROM official_link_visitors)
        / NULLIF((SELECT COUNT(*) FROM work_detail_visitors), 0), 2
      ), 0)::float AS "officialLinkRate",
      (SELECT COUNT(*)::int FROM new_user_cohort) AS "newUsers",
      (SELECT COUNT(*)::int
        FROM first_shelf shelf
        JOIN new_user_cohort cohort ON cohort.id = shelf.id
        WHERE shelf.first_shelf_at <= cohort.created_at + INTERVAL '7 days'
      ) AS "firstShelfUsers",
      COALESCE(ROUND(
        100.0 * (SELECT COUNT(*)
          FROM first_shelf shelf
          JOIN new_user_cohort cohort ON cohort.id = shelf.id
          WHERE shelf.first_shelf_at <= cohort.created_at + INTERVAL '7 days'
        ) / NULLIF((SELECT COUNT(*) FROM new_user_cohort), 0), 2
      ), 0)::float AS "firstShelfRate",
      (SELECT COUNT(*)::int FROM completed_works) AS "completedWorks",
      (SELECT COUNT(*)::int
        FROM completed_works completed
        WHERE EXISTS (
          SELECT 1 FROM reviews review
          WHERE review.user_id = completed.user_id
            AND review.work_id = completed.work_id
            AND review.created_at >= completed.completed_at
            AND review.deleted_at IS NULL
        )
      ) AS "completedWithReview",
      COALESCE(ROUND(
        100.0 * (SELECT COUNT(*)
          FROM completed_works completed
          WHERE EXISTS (
            SELECT 1 FROM reviews review
            WHERE review.user_id = completed.user_id
              AND review.work_id = completed.work_id
              AND review.created_at >= completed.completed_at
              AND review.deleted_at IS NULL
          )
        ) / NULLIF((SELECT COUNT(*) FROM completed_works), 0), 2
      ), 0)::float AS "completedReviewRate",
      (SELECT COUNT(*)::int FROM retention_cohort cohort
        WHERE cohort.joined_date <= (NOW() AT TIME ZONE 'UTC')::date - 7
      ) AS "day7Eligible",
      (SELECT COUNT(*)::int FROM retention_cohort cohort
        WHERE cohort.joined_date <= (NOW() AT TIME ZONE 'UTC')::date - 7
          AND EXISTS (
            SELECT 1 FROM user_activity_days activity
            WHERE activity.user_id = cohort.id
              AND activity.activity_date = cohort.joined_date + 7
          )
      ) AS "day7Retained",
      COALESCE(ROUND(
        100.0 * (SELECT COUNT(*) FROM retention_cohort cohort
          WHERE cohort.joined_date <= (NOW() AT TIME ZONE 'UTC')::date - 7
            AND EXISTS (
              SELECT 1 FROM user_activity_days activity
              WHERE activity.user_id = cohort.id
                AND activity.activity_date = cohort.joined_date + 7
            )
        ) / NULLIF((SELECT COUNT(*) FROM retention_cohort cohort
          WHERE cohort.joined_date <= (NOW() AT TIME ZONE 'UTC')::date - 7
        ), 0), 2
      ), 0)::float AS "day7RetentionRate",
      (SELECT COUNT(*)::int FROM retention_cohort cohort
        WHERE cohort.joined_date <= (NOW() AT TIME ZONE 'UTC')::date - 30
      ) AS "day30Eligible",
      (SELECT COUNT(*)::int FROM retention_cohort cohort
        WHERE cohort.joined_date <= (NOW() AT TIME ZONE 'UTC')::date - 30
          AND EXISTS (
            SELECT 1 FROM user_activity_days activity
            WHERE activity.user_id = cohort.id
              AND activity.activity_date = cohort.joined_date + 30
          )
      ) AS "day30Retained",
      COALESCE(ROUND(
        100.0 * (SELECT COUNT(*) FROM retention_cohort cohort
          WHERE cohort.joined_date <= (NOW() AT TIME ZONE 'UTC')::date - 30
            AND EXISTS (
              SELECT 1 FROM user_activity_days activity
              WHERE activity.user_id = cohort.id
                AND activity.activity_date = cohort.joined_date + 30
            )
        ) / NULLIF((SELECT COUNT(*) FROM retention_cohort cohort
          WHERE cohort.joined_date <= (NOW() AT TIME ZONE 'UTC')::date - 30
        ), 0), 2
      ), 0)::float AS "day30RetentionRate",
      (SELECT COUNT(*)::int FROM published_comments) AS "publishedComments",
      (SELECT COUNT(DISTINCT report.target_id)::int
        FROM reports report
        JOIN published_comments comment ON comment.id = report.target_id
        WHERE report.target_type = 'COMMENT'
      ) AS "reportedComments",
      COALESCE(ROUND(
        100.0 * (SELECT COUNT(DISTINCT report.target_id)
          FROM reports report
          JOIN published_comments comment ON comment.id = report.target_id
          WHERE report.target_type = 'COMMENT'
        ) / NULLIF((SELECT COUNT(*) FROM published_comments), 0), 2
      ), 0)::float AS "commentReportRate",
      (SELECT COUNT(*)::int FROM first_moderation_decisions) AS "moderationDecisions",
      (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (decided_at - created_at)) / 3600.0)::numeric, 2)::float
        FROM first_moderation_decisions
      ) AS "averageModerationHours",
      (SELECT COUNT(*)::int FROM content_appeals appeal
        WHERE appeal.status IN ('APPROVED', 'REJECTED')
          AND appeal.handled_at >= period.period_start
          AND appeal.handled_at < period.period_end
      ) AS "handledAppeals",
      (SELECT COUNT(*)::int FROM content_appeals appeal
        WHERE appeal.status = 'APPROVED'
          AND appeal.handled_at >= period.period_start
          AND appeal.handled_at < period.period_end
      ) AS "approvedAppeals",
      COALESCE(ROUND(
        100.0 * (SELECT COUNT(*) FROM content_appeals appeal
          WHERE appeal.status = 'APPROVED'
            AND appeal.handled_at >= period.period_start
            AND appeal.handled_at < period.period_end
        ) / NULLIF((SELECT COUNT(*) FROM content_appeals appeal
          WHERE appeal.status IN ('APPROVED', 'REJECTED')
            AND appeal.handled_at >= period.period_start
            AND appeal.handled_at < period.period_end
        ), 0), 2
      ), 0)::float AS "appealRecoveryRate"
    FROM period
  `, [periodDays]);

  const row = result.rows[0];
  if (!row) throw new Error("Product analytics query returned no row");
  return {
    periodDays,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    archiveDetail: {
      listVisitors: row.archiveListVisitors,
      detailVisitors: row.archiveDetailVisitors,
      rate: row.archiveDetailRate
    },
    officialLink: {
      detailVisitors: row.workDetailVisitors,
      clickVisitors: row.officialLinkVisitors,
      rate: row.officialLinkRate
    },
    firstShelf: {
      newUsers: row.newUsers,
      convertedUsers: row.firstShelfUsers,
      rate: row.firstShelfRate
    },
    completedReview: {
      completedWorks: row.completedWorks,
      reviewedWorks: row.completedWithReview,
      rate: row.completedReviewRate
    },
    retention: {
      day7: {
        eligibleUsers: row.day7Eligible,
        retainedUsers: row.day7Retained,
        rate: row.day7RetentionRate
      },
      day30: {
        eligibleUsers: row.day30Eligible,
        retainedUsers: row.day30Retained,
        rate: row.day30RetentionRate
      }
    },
    communityModeration: {
      publishedComments: row.publishedComments,
      reportedComments: row.reportedComments,
      commentReportRate: row.commentReportRate,
      moderationDecisions: row.moderationDecisions,
      averageModerationHours: row.averageModerationHours,
      handledAppeals: row.handledAppeals,
      approvedAppeals: row.approvedAppeals,
      appealRecoveryRate: row.appealRecoveryRate
    }
  };
}
