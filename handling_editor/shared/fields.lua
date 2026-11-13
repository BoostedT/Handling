-- Shared field definitions for CHandlingData (base handling fields only --
-- SubHandlingData, e.g. bike/plane/boat specific data, is out of scope).
-- GET/SET_VEHICLE_HANDLING_* read and write these fields in the same units as
-- handling.meta (a save from the live values writes steering lock, drag and
-- top speed back unchanged), so no unit conversion is needed.
--
-- Per field:
--   desc   plain-language help shown under the field
--   lo/hi  what moving the slider left / right does, shown at its two ends
--   apply  when a change reaches the car (default 'live'):
--            live   straight away
--            spawn  the game reads it when the car spawns, so a live change
--                   may do little until the car is respawned
--            file   no live effect: save, restart the pack, respawn
--            none   doesn't change how the car drives
--   bits   (flags fields only) names each bit, index 1 = bit 0
-- Per group, `intro` is the one-line explanation at the top of its tab.

Handling = Handling or {}

local ModelFlagBits = {
    'IS_VAN', 'IS_BUS', 'IS_LOW', 'IS_BIG',
    'ABS_STD', 'ABS_OPTION', 'ABS_ALT_STD', 'ABS_ALT_OPTION',
    'NO_DOORS', 'TANDEM_SEATING', 'SIT_IN_BOAT', 'HAS_TRACKS',
    'NO_EXHAUST', 'DOUBLE_EXHAUST', 'NO_1STPERSON_LOOKBEHIND', 'CAN_ENTER_IF_NO_DOOR',
    'AXLE_F_TORSION', 'AXLE_F_SOLID', 'AXLE_F_MCPHERSON', 'ATTACH_PED_TO_BODYSHELL',
    'AXLE_R_TORSION', 'AXLE_R_SOLID', 'AXLE_R_MCPHERSON', 'DONT_FORCE_GRND_CLEARANCE',
    'DONT_RENDER_STEER', 'NO_WHEEL_BURST', 'INDESTRUCTIBLE', 'DOUBLE_FRONT_WHEELS',
    'IS_RC', 'DOUBLE_REAR_WHEELS', 'NO_WHEEL_BREAK', 'EXTRA_CAMBER',
}

local HandlingFlagBits = {
    'SMOOTHED_COMPRESSION', 'REDUCED_MOD_MASS', 'HAS_KERS', 'HAS_RALLY_TYRES',
    'NO_HANDBRAKE', 'STEER_REARWHEELS', 'HANDBRAKE_REARWHEELSTEER', 'STEER_ALL_WHEELS',
    'FREEWHEEL_NO_GAS', 'NO_REVERSE', 'REDUCED_RIGHTING_FORCE', 'STEER_NO_WHEELS',
    'CVT', 'ALT_EXT_WHEEL_BOUNDS_BEH', 'DONT_RAISE_BOUNDS_AT_SPEED', 'EXT_WHEEL_BOUNDS_COL',
    'LESS_SNOW_SINK', 'TYRES_CAN_CLIP', 'REDUCED_DRIVE_OVER_DAMAGE', 'ALT_EXT_WHEEL_BOUNDS_SHRINK',
    'OFFROAD_ABILITIES', 'OFFROAD_ABILITIES_X2', 'TYRES_RAISE_SIDE_IMPACT_THRESHOLD', 'OFFROAD_INCREASED_GRAVITY_NO_FOLIAGE_DRAG',
    'ENABLE_LEAN', 'FORCE_NO_TC_OR_SC', 'HEAVYARMOUR', 'ARMOURED',
    'SELF_RIGHTING_IN_WATER', 'IMPROVED_RIGHTING_FORCE', 'LOW_SPEED_WHEELIES', 'LAST_AVAILABLE_FLAG',
}

