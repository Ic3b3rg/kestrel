ALTER TABLE factory_review_corrections ADD COLUMN lifecycle_profile jsonb;
COMMENT ON COLUMN factory_review_corrections.lifecycle_profile IS
  'Immutable Corrections profile and exact Skill bundles authorized with these findings. Retries retain this profile; NULL marks a legacy authorization gap.';
