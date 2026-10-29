-- Advisor 0008 (rls_enabled_no_policy) for the table added in 0005: make the intent explicit. Only the
-- security-definer functions in `private` (and the service role) touch claim codes; API roles have no grants either.
create policy "definer functions only" on private.household_claims
  for all to anon, authenticated using (false) with check (false);
