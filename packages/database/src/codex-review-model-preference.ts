import {
  CodexReviewModelPreferenceSchema,
  SelectCodexReviewModelCommandSchema,
  type CodexReviewModelPreference,
} from "@kestrel/contracts";

import type { DatabasePool } from "./pool.js";

interface CodexReviewModelPreferenceRow {
  selected_model_id: string | null;
  updated_at: Date | null;
}

function mapPreference(row: CodexReviewModelPreferenceRow): CodexReviewModelPreference {
  return CodexReviewModelPreferenceSchema.parse({
    schemaVersion: 1,
    route: "codex_subscription",
    selectedModelId: row.selected_model_id,
    updatedAt: row.updated_at?.toISOString() ?? null,
  });
}

export async function readCodexReviewModelPreference(
  pool: DatabasePool,
): Promise<CodexReviewModelPreference> {
  const result = await pool.query<CodexReviewModelPreferenceRow>(`
    SELECT preference.selected_model_id, preference.updated_at
    FROM installations AS installation
    LEFT JOIN codex_review_model_preferences AS preference
      ON preference.installation_id = installation.id
    ORDER BY installation.created_at, installation.id
    LIMIT 1
  `);
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new Error("Installation is unavailable");
  }
  return mapPreference(row);
}

export async function selectCodexReviewModel(
  pool: DatabasePool,
  modelId: string,
): Promise<CodexReviewModelPreference> {
  const command = SelectCodexReviewModelCommandSchema.parse({ modelId });
  const result = await pool.query<CodexReviewModelPreferenceRow>(
    `
      INSERT INTO codex_review_model_preferences (installation_id, selected_model_id)
      SELECT id, $1
      FROM installations
      ORDER BY created_at, id
      LIMIT 1
      ON CONFLICT (installation_id) DO UPDATE
      SET selected_model_id = EXCLUDED.selected_model_id,
          updated_at = clock_timestamp()
      RETURNING selected_model_id, updated_at
    `,
    [command.modelId],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new Error("Installation is unavailable");
  }
  return mapPreference(row);
}
