-- Server-only config (never sent to players).

Config = {}

-- ---- Permissions ------------------------------------------------------------
-- Access is by Discord user ID: the `discord:` identifier FiveM gets from a
-- player who connects with the Discord app running. Right-click a user in
-- Discord (Developer Mode on) -> Copy User ID.
--
-- Permissions a role can hold:
--   open     open the panel and preview edits live on the car you're in
--   save     write the car you're in to its handling.meta
--   bulk     copy to another vehicle, presets onto another vehicle, vMenu categories
--   tools    repair / flip, driving aids
--   freecam  the F7 free camera
--   history  see the save history
--   restore  roll a logged save back
--   publish  share presets on the server (and delete your own)
--   lock     lock / unlock vehicles, and save vehicles that are locked
--   manage   add, change and remove people in the Access tab / `heperm`
--   *        everything
--
-- rank decides who can manage whom: you can only give out roles below your own
-- rank, and only change people who sit below you. A role with '*' can do both
-- at any rank.
Config.Roles = {
    { name = 'viewer',  label = 'Viewer',  rank = 1, perms = { 'open' } },
    { name = 'tuner',   label = 'Tuner',   rank = 2, perms = { 'open', 'save', 'tools', 'freecam', 'history', 'publish' } },
    { name = 'manager', label = 'Manager', rank = 3, perms = { 'open', 'save', 'bulk', 'tools', 'freecam', 'history', 'restore', 'publish', 'lock', 'manage' } },
    { name = 'owner',   label = 'Owner',   rank = 4, perms = { '*' } },
}

-- Permanent entries. These show as "config.lua" in the Access tab and can't be
-- changed in-game. People added in-game (Access tab or `heperm add`) are kept
-- in the server's KVP store instead, so this file doesn't change.
-- Value: a role name, or { role = '...', label = 'who this is' }.
Config.Users = {
    ['399636381124788225'] = { role = 'owner', label = 'Boosted21' },
    ['1199774081550123069'] = { role = 'owner', label = 'Case' },
}

-- ACE permissions that also give a role (the highest one a player matches wins).
-- `handling_editor.use` is what the editor used before roles existed.
-- On top of these, `handling_editor.role.<name>` works for every role, e.g.
--   add_ace group.mechanic handling_editor.role.tuner allow
Config.AceRoles = {
    ['handling_editor.use'] = 'owner',
}

-- ---- Logging ----------------------------------------------------------------
-- Discord webhook for saves, restores, locks and access changes. The URL is
-- read from this convar so it stays out of git. Put it in secrets.cfg:
--   set handling_editor_webhook "https://discord.com/api/webhooks/..."
Config.WebhookConvar = 'handling_editor_webhook'

-- How many saves the History tab keeps (oldest are dropped).
Config.HistoryLimit = 400

-- A history entry stores the before/after of up to this many vehicles. Bigger
-- category saves are still logged, but can't be restored in one click.
Config.HistoryMaxTargets = 250

-- Shared presets kept on the server.
Config.MaxSharedPresets = 200

-- ---- Finding handling.meta / vehicles.meta ----------------------------------
-- Relative paths checked inside every started resource looking for a
-- handling.meta. Add your own vehicle pack's path here if it doesn't use one
-- of these conventions.
Config.CandidateFiles = {
    'data/handling.meta',
    'meta/handling.meta',
    'common/handling.meta',
    'handling.meta',
    'data/vehicles/handling.meta',
    'meta/vehicles/handling.meta',
}

-- Same idea for vehicles.meta. Used to translate a model/spawn name into
-- the <handlingId> it points at, since that's what handling.meta is keyed on
-- (the two often differ, e.g. model "personaltundracody" -> "jw_23tundraint").
Config.CandidateVehicleFiles = {
    'data/vehicles.meta',
    'meta/vehicles.meta',
    'common/vehicles.meta',
    'vehicles.meta',
    'data/vehicles/vehicles.meta',
    'meta/vehicles/vehicles.meta',
}
