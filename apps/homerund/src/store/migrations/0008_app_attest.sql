-- Milestone 10: App Attest (§9.8, §12). A device's platform is its role: `ios` only when this
-- desktop verified an App Attest attestation for its keys; claimed_platform is what it said.
-- attest_key and attest_counter are the App Attest credential for later assertions; approval_key
-- is the Secure Enclave key, bound into the attestation, that signs Face ID approvals.
ALTER TABLE remote_devices ADD COLUMN claimed_platform TEXT NOT NULL DEFAULT 'web' CHECK (claimed_platform IN ('ios', 'web'));
ALTER TABLE remote_devices ADD COLUMN attest_key TEXT;
ALTER TABLE remote_devices ADD COLUMN attest_counter INTEGER;
ALTER TABLE remote_devices ADD COLUMN approval_key TEXT;
UPDATE remote_devices SET claimed_platform = platform;
-- Nothing attested an iPhone linked before this: it keeps working with a browser's authority
-- until it pairs again.
UPDATE remote_devices SET platform = 'web' WHERE platform = 'ios';
