# handling_editor

A live handling.meta editor for FiveM. Get in a vehicle, open the panel,
drag sliders to feel the change instantly on the car you're sitting in, then
hit **Save to file** to patch the real `handling.meta` in whichever resource
ships that vehicle.

## How it works

- **Live preview**: uses `SET_VEHICLE_HANDLING_FLOAT/INT/VECTOR`, which only
  affect the vehicle *entity* you're driving — nobody else on the server is
  touched while you tune. See **Live edits on the car** below for how the
  editor keeps them there.
- **Save**: the server enumerates every started resource, looks for a
  `handling.meta` containing a `<handlingName>` matching your vehicle's model
  name, and does an in-place text edit of just the fields you changed —
  it doesn't rewrite or reformat the rest of the file. If **Keep .bak
  backup** is ticked it also keeps a one-time `.bak` copy alongside the
  original before the first edit.
- Base `CHandlingData` fields only (mass, drag, transmission, brakes,
  steering/traction, suspension, damage multipliers, seat offsets, flags).
  `SubHandlingData` (bike/plane/boat-specific data) isn't covered.
- `strModelFlags` / `strHandlingFlags` / `strDamageFlags` / `AIHandling` are
  saved to the file but aren't live-previewable (no numeric native for them);
  they take effect next time the vehicle's resource restarts.

## Install

1. Drop this folder in your resources directory as `handling_editor`.
2. `ensure handling_editor` in your server.cfg, **after** the vehicle
   resources it will need to edit.
