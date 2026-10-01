-- NULL resolved_by records a system retry, distinct from an Operator answer.
ALTER TABLE factory_human_gates DROP CONSTRAINT factory_human_gates_check;
ALTER TABLE factory_human_gates ADD CONSTRAINT factory_human_gates_check CHECK (
  (request_id IS NULL AND resolved_by IS NULL AND decision IS NULL AND answer IS NULL AND resolved_at IS NULL)
  OR
  (request_id IS NOT NULL AND decision IS NOT NULL AND answer IS NOT NULL AND resolved_at IS NOT NULL
    AND (resolved_by IS NOT NULL OR (reason IN ('usage_limit', 'unavailable') AND decision = 'resume_within_plan')))
);
