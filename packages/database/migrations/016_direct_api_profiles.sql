CREATE TABLE direct_api_profiles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  credential_handle text NOT NULL UNIQUE CHECK (
    credential_handle ~ '^cred_[A-Za-z0-9_-]{43}$'
  ),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 256),
  organization_id text NOT NULL CHECK (
    char_length(organization_id) BETWEEN 1 AND 128
    AND organization_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  openai_project_id text NOT NULL CHECK (
    char_length(openai_project_id) BETWEEN 1 AND 128
    AND openai_project_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  requested_model_id text NOT NULL CHECK (
    char_length(requested_model_id) BETWEEN 1 AND 128
    AND requested_model_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  expected_resolved_model_id text NOT NULL CHECK (
    expected_resolved_model_id = requested_model_id
  ),
  data_policy jsonb NOT NULL CHECK (
    jsonb_typeof(data_policy) = 'object' AND octet_length(data_policy::text) <= 8192
  ),
  attestation_expires_at timestamptz NOT NULL,
  limits jsonb NOT NULL CHECK (
    jsonb_typeof(limits) = 'object' AND octet_length(limits::text) <= 4096
  ),
  price_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(price_snapshot) = 'object' AND octet_length(price_snapshot::text) <= 4096
  ),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[a-f0-9]{64}$'),
  availability text NOT NULL CHECK (availability IN ('available', 'stale', 'unavailable')),
  availability_reasons jsonb NOT NULL CHECK (
    jsonb_typeof(availability_reasons) = 'array'
    AND jsonb_array_length(availability_reasons) <= 6
    AND ((availability = 'available') = (jsonb_array_length(availability_reasons) = 0))
  ),
  attributed_openai_project_id text NOT NULL CHECK (
    char_length(attributed_openai_project_id) BETWEEN 1 AND 128
    AND attributed_openai_project_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  observed_api_version text NOT NULL CHECK (observed_api_version = '2020-10-01'),
  observed_model text NOT NULL CHECK (char_length(observed_model) BETWEEN 1 AND 128),
  observed_organization_id text NOT NULL CHECK (
    char_length(observed_organization_id) BETWEEN 1 AND 128
  ),
  synthetic_request_id text NOT NULL CHECK (
    char_length(synthetic_request_id) BETWEEN 1 AND 128
  ),
  last_test_passed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (updated_at >= created_at AND updated_at >= last_test_passed_at)
);

REVOKE ALL PRIVILEGES ON direct_api_profiles FROM kestrel_runtime;
GRANT SELECT, INSERT, UPDATE ON direct_api_profiles TO kestrel_runtime;

COMMENT ON TABLE direct_api_profiles IS
'Safe exact OpenAI Direct API profile metadata; secret bytes remain in the web-only broker store.';

COMMENT ON COLUMN direct_api_profiles.credential_handle IS
'Opaque Project-exclusive reference into the web-only encrypted credential store.';
