import type { DatabasePool } from "./pool.js";

export interface AuthenticationRateLimitBucket {
  limit: number;
  scope: string;
  subjectDigest: string;
}

export interface AuthenticationRateLimitDecision {
  allowed: boolean;
  exceededScopes: string[];
  retryAfterSeconds: number;
}

interface RateLimitDatabaseRow {
  attempts: number;
  retry_after_seconds: number;
}

export async function consumeAuthenticationRateLimit(
  pool: DatabasePool,
  buckets: readonly AuthenticationRateLimitBucket[],
  windowSeconds: number,
): Promise<AuthenticationRateLimitDecision> {
  if (
    buckets.length === 0 ||
    !Number.isInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > 86_400
  ) {
    throw new Error("Authentication rate limit configuration is invalid");
  }
  const client = await pool.connect();
  const exceededScopes: string[] = [];
  let retryAfterSeconds = 1;
  try {
    await client.query("BEGIN");
    for (const bucket of buckets) {
      if (
        !Number.isInteger(bucket.limit) ||
        bucket.limit < 1 ||
        !/^[a-z][a-z0-9_.-]{1,63}$/u.test(bucket.scope) ||
        !/^[a-f0-9]{64}$/u.test(bucket.subjectDigest)
      ) {
        throw new Error("Authentication rate limit bucket is invalid");
      }
      const consumed = await client.query<RateLimitDatabaseRow>(
        `
          INSERT INTO authentication_rate_limits (
            scope,
            subject_digest,
            window_started_at,
            attempts
          )
          VALUES ($1, $2, statement_timestamp(), 1)
          ON CONFLICT (scope, subject_digest) DO UPDATE
          SET attempts = CASE
                WHEN authentication_rate_limits.window_started_at
                     <= statement_timestamp() - ($3 * interval '1 second')
                  THEN 1
                ELSE authentication_rate_limits.attempts + 1
              END,
              window_started_at = CASE
                WHEN authentication_rate_limits.window_started_at
                     <= statement_timestamp() - ($3 * interval '1 second')
                  THEN statement_timestamp()
                ELSE authentication_rate_limits.window_started_at
              END
          RETURNING attempts,
                    GREATEST(
                      1,
                      CEIL(EXTRACT(EPOCH FROM (
                        window_started_at + ($3 * interval '1 second') - statement_timestamp()
                      )))::integer
                    ) AS retry_after_seconds
        `,
        [bucket.scope, bucket.subjectDigest, windowSeconds],
      );
      const row = consumed.rows[0];
      if (!row) {
        throw new Error("Authentication rate limit did not return a decision");
      }
      if (row.attempts > bucket.limit) {
        exceededScopes.push(bucket.scope);
        retryAfterSeconds = Math.max(retryAfterSeconds, row.retry_after_seconds);
      }
    }
    await client.query("COMMIT");
    return {
      allowed: exceededScopes.length === 0,
      exceededScopes,
      retryAfterSeconds,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