3. Give people access by Discord ID: put permanent staff in `Config.Users` in
   `config.lua`, or add people in-game from the **Access** tab (or with
   `heperm add` in the server console). See [Permissions](#permissions).
   The old `add_ace ... handling_editor.use allow` still works and gives the
   Owner role.

## Permissions

Access is by **Discord user ID**: the `discord:` identifier FiveM gets when a
player connects with the Discord app running. (In Discord: Settings →
Advanced → Developer Mode, then right-click someone → Copy User ID.) A player
without Discord linked can only get access through an ACE.

Each person has one **role**. The defaults (edit them in `Config.Roles`):

| Role | Can |
|---|---|
| Viewer | open the panel and try edits live on their own car; can't save |
| Tuner | + save the car they're in, repair/flip/driving aids, freecam, see history, share presets |
| Manager | + copy/presets onto other vehicles and vMenu categories, restore saves, lock vehicles, add/change Viewers and Tuners |
| Owner | everything, including managing Managers and Owners |

The permissions a role can list: `open`, `save`, `bulk`, `tools`, `freecam`,
`history`, `restore`, `publish`, `lock`, `manage`, or `*` for all. Every
server event checks them; the panel just hides what your role can't use.

A player's role is the highest of:

- `Config.Users['<discord id>']` in `config.lua`: permanent, shown as
  "config.lua" in the Access tab and can't be changed in-game.
- The **in-game list** (Access tab or `heperm`): kept in the server's KVP
  store (the server's own database folder, not the resource), so it survives
  restarts, doesn't show up in git and isn't overwritten when you upload the
  resource.
- An ACE: anything in `Config.AceRoles` (`handling_editor.use` = Owner), or
  `handling_editor.role.<name>` for any role, e.g.
  `add_ace group.mechanic handling_editor.role.tuner allow`.

**Who can change whom**: you can only give out roles ranked below your own,
and only change or remove people ranked below you. You can't change yourself.
Roles with `*` (Owner) can do anything. Changes reach online players straight
away (their panel updates, or closes if they lost access).

### Access tab

Shown to roles with `manage` or `lock`:

- **Your access**: your role, where it comes from and your Discord ID.
- **Give someone access**: pick an online player (fills in their Discord ID)
  or paste an ID, choose a role, **Give access**.
- **People with access**: change a role from the dropdown, or **Remove**.
  Green dot = online.
- **Locked vehicles** (with `lock`): everything locked, with **Unlock**.
- **Roles**: what each role can do.

### Console command

`heperm` works in the server console, and in-game for roles with `manage`
(results go to chat). Anywhere it takes a Discord ID you can give an online
player's server ID instead.

```
heperm list                       everyone on the list
heperm roles                      roles and their permissions
heperm whois <serverId>           someone's Discord ID and role
heperm add <discordId|serverId> <role> [label]
heperm remove <discordId|serverId>
```

## Save history and restore

Every write to a handling.meta is logged: single saves, copies, presets
applied to another vehicle, vMenu categories and restores. Each entry keeps
who did it, when, and the before → after of every field it changed.

- **History** tab (needs `history`): this vehicle's saves, or **All
  vehicles**. **Show changes** lists the fields.
- **Restore before this** (needs `restore`, click twice): puts back the values
  those fields had before that save, on every vehicle it touched. The restore
  is logged too, so you can undo it the same way. If you're sitting in that
  car, its new file values go on the car straight away (Ctrl+Z still works).
  If fields were changed again since, they're put back anyway and the message
  says how many.
- The newest `Config.HistoryLimit` entries are kept (400). A category save
  over more than `Config.HistoryMaxTargets` vehicles (250) is still logged but
  can't be restored in one click.
- Saves from before this version aren't in the history.

## Vehicle locks

Roles with `lock` can lock the vehicle they're in from the **Tools** tab, with
an optional reason (e.g. the PD fleet). Nobody without `lock` can then save it
by any route, and category saves skip it (the result message lists what was
skipped). People with `lock` can still save it. The line under the Handling ID
shows the lock in amber.

## Discord log

Optional. Set a webhook in `secrets.cfg` (so it stays out of git):

```
set handling_editor_webhook "https://discord.com/api/webhooks/..."
```

Saves (with the changed fields), category saves, restores, locks and access
changes are posted there. Mentions are shown but don't ping anyone.

## When someone else saves your car

If another staff member saves, restores or locks the vehicle you have open,
you get a message and your "file:" values refresh. Your own edits stay.

## What's in the panel

- **Header**: vehicle name and class, your role, the Handling ID lookup, a **telemetry
  strip** (speed, gear, RPM, 0-100 km/h, 0-60 mph, quarter-mile time and top
  speed), field search (**Ctrl+F**), **Changed only** and **Help**.
- **Left nav**: the field groups (each with a badge counting fields that
  differ from the file), then the **Tune for** tabs (**Police**,
  **Street & track**, **Drift**, **Pickups & trucks**, **Off-road setup**,
  **Crawling**), then
  **Changes**, **★ Presets**, **Bulk & copy**, **Tools**, **History** and
  **Access** (tabs your role can't use are hidden).
- **Footer**: undo / redo, Reset to file, Read from car, **Save to file**
  (the badge shows how many fields differ from the file), a line saying how
  many changes are on your car but not saved yet, and the **Keep .bak
  backup** checkbox.
- **?** (header) brings back the **How the editor works** guide that sits
  above the fields until you press **Got it**.

### Editing fields

- Every field shows its file value, a **+/- delta** when it differs (hover for
  the % change), an amber bar on the left edge, and a **↺** button that reverts
  just that field. Sliders have a small amber tick at the file value.
- **Help** (on by default) shows a plain-language explanation under each
  field, a one-line intro at the top of each group, what each end of a slider
  does (e.g. "◂ softer · stiffer ▸"), and the raw field name. Hover a label
  for the same text at any time.
- Untouched fields show the **file's** value, not the car's. Where the car is
  running something else right now (another script changed it, or the file
  was saved but the pack hasn't restarted), the field shows a purple
  **car: ...** tag; hover it for why. Saving writes the value shown in the
  panel, so changes other scripts make on the car never end up in the file.
- Fields tagged **on respawn** (mass, centre of mass, inertia, fuel tank,
  oil, seat position) are read by the game when the car spawns, so a live
  change may do little until you save, restart the pack and respawn the car.
  **save + restart** (flags, AI handling) can't be tried live at all.
- Click into a number box and scroll the mouse wheel to nudge by one step
  (**Shift** x10, **Alt** x0.1). Unfocused boxes ignore the wheel, so
  scrolling the list never changes values.
- **Undo / redo**: **Ctrl+Z** / **Ctrl+Y** (or the footer arrows) step back
  through edits, preset applies, reverts and resets. **Ctrl+S** saves.
- **Flags**: the flag fields start out with the file's value, and **Bits ▾**
  opens a checkbox per flag (e.g. `ABS_STD`, `STEER_REARWHEELS`, `CVT`). Bits
  that differ from the file are highlighted. AI handling suggests the valid
  values.
- After a successful save the file is re-read automatically, so the "file:"
  values and change markers always match what's on disk.

### Changes tab

Lists every field that differs from `handling.meta` as `file -> now`, with a
per-field **Revert**. Click a name to jump to it. Also has **Revert all to
file**, **Clear blue outlines** (forget which fields you touched without
changing values) and **Export changes as XML**.

### Tools tab

- **Repair & clean** / **Flip upright**: quick fixes while testing. Repair
  re-applies your current tune afterwards. They need the `tools` permission.
- **Lock this vehicle** (with `lock`): see [Vehicle locks](#vehicle-locks).
- **Export**: a handling.meta `<Item>` built from all fields, or only the
  changed ones, ready to copy.
- **Telemetry**: come to a complete stop, then pull away forwards. The strip
  times 0-100 km/h, 0-60 mph and the quarter mile (with trap speed). Braking
  or lifting noticeably mid-run ends the run. Hover a time to see your best.
  Click the speed to switch km/h / mph. The ↻ button resets.
- **A/B compare**: **Store A** saves every number field as it is now; change
  things and **Store B**; then **Drive A** / **Drive B** flip the car between
  the two so you can feel the difference on the same stretch of road. A switch
  is a normal edit (one Ctrl+Z), and Save to file saves whichever one you're
  on. The slots are cleared when the panel is reopened.
- **Display**: show/hide the telemetry strip, mph telemetry, field help.

### Tune for: how these tabs work

Each **Tune for** tab gathers the fields that matter for that kind of vehicle
on one page, plus:

- **One-click setups**, worked out from the car's *file* values (so clicking
  twice doesn't stack), each one a single Ctrl+Z. Hover a button to see
  exactly what it sets. Nothing is written until you **Save to file**.
- **Nudge buttons** (e.g. *More front grip*) that step from the *current*
  value, so clicking again goes further.
- A **readout** of stat tiles that updates as you edit.
- **Flag checkboxes** for the relevant flag bits (file only: save, then restart
  the vehicle's resource).
- A **live readout** while you drive (release the mouse with **F6** / **Drive**).
  **Reset records** clears it.

### Police tab

- **Setups** (pursuit-rated, worked out from the vehicle's file values):
  - **Police interceptor (car)**: Charger / Crown Vic / Taurus style. +5%
    weight for equipment, +12% power, +8% top speed, quicker shifts, +20%
    brakes at 60% front bias, firmer springs/dampers and roll bars, a bit more
    grip, less launch wheelspin, lower centre of mass, 20% less collision and
    deformation damage.
  - **Police SUV**: Explorer / Tahoe / Durango style. +8% weight, +10% power,
    +25% brakes at 60% front, stiffer springs/dampers, much stiffer roll bars
    and a lower centre of mass so it doesn't roll over, AWD 40/60 if it was
    2WD, 20% less damage.
  - **Police truck**: F-150 Police Responder / Silverado PPV / K9 truck style.
    +8% weight, +12% pull, +5% top speed, +20% brakes at 60% front, stiffer
    springs and roll bars, lower centre of mass, less grip lost on dirt, 4x4
    40/60 if it was 2WD, 20% less damage.
  The interceptor is also listed under Street & track and the truck under
  Pickups & trucks.
- Each setup works from the file values, so to switch from one police setup
  to another on the same vehicle, undo (Ctrl+Z) or **Reset to file** first;
  otherwise fields only the first one sets stay changed.
- **Pursuit tweaks**: push bumper (-20% collision/deformation damage), power
  +5%, top speed +5%, brakes +10%, less body roll, tougher engine (-20%
  engine damage); plus the ABS, run-flat tyres (can't be burst by spike
  strips) and easier-to-right flags.
- The same **live g-forces & braking** readout as Street & track, so you can
  check stopping distances before and after.
- To give a whole fleet the same change: apply a setup on one car, then
  **Bulk & copy -> Apply to a vMenu category** (e.g. Emergency). It applies the
  fields you changed with that car's values to every vehicle you leave ticked.

### Street & track tab

- **Setups**: Comfort / daily, Sport, Track / grip, Drag launch, Stance /
  slammed.
- **Readout**: power index (drive force per tonne x100, for comparing cars),
  balance (understeer / neutral / oversteer from the traction bias), brake
  bias and gear-limited top speed.
- **Balance & brakes** nudges (more front / rear grip, brakes +10%, 55% front
  brake bias, less body roll) and the ABS, no traction control and CVT flags.
- **Live g-forces & braking**: cornering g now, peak cornering / braking /
  acceleration g, a **friction circle** (the dot shows where the car is right
  now: left/right = cornering, up = braking, down = accelerating; rings at
  0.5 / 1.0 / 1.5 g), and **braking tests**: hold the brake through 100 km/h
  (or 60 mph) to a full stop and it records the 100-0 km/h and 60-0 mph
  distances (last and best). Getting back on the throttle cancels a run.
  Distances show in feet when telemetry is set to mph.

### Drift tab

- **Setups**: Drift starter and Pro / high angle (RWD, more lock, wider slide
  window, slide grip at 88% / 92% of peak, more front bite, stronger handbrake,
  more power).
- **Readout**: drive, steering lock, slide grip (% of peak grip kept while
  sliding) and slide window (traction curve lateral).
- **Fine tuning** nudges: more lock, slides easier, holds angle better, more
  front bite, RWD; plus the no traction control flag.
- **Drift meter**: angle now with a left/right gauge (green while scoring),
  run score, last run and best run, biggest angle. You score while sliding
  10-110° above walking pace (angle x speed). A run ends 1.5 s after you
  straighten up, or straight away if you hit something.

### Pickups & trucks tab

- **Setups**: Half-ton daily, Heavy duty / tow rig (heavier, stiffer, more
  low-down pull, more gears, front-biased brakes), Semi / tractor unit, Lifted street truck,
  Lowered street truck, Prerunner.
- **Readout**: weight (plus any bed load), power index, drive and lift.
- **Bed load test** (live only, never saved): adds 0-2000 kg to the truck
  you're in. With **Load sits in the bed** on it also moves the centre of mass
  back and up by the load's share of the total weight. Edits to mass or centre
  of mass while loaded still save the real values, and the load is removed
  when the panel closes. Combine it with the braking tests to see how a load
  changes stopping distances.
- **Truck tweaks**: stiffer rear springs, less body roll, more low-down pull,
  60% front brake bias, 4x4 (AWD 40/60); plus the solid rear axle, dually rear
  wheels and big vehicle flags.
- The same **live g-forces & braking** readout as Street & track.

### Off-road setup tab

- **One-click setups**: **Trail / overland**, **Rock crawler**, **Mud bogger**
  and **Desert runner**. Each sets a handful of suspension, traction and drive
  fields worked out from the car's *file* values (so clicking twice doesn't
  stack), as one undo step. Hover a button to see exactly what it will set.
  Nothing is written until you **Save to file**.
- **Setup readout**: wheel travel (upper minus lower limit), lift, drive type
  (RWD / FWD / AWD split) and a grip-off-road rating from
  `fTractionLossMult`. Updates as you edit.
- **Off-road flags**: checkboxes for the handling/model flag bits that matter
  off-road (off-road abilities, x2, no bush drag, less snow sink, rally tyres,
  easier righting, solid front/rear axle). File only: save, then restart the
  vehicle's resource.
- The off-road fields (ride height, travel, springs, damping, anti-roll,
  centre of mass, traction loss, traction curve, drive bias) on one page.
- **Live terrain**: pitch and roll, articulation (difference in suspension
  compression between the most and least compressed wheel), wheels on the
  ground, and a bar per wheel showing how far it's pushed into its travel.
  Wheels in the air turn amber, spinning wheels orange. Records keep the best
  articulation, steepest climb and most side-tilt (only while the car is on
  the ground). Release the mouse (**F6** / **Drive**) and drive to see it move.

### Crawling tab

- **Driving aids** (live only; they never change handling values, are never
  saved, and switch off when the panel closes or you leave the car):
  - **Low range (4-Lo)**: multiplies engine power by the chosen ratio
    (2.0 / 2.7 / 4.0) and cuts the throttle above a speed cap (5-60 km/h).
  - **Crawl control**: holds a set forward speed (1-15 km/h) with automatic
    throttle and braking, so you only steer. Holding brake/reverse overrides
    it.
  - **Hill hold**: when you're stopped on a slope with no pedal pressed, the
    handbrake holds the car until you press a pedal.
  - The status line shows when the speed cap, crawl control or hill hold is
    actually acting. Aids need the `tools` permission.
- **Crawler setup**: the Rock crawler setup, drive split buttons (RWD,
  AWD 50/50, AWD 40/60), **Max steering lock** (45°), **No launch wheelspin**,
  the setup readout, and file-only toggles for four-wheel steering and
  low-speed wheelies. These are normal edits (undo, save to keep).
- Drive force, gears, drive inertia and steering lock fields, and the same
  **Live terrain** readout.

## Use

- Get in the driver's seat, press **F6** (or run `/handlingeditor`).
- Adjust values — sliders apply immediately to the vehicle you're in.
- The line under the Handling ID box shows which resource/file it found
  (or a warning if it couldn't find one — you can still preview live, you
  just won't be able to save until it's found).
- If your vehicle's handling name doesn't match its spawn model (shared
  handling data, reskins, etc.), edit the **Handling ID** field and hit
  **Reload**.
- **Top gear speed** (`fInitialDriveMaxFlatVel`, Transmission tab) has a second box showing the
  value in mph. Type in either box and the other one updates, so you can
  set top speed in mph directly. The "file:" hint shows the mph value too.
- **Reset to file** re-applies the values currently on disk to your vehicle.
  **Read from car** loads whatever the vehicle's live handling is right now
  into the panel (this includes anything other scripts changed on it).
- **Keep .bak backup** (footer checkbox, off by default): when ticked, the
  first save to a file also keeps a copy of the original next to it as
  `handling.meta.bak`. It applies to every kind of save (single, whole
  category, presets, copy-to) and is remembered on your game client.
- **Save to file** writes your changes into the actual `handling.meta`.
  This only affects **vehicles spawned after the owning resource restarts**
  — anyone already driving one keeps their current (in-memory) handling
  until then.

## Live edits on the car

Some other scripts write the same handling values while you drive, which used
to undo edits straight away (RealisticVehicleFailure resets brake force every
frame, for example). While the panel is open the editor:

- **Keeps your edits on the car**: every half second it checks the fields you
  changed and puts your value back if something else changed it. You get a
  message the first time, and a warning if a script keeps doing it.
- **Leaves alone the fields a script builds on by itself**: Boosted-Offroad
  raises off-road grip loss on loose ground starting from your value, and
  RealisticVehicleFailure scales brake force with the pedal up to your value.
  Those fields say so under their help text.
- **Refreshes the gearbox** after power, gears, drive inertia or top gear
  speed changes (`SET_VEHICLE_HIGH_GEAR` + `MODIFY_VEHICLE_TOP_SPEED`, using
  Boosted-TunerMenu's top-speed tune so that stays as it was), since the game
  otherwise only works out gearing when the car spawns.
- **Tells other scripts** about each edit with a local client event, so a
  script that keeps its own copy of a value can adopt it:

  ```lua
  AddEventHandler('handling_editor:applied', function(vehicle, values)
      -- values = { fBrakeForce = 0.9, ... } in handling.meta units
  end)
  ```

  RealisticVehicleFailure listens to it.

When the panel closes your edits stay on the car; the editor just stops
guarding them.

**op-mechanic tuning kits** (engine swaps, tyres, brakes and drivetrain in
`config/TuningKitsConfig.lua`) multiply or overwrite handling from their own
stock copy. op-mechanic is escrowed, so it can't listen to the event above:

- A car with kits fitted shows **car: ...** on the fields the kits change,
  because the car runs the kit value, not the file value. Saving writes the
  file value (the kit stays a kit, it isn't baked into handling.meta).
- If op-mechanic re-applies a kit while the panel is open, the editor puts
  your edit back; if it does that constantly you get a warning on that field.
- For clean tuning, use a car without kits fitted.

## Freecam

Press **F7** (or run `/hefreecam`, or click **Freecam** in the panel header)
to fly a free camera around, e.g. to watch the suspension from outside. It
needs the `freecam` permission, and works with the panel open or closed.

- **WASD** move, **Q / E** down / up, mouse to look.
- **Shift** 4x faster, **Ctrl** 4x slower, **mouse wheel** changes the base
  speed (shown on screen).
- **F6** brings the panel back and grabs the mouse so you can edit values
  while the camera holds its view. **F6** again to keep flying.
- **F7** again (or **Exit freecam**) returns to the normal camera.

While freecam is on, your driving controls are disabled, so the car coasts
to a stop wherever you left it.

## Presets

The **★ Presets** tab (bottom of the left-hand nav) saves whatever fields you
currently have outlined in blue — not the whole vehicle — under a name you
choose.

**Apply presets to** at the top of the tab picks where a preset goes:

- **My car** (default): **Apply** live-previews the preset's fields on the
  vehicle you're in. They stay outlined in blue, so hit **Save to file** to
  keep them.
- **Another vehicle** from the same pack: the button becomes
  **Apply & save** and writes the preset's number fields straight to that
  vehicle's `handling.meta` (no separate save step).

**Update** replaces a preset with the fields you've edited now, **Export**
gives you its JSON to share, and **Delete** removes it (both ask for a second
click). **Import...** at the top takes JSON exported from this editor (one
preset or a list); clashing names get a number added.

Your own presets are stored in the browser profile of the game client that
saved them (same mechanism as the panel's remembered position/size).

**Shared on the server**, at the top of the tab, is a list every staff member
sees. **Share** (needs `publish`) on one of your presets puts a copy there
(sharing again under the same name updates it). Anyone can **Apply** a shared
preset or **Copy to PC**; you can delete the ones you shared, and `manage`
can delete any. **Apply presets to** another vehicle needs `bulk`.

## Copy this car to another vehicle

Use the **Copy this car to another vehicle** card on the **Bulk & copy** tab:

1. Pick a vehicle from the dropdown. It lists the other vehicles in the same
   pack as the car you're in.
2. Click **Copy to <vehicle>**.

This copies your car's *whole current* handling (everything shown, not just
what you've edited) onto that vehicle and saves it to its `handling.meta`
straight away. Only number fields are copied; flags and strings stay as they
were. If a copy of that vehicle is already spawned, it updates live too.
Restart the pack for newly spawned copies to pick it up.

## Editing a whole vMenu category at once (all SUVs, all Sports, ...)

The **Apply to a vMenu category** card on the **Bulk & copy** tab applies your changes to
every vehicle in one of vMenu's **Addon Vehicles** categories instead of just
the one you're sitting in. Only vehicles listed in vMenu's
`config/addons.json` are included; base-game vehicles and addon models that
aren't in that list are never touched.

1. Change the fields you want (e.g. *Transmission -> Max flat velocity*). Any
   field you edit gets a blue outline. **Only outlined fields are applied** to
   the class, so changing top speed won't overwrite every other vehicle's mass,
   traction and so on with your car's values.
2. Pick the category in the first dropdown (the number in brackets is how
   many vMenu addon vehicles it has). It defaults to the category of the
   vehicle you're in.
3. Pick the scope in **Only in**. It defaults to the resource your current
   vehicle's `handling.meta` was found in (e.g. `DLDebadged450`), so the edit
   stays inside that one pack. Choose **All resources** to include every pack
   on the server.
4. Click **Apply changes...**. The server checks which models in that class
   really have a handling.meta entry in scope, and the summary lists exactly
   what will be set and shows every vehicle it will be applied to (spawn name
   plus in-game name), each with a checkbox.
5. **Untick any vehicle you want to leave alone.** Use the filter box to find
   one, and **All** / **None** to tick or untick every vehicle currently shown
   (filter `q7` then **None** unticks only the matches). The headline tracks
   the count ("set on 47 of 48 vehicles"). Only ticked vehicles are changed.
6. Choose:
   - **Spawned only** - live-applies to the spawned vehicles among the ticked
     models. Nothing is written to disk.
   - **Save to all** - does the above *and* patches the `handling.meta` entry
     of each ticked model (plus a one-time `.bak` per file if **Keep .bak
     backup** is ticked). Restart
     the vehicle resource(s) for newly spawned vehicles to pick it up.

Changing the class or scope dropdown after the summary appears hides it; click
**Apply changes...** again so the count is re-checked.

Notes:

- Categories match vMenu's Addon Vehicles menu: each model in vMenu's
  `config/addons.json` that is actually streamed, grouped by its game class
  (`GET_VEHICLE_CLASS_FROM_NAME`, i.e. the `<vehicleClass>` in its
  vehicles.meta). Edit `addons.json` and reopen the panel to change what's
  included. If vMenu isn't running, it falls back to every vehicle model the
  game knows about.
- Each model is resolved to its handling.meta entry the same way a single save
  does. Models it can't find are skipped and listed in the server console.
- Values are set to the **same absolute number** on every vehicle - it does not
  scale each one relative to its own value.
- If a field is missing from a vehicle's entry (some packs omit e.g.
  `fDownforceModifier`), it is left alone rather than added, and the result
  message tells you how many entries were skipped.
- `strModelFlags` / `strHandlingFlags` / `strDamageFlags` / `AIHandling` are
  never applied class-wide.
- Cycles, boats, planes, helicopters and trains aren't offered (their handling
  is mostly SubHandlingData, which the editor doesn't cover).

## Config

Everything is in `config.lua` (server only, never sent to players):

- `Roles`, `Users`, `AceRoles` — see [Permissions](#permissions).
- `WebhookConvar` — the convar holding the Discord webhook URL.
- `HistoryLimit`, `HistoryMaxTargets`, `MaxSharedPresets` — storage caps.
- `CandidateFiles` — relative paths checked inside every started resource
  when hunting for a vehicle's handling.meta. Add your vehicle pack's path
  here if it's non-standard.
- `CandidateVehicleFiles` — same, for `vehicles.meta`. Used to turn a model
  name into the `<handlingId>` that handling.meta is keyed on.

## Notes / limitations

- Fields tagged **on respawn** are set by the game when the car spawns. The
  editor still writes them to the car, but you may not feel the change (or the
  Pickups & trucks bed load test, which uses mass and centre of mass) until
  the car is respawned.

- While the panel has the mouse, the game camera and driving controls are
  frozen (that's how the browser layer works). Click **Drive** in the panel
  header (or press **F6**) to release the mouse: the panel stays on screen,
  dimmed, and you can look around and drive. Press **F6** again to grab the
  mouse back and keep editing. **Esc** closes the panel entirely.
- Drag the header to move the panel and drag its edges/corners to resize it.
  Position and size are remembered.
- The editor edits an existing `<Item type="CHandlingData">` entry; it
  won't create a new vehicle entry from scratch.
- This is a powerful admin tool. Only give `save`/`bulk`/`restore` roles to
  trusted staff; Viewer is safe to hand out (it can't write anything).
- Opening the panel now asks the server for your role first, so there's a
  short round-trip before it appears.