local DamageFlagBits = {
    'DRIVER_SIDE_FRONT_DOOR', 'DRIVER_SIDE_REAR_DOOR', 'PASSENGER_SIDE_FRONT_DOOR', 'PASSENGER_SIDE_REAR_DOOR',
    'BONNET', 'BOOT',
}

Handling.Groups = {
    {
        name = 'Mass & Drag',
        intro = 'How heavy the car is, how the weight sits, and how much the air holds it back.',
        fields = {
            { name = 'fMass',                 type = 'float',  min = 0,     max = 50000, step = 1,    label = 'Mass (kg)',
              lo = 'lighter', hi = 'heavier', apply = 'spawn',
              desc = 'How heavy the car is. Heavier cars hit harder and get shoved around less, but need more power and brakes. Most cars are 1,000-2,000 kg.' },
            { name = 'fInitialDragCoeff',     type = 'float',  min = 0,     max = 100,   step = 0.1,  label = 'Drag coefficient',
              lo = 'slippery', hi = 'draggy',
              desc = 'Air resistance. Higher holds the car back more at speed and lowers its real top speed. Most cars sit between 5 and 10.' },
            { name = 'fDownforceModifier',    type = 'float',  min = 0,     max = 20,    step = 0.01, label = 'Downforce',
              lo = 'less', hi = 'more grip at speed',
              desc = 'Presses the car into the road as speed rises. You mostly feel it in fast corners.' },
            { name = 'fPercentSubmerged',     type = 'float',  min = 0,     max = 200,   step = 1,    label = 'Percent submerged',
              lo = 'floats high', hi = 'sinks deeper',
              desc = 'How far the car sinks in water before it floats, as a % of its height. 85 is normal for cars.' },
            { name = 'vecCentreOfMassOffset', type = 'vector', min = -5,    max = 5,     step = 0.01, label = 'Centre of mass',
              apply = 'spawn',
              desc = 'Moves the balance point, in metres. X = right, Y = forward, Z = up. A lower Z is more stable with less body roll; a forward Y makes the car nose-heavy.' },
            { name = 'vecInertiaMultiplier',  type = 'vector', min = 0,     max = 10,    step = 0.01, label = 'Inertia',
              apply = 'spawn',
              desc = 'How hard the car is to rotate on each axis. Higher = slower to pitch, roll and spin. 1.0 is normal.' },
        },
    },
    {
        name = 'Transmission',
        intro = 'Engine power, gears and which wheels get driven. The editor refreshes the gearbox for you after each change.',
        fields = {
            { name = 'fDriveBiasFront',                 type = 'float', min = 0, max = 1,   step = 0.01,  label = 'Drive bias (0 = RWD, 1 = FWD)',
              lo = 'rear-wheel drive', hi = 'front-wheel drive',
              desc = 'Where the power goes. 0 = rear-wheel drive, 1 = front-wheel drive, anything in between = all-wheel drive (0.5 = even split).' },
            { name = 'nInitialDriveGears',              type = 'int',   min = 1, max = 10,  step = 1,     label = 'Gears',
              lo = 'fewer', hi = 'more',
              desc = 'Number of forward gears. More gears means smaller jumps in revs between them.' },
            { name = 'fInitialDriveForce',              type = 'float', min = 0, max = 3,   step = 0.001, label = 'Drive force (power)',
              lo = 'weaker', hi = 'stronger',
              desc = 'Engine power at the wheels: the main acceleration value. Most cars are 0.2-0.4; 0.5 and up is very fast.' },
            { name = 'fDriveInertia',                   type = 'float', min = 0, max = 3,   step = 0.01,  label = 'Drive inertia',
              lo = 'slow revs', hi = 'quick revs',
              desc = 'How quickly the engine revs up and down. 1.0 is normal.' },
            { name = 'fClutchChangeRateScaleUpShift',   type = 'float', min = 0, max = 20,  step = 0.1,   label = 'Up-shift speed',
              lo = 'slow shifts', hi = 'quick shifts',
              desc = 'How fast it changes up a gear. Higher = less time without power between gears.' },
            { name = 'fClutchChangeRateScaleDownShift', type = 'float', min = 0, max = 20,  step = 0.1,   label = 'Down-shift speed',
              lo = 'slow shifts', hi = 'quick shifts',
              desc = 'How fast it changes down a gear.' },
            { name = 'fInitialDriveMaxFlatVel',         type = 'float', min = 0, max = 600, step = 1,     label = 'Top gear speed (km/h)', mph = true,
              lo = 'short gears', hi = 'tall gears',
              desc = 'Speed at the rev limiter in top gear on flat ground. Higher = taller gears and a higher possible top speed, but slower pick-up. Drag and power decide whether the car really gets there.' },
        },
    },
    {
        name = 'Brakes',
        intro = 'How hard the car stops and how the braking is split front to rear.',
        fields = {
            { name = 'fBrakeForce',     type = 'float', min = 0, max = 5,  step = 0.01, label = 'Brake force',
              lo = 'weaker', hi = 'stronger',
              desc = 'Braking strength. Higher = shorter stops; too high locks the wheels easily. Most cars sit around 0.5-1.0.' },
            { name = 'fBrakeBiasFront', type = 'float', min = 0, max = 1,  step = 0.01, label = 'Brake bias front',
              lo = 'more rear', hi = 'more front',
              desc = 'How braking is split. 0.5 = even. More front is stable; more rear lets the back step out under braking.' },
            { name = 'fHandBrakeForce', type = 'float', min = 0, max = 20, step = 0.01, label = 'Handbrake force',
              lo = 'weaker', hi = 'stronger',
              desc = 'Handbrake strength. Higher = easier handbrake turns.' },
        },
    },
    {
        name = 'Steering & Traction',
        intro = 'Grip and steering. Peak grip and sliding grip are the two values that change the feel the most.',
        fields = {
            { name = 'fSteeringLock',            type = 'float', min = 0, max = 90, step = 0.1,  label = 'Steering lock (deg)',
              lo = 'less lock', hi = 'more lock',
              desc = 'How far the front wheels can turn. More = tighter turning circle but twitchier at speed. Most cars are 30-40.' },
            { name = 'fTractionCurveMax',        type = 'float', min = 0, max = 10, step = 0.01, label = 'Grip (peak)',
              lo = 'less grip', hi = 'more grip',
              desc = 'Grip while the tyres are still holding the road: the main cornering grip value. Most cars are 2.0-2.6.' },
            { name = 'fTractionCurveMin',        type = 'float', min = 0, max = 10, step = 0.01, label = 'Grip (sliding)',
              lo = 'slides more', hi = 'grips more',
              desc = 'Grip once the tyres are sliding or spinning. The further it sits below peak grip, the more suddenly the car lets go.' },
            { name = 'fTractionCurveLateral',    type = 'float', min = 0, max = 90, step = 0.1,  label = 'Grip curve (deg)',
              lo = 'sharp', hi = 'forgiving',
              desc = 'The slide angle where grip peaks. Lower feels sharp and sudden, higher feels softer and more forgiving. 22.5 is common.' },
            { name = 'fTractionSpringDeltaMax',  type = 'float', min = 0, max = 5,  step = 0.01, label = 'Tyre flex',
              lo = 'stiff tyres', hi = 'soft tyres',
              desc = 'How far the tyre can flex sideways before it slides. Usually around 0.1-0.15.' },
            { name = 'fLowSpeedTractionLossMult',type = 'float', min = 0, max = 5,  step = 0.01, label = 'Launch wheelspin',
              lo = 'clean launch', hi = 'more wheelspin',
              desc = 'Wheelspin when pulling away. 0 = none; higher = more burnout.' },
            { name = 'fCamberStiffnesss',        type = 'float', min = 0, max = 5,  step = 0.01, label = 'Camber stiffness',
              lo = 'none', hi = 'more',
              desc = 'How much leaning in a corner changes grip. Usually 0.' },
            { name = 'fTractionBiasFront',       type = 'float', min = 0, max = 1,  step = 0.01, label = 'Grip bias front',
              lo = 'more rear grip', hi = 'more front grip',
              desc = 'How grip is split. Over 0.5 = more front grip (turns in sharply, the rear can slide). Under 0.5 = more rear grip (stable, can push wide).' },
            { name = 'fTractionLossMult',        type = 'float', min = 0, max = 5,  step = 0.01, label = 'Off-road grip loss',
              lo = 'better off-road', hi = 'worse off-road',
              desc = 'Grip lost on loose ground like dirt, grass and sand. Lower = better off-road. 1.0 is normal.' },
        },
    },
    {
        name = 'Suspension',
        intro = 'Springs, dampers, ride height and body roll.',
        fields = {
            { name = 'fSuspensionForce',       type = 'float', min = 0,  max = 10, step = 0.01,  label = 'Spring stiffness',
              lo = 'softer', hi = 'stiffer',
              desc = 'Higher = firmer ride and less body movement.' },
            { name = 'fSuspensionCompDamp',    type = 'float', min = 0,  max = 10, step = 0.001, label = 'Bump damping',
              lo = 'soft', hi = 'firm',
              desc = 'Damping as the spring squashes, like when you hit a bump. Higher = firmer over bumps.' },
            { name = 'fSuspensionReboundDamp', type = 'float', min = 0,  max = 10, step = 0.001, label = 'Rebound damping',
              lo = 'bouncy', hi = 'settled',
              desc = 'Damping as the spring extends again. Higher = settles faster and bounces less.' },
            { name = 'fSuspensionUpperLimit',  type = 'float', min = -1, max = 1,  step = 0.005, label = 'Travel up',
              lo = 'less', hi = 'more',
              desc = 'How far the wheel can move up into the body.' },
            { name = 'fSuspensionLowerLimit',  type = 'float', min = -1, max = 1,  step = 0.005, label = 'Travel down',
              lo = 'more droop', hi = 'less droop',
              desc = 'How far the wheel can drop. Usually negative; more negative = more droop, which helps off-road.' },
            { name = 'fSuspensionRaise',       type = 'float', min = -1, max = 1,  step = 0.005, label = 'Ride height',
              lo = 'lower', hi = 'higher',
              desc = 'Positive raises the car, negative lowers it.' },
            { name = 'fSuspensionBiasFront',   type = 'float', min = 0,  max = 1,  step = 0.01,  label = 'Spring bias front',
              lo = 'stiffer rear', hi = 'stiffer front',
              desc = 'How spring stiffness is split. 0.5 = even.' },
            { name = 'fAntiRollBarForce',      type = 'float', min = 0,  max = 10, step = 0.01,  label = 'Anti-roll bar',
              lo = 'more lean', hi = 'less lean',
              desc = 'Higher = less body lean in corners.' },
            { name = 'fAntiRollBarBiasFront',  type = 'float', min = 0,  max = 1,  step = 0.01,  label = 'Anti-roll bias front',
              lo = 'more rear', hi = 'more front',
              desc = 'How the anti-roll bar is split. More front tends to push wide, more rear tends to let the back slide.' },
            { name = 'fRollCentreHeightFront', type = 'float', min = -1, max = 1,  step = 0.005, label = 'Roll centre front',
              lo = 'more roll', hi = 'less roll',
              desc = 'Higher = less body roll at the front; too high feels skittish.' },
            { name = 'fRollCentreHeightRear',  type = 'float', min = -1, max = 1,  step = 0.005, label = 'Roll centre rear',
              lo = 'more roll', hi = 'less roll',
              desc = 'Higher = less body roll at the rear; too high feels skittish.' },
        },
    },
    {
        name = 'Damage',
        intro = 'How much damage the car takes. 1.0 is normal for each of these.',
        fields = {
            { name = 'fCollisionDamageMult',   type = 'float', min = 0, max = 10,  step = 0.01, label = 'Crash damage',
              lo = 'tougher', hi = 'more fragile',
              desc = 'Damage taken from crashes.' },
            { name = 'fWeaponDamageMult',      type = 'float', min = 0, max = 10,  step = 0.01, label = 'Weapon damage',
              lo = 'tougher', hi = 'more fragile',
              desc = 'Damage taken from gunfire and explosions.' },
            { name = 'fDeformationDamageMult', type = 'float', min = 0, max = 10,  step = 0.01, label = 'Body crumple',
              lo = 'less', hi = 'more',
              desc = 'How much the body visibly dents and crumples.' },
            { name = 'fEngineDamageMult',      type = 'float', min = 0, max = 10,  step = 0.01, label = 'Engine damage',
              lo = 'tougher', hi = 'more fragile',
              desc = 'How much engine health each hit takes off.' },
            { name = 'fPetrolTankVolume',      type = 'float', min = 0, max = 500, step = 1,    label = 'Fuel tank size',
              lo = 'smaller', hi = 'bigger', apply = 'spawn',
              desc = 'Fuel tank size. Fuel leaks out when the tank is shot.' },
            { name = 'fOilVolume',             type = 'float', min = 0, max = 50,  step = 0.1,  label = 'Oil volume',
              lo = 'less', hi = 'more', apply = 'spawn',
              desc = 'Oil capacity. Affects how long a damaged engine keeps running.' },
        },
    },
    {
        name = 'Misc',
        intro = 'Driver seat position and the car\'s value.',
        fields = {
            { name = 'fSeatOffsetDistX', type = 'float', min = -2, max = 2,        step = 0.01, label = 'Seat left / right',
              lo = 'left', hi = 'right', apply = 'spawn',
              desc = 'Moves the driver seat sideways.' },
            { name = 'fSeatOffsetDistY', type = 'float', min = -2, max = 2,        step = 0.01, label = 'Seat back / forward',
              lo = 'back', hi = 'forward', apply = 'spawn',
              desc = 'Moves the driver seat forward or back.' },
            { name = 'fSeatOffsetDistZ', type = 'float', min = -2, max = 2,        step = 0.01, label = 'Seat down / up',
              lo = 'down', hi = 'up', apply = 'spawn',
              desc = 'Moves the driver seat up or down.' },
            { name = 'nMonetaryValue',   type = 'int',   min = 0,  max = 10000000, step = 1000, label = 'Value ($)',
              apply = 'none',
              desc = 'Base value of the car, used for things like insurance and mod prices. Doesn\'t change how it drives.' },
        },
    },
    {
        name = 'Flags (file only)',
        intro = 'Switches for special behaviour. These can\'t be tried live: save, restart the vehicle\'s pack, then respawn the car.',
        fields = {
            { name = 'strModelFlags',    type = 'flags',  label = 'Model flags (hex)', bits = ModelFlagBits, apply = 'file',
              desc = 'Model behaviour: axle types, ABS, exhausts, wheel options.' },
            { name = 'strHandlingFlags', type = 'flags',  label = 'Handling flags (hex)', bits = HandlingFlagBits, apply = 'file',
              desc = 'Handling behaviour: rear-wheel steering, CVT, off-road abilities, armour.' },
            { name = 'strDamageFlags',   type = 'flags',  label = 'Damage flags (hex)', bits = DamageFlagBits, apply = 'file',
              desc = 'Doors, bonnet and boot that can\'t break off.' },
            { name = 'AIHandling',       type = 'string', label = 'AI handling', apply = 'file',
              options = { 'AVERAGE', 'SPORTS_CAR', 'TRUCK', 'CRAP' },
              desc = 'How AI drivers handle this vehicle.' },
        },
    },
}

Handling.ByName = {}
for _, group in ipairs(Handling.Groups) do
    for _, field in ipairs(group.fields) do
        Handling.ByName[field.name] = field
    end
end
