ALTER TABLE factory_plan_approvals ADD COLUMN lifecycle_profile jsonb;
COMMENT ON COLUMN factory_plan_approvals.lifecycle_profile IS 'Immutable Implementation and technical repair profile frozen with this exact plan approval. Historical NULL never authorizes runtime fallback.';
