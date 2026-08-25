import type { PoolClient } from "pg";

import type { DatabasePool } from "./pool.js";

export interface AuthenticationRateLimitBucket {
  limit: number;
  scope: string;
  subjectDigest: string;
}

export interface AuthenticationRateLimitDecision {
  allowed: boolean;
  exceededScopes: string[];
  newlyExceededScopes: string[];
  retryAfterSeconds: number;
}

interface RateLimitDatabaseRow {
  attempts: number;
  retry_after_seconds: number;
  window_expired: boolean;
}

const MAXIMUM_RATE_LIMIT_WINDOW_SECONDS = 86_400;

function validateBucket(bucket: AuthenticationRateLimitBucket): void {
  if (
    !Number.isInteger(bucket.limit) ||
    bucket.limit < 1 ||
    !/^[a-z][a-z0-9_.-]{1,63}$/u.test(bucket.scope) ||
    !/^[a-f0-9]{64}$/u.test(bucket.subjectDigest)
  ) {
    throw new Error("Authentication rate limit bucket is invalid");
  }
}

async function selectRateLimitBucket(
  client: PoolClient,
  bucket: AuthenticationRateLimitBucket,
  windowSeconds: number,
): Promise<RateLimitDatabaseRow> {
  const selected = await client.query<RateLimitDatabaseRow>(
    `
      SELECT attempts,
             window_started_at <= statement_timestamp() - ($3 * interval '1 second')
               AS window_expired,
             GREATEST(
               1,
               CEIL(EXTRACT(EPOCH FROM (
                 window_started_at + ($3 * interval '1 second') - statement_timestamp()
               )))::integer
             ) AS retry_after_seconds
      FROM authentication_rate_limits
      WHERE scope = $1 AND subject_digest = $2
      FOR UPDATE
    `,
    [bucket.scope, bucket.subjectDigest, windowSeconds],
  );
  const row = selected.rows[0];
  if (selected.rowCount !== 1 || row === undefined) {
    throw new Error("Authentication rate limit bucket disappeared");
  }
  return row;
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
    windowSeconds > MAXIMUM_RATE_LIMIT_WINDOW_SECONDS
  ) {
    throw new Error("Authentication rate limit configuration is invalid");
  }
  for (const bucket of buckets) {
    validateBucket(bucket);
  }
  const client = await pool.connect();
  const exceededScopes: string[] = [];
  const newlyExceededScopes: string[] = [];
  let retryAfterSeconds = 1;
  try {
    await client.query("BEGIN");
    await client.query(
      `
        DELETE FROM authentication_rate_limits
        WHERE window_started_at
              <= statement_timestamp() - ($1 * interval '1 second')
      `,
      [MAXIMUM_RATE_LIMIT_WINDOW_SECONDS],
    );
    for (const bucket of buckets) {
      let newlyExceeded = false;
      const inserted = await client.query<RateLimitDatabaseRow>(
        `
          INSERT INTO authentication_rate_limits (
            scope,
            subject_digest,
            window_started_at,
            attempts
          )
          VALUES ($1, $2, statement_timestamp(), 1)
          ON CONFLICT (scope, subject_digest) DO NOTHING
          RETURNING attempts, false AS window_expired, $3::integer AS retry_after_seconds
        `,
        [bucket.scope, bucket.subjectDigest, windowSeconds],
      );
      let row = inserted.rows[0];
      if (row === undefined) {
        row = await selectRateLimitBucket(client, bucket, windowSeconds);
        if (row.window_expired) {
          const reset = await client.query<RateLimitDatabaseRow>(
            `
              UPDATE authentication_rate_limits
              SET attempts = 1, window_started_at = statement_timestamp()
              WHERE scope = $1 AND subject_digest = $2
              RETURNING attempts, false AS window_expired,
                        $3::integer AS retry_after_seconds
            `,
            [bucket.scope, bucket.subjectDigest, windowSeconds],
          );
          row = reset.rows[0];
        } else if (row.attempts <= bucket.limit) {
          newlyExceeded = row.attempts === bucket.limit;
          const incremented = await client.query<RateLimitDatabaseRow>(
            `
              UPDATE authentication_rate_limits
              SET attempts = LEAST(attempts + 1, $3::integer + 1)
              WHERE scope = $1 AND subject_digest = $2
              RETURNING attempts, false AS window_expired,
                        GREATEST(
                          1,
                          CEIL(EXTRACT(EPOCH FROM (
                            window_started_at + ($4 * interval '1 second')
                            - statement_timestamp()
                          )))::integer
                        ) AS retry_after_seconds
            `,
            [bucket.scope, bucket.subjectDigest, bucket.limit, windowSeconds],
          );
          row = incremented.rows[0];
        }
      }
      if (row === undefined) {
        throw new Error("Authentication rate limit did not return a decision");
      }
      if (row.attempts > bucket.limit) {
        exceededScopes.push(bucket.scope);
        if (newlyExceeded) {
          newlyExceededScopes.push(bucket.scope);
        }
        retryAfterSeconds = Math.max(retryAfterSeconds, row.retry_after_seconds);
        break;
      }
    }
    await client.query("COMMIT");
    return {
      allowed: exceededScopes.length === 0,
      exceededScopes,
      newlyExceededScopes,
      retryAfterSeconds,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
