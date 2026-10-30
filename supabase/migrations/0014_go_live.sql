-- Go live (decided 2026-10-30: "let the plan run for real" from tonight). The household is home every night unless an
-- away period, "Away tonight" / travel, or both phones saying "away" within the last 12 h; and ac-curve sends real IR
-- commands (the DRY_RUN function secret can still force a dry run; it can never force a live one).
-- Both can be switched back in the app (System › Tonight's plan) or with public.set_household_settings().

insert into public.household_settings (id) values (1) on conflict (id) do nothing;
update public.household_settings set ac_live = true, default_presence = 'home', updated_at = now() where id = 1;
