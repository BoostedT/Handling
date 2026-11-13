-- Live handling editor: reads/writes the CURRENT vehicle's handling via the
-- SET/GET_VEHICLE_HANDLING_* natives (per-instance, so nothing else on the
-- server is affected while you tune), and hands the final values to the
-- server to patch straight into the resource's handling.meta on save.

local currentVehicle = nil
local currentHandlingName = nil
local nuiOpen = false
local nuiFocused = false -- false = panel still visible but mouse/keys go to the game
local fileBaseline = nil

-- What the server says our role can do (server/permissions.lua). Asked for
-- every time the panel opens, and pushed again if someone changes our role.
-- The server checks every request itself; this only decides what to show.
local Access = { perms = {} }
local accessPending = 0 -- GetGameTimer() of an unanswered request, 0 = none

local function can(perm)
    return type(Access.perms) == 'table' and Access.perms[perm] == true
end

-- Off-road / Crawling tabs (see the bottom of this file).
local terrainWatch = false -- the panel is showing a tab with the live terrain readout
local dynWatch = false     -- ...or one with the driving-dynamics readout (g-forces, braking, drift)
local terrainBest = { artic = 0.0, pitch = 0.0, roll = 0.0 }
local aidStatus = { governor = false, crawl = false, hillHold = false }
local Aids = { lowRange = false, ratio = 2.7, cap = 30.0, crawl = false, crawlSpeed = 4.0, hillHold = false }

local function resetAids()
    Aids.lowRange, Aids.crawl, Aids.hillHold = false, false, false
    terrainWatch = false
    dynWatch = false
end

local function getFieldValue(vehicle, field)
    if field.type == 'float' then
        return GetVehicleHandlingFloat(vehicle, 'CHandlingData', field.name)
    elseif field.type == 'int' then
        return GetVehicleHandlingInt(vehicle, 'CHandlingData', field.name)
    elseif field.type == 'vector' then
        local v = GetVehicleHandlingVector(vehicle, 'CHandlingData', field.name)
        return { x = v.x, y = v.y, z = v.z }
    end
    -- flags/string fields aren't exposed as live numeric/vector natives;
    -- they're file-only and take effect after the vehicle resource restarts.
    return nil
end

local function setFieldValueLive(vehicle, field, value)
    if not DoesEntityExist(vehicle) then return end
    if field.type == 'float' then
        local n = tonumber(value)
        if n then SetVehicleHandlingFloat(vehicle, 'CHandlingData', field.name, n) end
    elseif field.type == 'int' then
        local n = tonumber(value)
        if n then SetVehicleHandlingInt(vehicle, 'CHandlingData', field.name, math.floor(n)) end
    elseif field.type == 'vector' then
        if type(value) == 'table' then
            local x = tonumber(value.x) or 0.0
            local y = tonumber(value.y) or 0.0
            local z = tonumber(value.z) or 0.0
            SetVehicleHandlingVector(vehicle, 'CHandlingData', field.name, vector3(x, y, z))
        end
    end
end

-- ---- Pickups & trucks: bed load test (live only) ---------------------------
-- Adds weight to the vehicle you're in, and (if it sits in the bed) moves the
-- centre of mass back and up by the load's share of the total mass. The real
-- values are kept in Payload.base while loaded; edits to fMass / centre of mass
-- update that base instead, so saving never writes the extra load. Unloaded
-- when the editor closes.

local Payload = { kg = 0.0, bed = true, base = nil, vehicle = nil }

local function applyPayload()
    local vehicle, base = Payload.vehicle, Payload.base
    if not base or not vehicle or not DoesEntityExist(vehicle) then return end
    local share = Payload.kg / (base.mass + Payload.kg)
    local dy, dz = 0.0, 0.0
    if Payload.bed then dy, dz = -1.6 * share, 0.35 * share end -- load sits over/behind the rear axle
    SetVehicleHandlingFloat(vehicle, 'CHandlingData', 'fMass', base.mass + Payload.kg)
    SetVehicleHandlingVector(vehicle, 'CHandlingData', 'vecCentreOfMassOffset',
        vector3(base.com.x, base.com.y + dy, base.com.z + dz))
end

local function unloadPayload()
    local vehicle, base = Payload.vehicle, Payload.base
    if base and vehicle and DoesEntityExist(vehicle) then
        SetVehicleHandlingFloat(vehicle, 'CHandlingData', 'fMass', base.mass)
        SetVehicleHandlingVector(vehicle, 'CHandlingData', 'vecCentreOfMassOffset', vector3(base.com.x, base.com.y, base.com.z))
    end
    Payload.kg, Payload.base, Payload.vehicle = 0.0, nil, nil
end

-- Live edits to the two fields the load touches go into the base instead.
-- Returns true when it handled the value.
local function payloadIntercept(vehicle, fieldName, value)
    if not Payload.base or vehicle ~= Payload.vehicle then return false end
    if fieldName == 'fMass' and tonumber(value) then
        Payload.base.mass = tonumber(value)
    elseif fieldName == 'vecCentreOfMassOffset' and type(value) == 'table' then
        Payload.base.com = { x = tonumber(value.x) or 0.0, y = tonumber(value.y) or 0.0, z = tonumber(value.z) or 0.0 }
    else
        return false
    end
    applyPayload()
    return true
end

-- ---- Keeping live edits on the car -------------------------------------------
-- Other scripts write some of the same handling values: RealisticVehicleFailure
-- sets brake force every frame, op-mechanic tuning kits multiply or overwrite
-- power, shifting, top speed, grip, brakes and drive bias (escrowed, so it can't
-- be told about edits), and Boosted-Offroad scales grip loss on loose ground.
-- So the editor:
--   * tells other scripts about every live edit with a local client event, so a
--     script that keeps its own copy of a value can adopt the edit:
--         AddEventHandler('handling_editor:applied', function(vehicle, values) end)
--     `values` is { fieldName = value } in handling.meta units.
--   * remembers what it put on the car and puts it back if something else
--     changes it while the panel is open, except for fields a running script
--     already builds on by itself (adoptedBy).
--   * refreshes the gearbox after power / gear / top speed edits, which the
--     game otherwise only works out when the car spawns.

local Held = { vehicle = nil, values = {}, echo = {}, fights = {} }

local function clearHeld(vehicle)
    Held.vehicle, Held.values, Held.echo, Held.fights = vehicle, {}, {}, {}
end

-- Fields a running script adjusts on top of whatever value it last saw, so the
-- editor leaves them alone instead of fighting it.
local function adoptedBy(fieldName)
    if (fieldName == 'fTractionLossMult' or fieldName == 'fLowSpeedTractionLossMult')
        and GetResourceState('Boosted-Offroad') == 'started' then
        return 'Boosted-Offroad'
    end
    if fieldName == 'fBrakeForce' and GetResourceState('RealisticVehicleFailure') == 'started' then
        return 'RealisticVehicleFailure'
    end
    return nil
end

local function adoptedMap()
    local map = {}
    for name in pairs(Handling.ByName) do
        local by = adoptedBy(name)
        if by then map[name] = by end
    end
    return map
end

local function closeEnough(field, a, b)
    if a == nil or b == nil then return a == b end
    if field.type == 'vector' then
        if type(a) ~= 'table' or type(b) ~= 'table' then return false end
        local f = { type = 'float' }
        return closeEnough(f, a.x, b.x) and closeEnough(f, a.y, b.y) and closeEnough(f, a.z, b.z)
    end
    a, b = tonumber(a), tonumber(b)
    if not a or not b then return false end
    return math.abs(a - b) <= 1e-4 + math.abs(b) * 1e-4
end

local function notifyApplied(vehicle, values)
    if next(values) then TriggerEvent('handling_editor:applied', vehicle, values) end
end

-- The game works out gearing and top speed from these when the car spawns.
local GEARBOX = { fInitialDriveMaxFlatVel = true, nInitialDriveGears = true, fInitialDriveForce = true, fDriveInertia = true }
local gearboxDue = 0 -- GetGameTimer() when a pending gearbox refresh runs, 0 = none

-- Boosted-TunerMenu keeps its top-speed tune (a %, 0 = none) in this state bag.
local function topSpeedTune(vehicle)
    local ok, tune = pcall(function() return Entity(vehicle).state.boostedTune end)
    if ok and type(tune) == 'table' and tonumber(tune.topSpeed) then return tonumber(tune.topSpeed) + 0.0 end
    return 0.0
end

local function refreshGearbox(vehicle)
    if not vehicle or not DoesEntityExist(vehicle) then return end
    local gears = GetVehicleHandlingInt(vehicle, 'CHandlingData', 'nInitialDriveGears')
    if SetVehicleHighGear and gears and gears >= 1 then SetVehicleHighGear(vehicle, gears) end
    -- Setting the top speed modifier makes the game recalculate top speed and
    -- gearing from the handling values. It's the same value Boosted-TunerMenu
    -- sets (0 on untuned cars), so a tune stays as it was.
    ModifyVehicleTopSpeed(vehicle, topSpeedTune(vehicle))
    -- Whatever the car reads back now is our own doing, not another script's.
    if Held.vehicle == vehicle then
        for name in pairs(GEARBOX) do
            local field = Handling.ByName[name]
            if field and Held.values[name] ~= nil then Held.echo[name] = getFieldValue(vehicle, field) end
        end
    end
end

-- Puts one edited value on the car and remembers it. Returns false when the
-- pickup load test took it instead (that keeps its own base values).
local function applyEdit(vehicle, field, value)
    if Held.vehicle ~= vehicle then clearHeld(vehicle) end
    if payloadIntercept(vehicle, field.name, value) then return false end
    setFieldValueLive(vehicle, field, value)
    Held.values[field.name] = value
    Held.echo[field.name] = getFieldValue(vehicle, field)
    Held.fights[field.name] = nil
    if GEARBOX[field.name] then gearboxDue = GetGameTimer() + 250 end
    return true
end

-- Game vehicle classes that make sense to bulk-edit (GET_VEHICLE_CLASS ids).
-- Cycles, boats, planes, helicopters and trains are left out: their handling
-- lives mostly in SubHandlingData, which this editor doesn't cover.
local ClassNames = {
    [0] = 'Compacts', [1] = 'Sedans', [2] = 'SUVs', [3] = 'Coupes', [4] = 'Muscle',
    [5] = 'Sports Classics', [6] = 'Sports', [7] = 'Super', [8] = 'Motorcycles',
    [9] = 'Off-road', [10] = 'Industrial', [11] = 'Utility', [12] = 'Vans',
    [17] = 'Service', [18] = 'Emergency', [19] = 'Military', [20] = 'Commercial',
    [22] = 'Open Wheel',
}

-- The vehicles vMenu lists under "Addon Vehicles" (its config/addons.json),
-- keeping only models that are actually streamed, same as vMenu does. Returns
-- nil if vMenu or its addons.json can't be read.
local function vMenuAddonModels()
    local raw = LoadResourceFile('vMenu', 'config/addons.json')
    if not raw then return nil end
    local ok, data = pcall(json.decode, raw)
    if not ok or type(data) ~= 'table' or type(data.vehicles) ~= 'table' then return nil end

    local seen, list = {}, {}
    for _, model in ipairs(data.vehicles) do
        if type(model) == 'string' and not seen[model:lower()] and IsModelInCdimage(GetHashKey(model)) then
            seen[model:lower()] = true
            list[#list + 1] = model
        end
    end
    return list
end

-- classId -> { model names }. Whole-class edits use vMenu's categories: the
-- addons.json vehicles grouped by game class, exactly like vMenu's Addon
-- Vehicles menu. `allModels` = true (or vMenu unavailable) falls back to every
-- vehicle model the game knows about.
local function buildClassIndex(allModels)
    local models = not allModels and vMenuAddonModels() or GetAllVehicleModels()
    local index = {}
    for _, model in ipairs(models) do
        if type(model) == 'string' then
            local classId = GetVehicleClassFromName(GetHashKey(model))
            if ClassNames[classId] then
                local list = index[classId]
                if not list then
                    list = {}
                    index[classId] = list
                end
                list[#list + 1] = model
            end
        end
    end
    return index
end

local function buildClassList(index)
    local list = {}
    for id = 0, 22 do
        if ClassNames[id] and index[id] then
            list[#list + 1] = { id = id, name = ClassNames[id], count = #index[id] }
        end
    end
    return list
end

-- Every model across every editable class, flattened and deduped. Used to ask
-- the server which of them live in one specific resource (the Presets tab's
-- "Apply to another vehicle" picker).
local function allKnownModels()
    local seen, list = {}, {}
    for _, models in pairs(buildClassIndex(true)) do
        for _, model in ipairs(models) do
            if not seen[model] then
                seen[model] = true
                list[#list + 1] = model
            end
        end
    end
    return list
end

-- Live-applies the given field values to every spawned vehicle whose model is
-- in `models` (the scoped list the server confirmed for this class).
local function applyLiveToClass(models, values)
    local wanted = {}
    for _, model in ipairs(models) do wanted[GetHashKey(model)] = true end

    local count = 0
    for _, vehicle in ipairs(GetGamePool('CVehicle')) do
        if DoesEntityExist(vehicle) and wanted[GetEntityModel(vehicle)] then
            local applied, gearbox = {}, false
            for fieldName, value in pairs(values) do
                local field = Handling.ByName[fieldName]
                if field and field.type ~= 'flags' and field.type ~= 'string' then
                    if vehicle == currentVehicle then
                        applyEdit(vehicle, field, value) -- also kept on the car while the panel is open
                    else
                        setFieldValueLive(vehicle, field, value)
                    end
                    applied[fieldName] = value
                    if GEARBOX[fieldName] then gearbox = true end
                end
            end
            if gearbox then refreshGearbox(vehicle) end
            notifyApplied(vehicle, applied)
            count = count + 1
        end
    end
    if Payload.base then
        if values.fMass ~= nil then payloadIntercept(Payload.vehicle, 'fMass', values.fMass) end
        if values.vecCentreOfMassOffset ~= nil then payloadIntercept(Payload.vehicle, 'vecCentreOfMassOffset', values.vecCentreOfMassOffset) end
        applyPayload()
    end
    return count
end

local function buildLiveSnapshot(vehicle)
    local snapshot = {}
    for _, group in ipairs(Handling.Groups) do
        for _, field in ipairs(group.fields) do
            local v = getFieldValue(vehicle, field)
            if v ~= nil then
                snapshot[field.name] = v
            end
        end
    end
    return snapshot
end

-- With focus the cursor is usable but the game camera/controls are frozen;
-- without it the panel stays on screen and you can look around and drive.
local function setFocus(focused)
    nuiFocused = focused
    SetNuiFocus(focused, focused)
    SendNUIMessage({ action = 'focus', focused = focused })
end

local function closeEditor()
    if not nuiOpen then return end
    nuiOpen = false
    nuiFocused = false
    resetAids() -- aids only run while the editor is open
    unloadPayload()
    -- Edits stay on the car; the editor just stops guarding them.
    if gearboxDue ~= 0 then refreshGearbox(currentVehicle) end
    gearboxDue = 0
    clearHeld(nil)
    SetNuiFocus(false, false)
    SendNUIMessage({ action = 'close' })
    TriggerServerEvent('handling_editor:closed')
end

local function chat(text)
    TriggerEvent('chat:addMessage', { args = { '^1Handling Editor', text } })
end

local function noAccessText()
    if not Access.discord then
        return 'You don\'t have access to the handling editor. Access is by Discord ID, and the server can\'t see yours: have Discord open before you connect.'
    end
    return ('You don\'t have access to the handling editor (your Discord ID is %s).'):format(Access.discord)
end

-- Checks we're driving something; returns the vehicle or nil (after telling the player why).
local function driverVehicle()
    local ped = PlayerPedId()
    if not IsPedInAnyVehicle(ped, false) then
        chat('Get in a vehicle first.')
        return nil
    end
    local vehicle = GetVehiclePedIsIn(ped, false)
    if GetPedInVehicleSeat(vehicle, -1) ~= ped then
        chat('You need to be in the driver seat.')
        return nil
    end
    return vehicle
end

local function showEditor()
    local vehicle = driverVehicle()
    if not vehicle then return end

    currentVehicle = vehicle
    fileBaseline = nil
    clearHeld(vehicle)
    local modelName = GetEntityArchetypeName(vehicle)
    currentHandlingName = modelName and modelName:upper() or nil

    if not currentHandlingName then
        chat('Could not resolve this vehicle\'s model name.')
        return
    end

    local displayName = GetLabelText(GetDisplayNameFromVehicleModel(GetEntityModel(vehicle)))
    if not displayName or displayName == 'NULL' then displayName = modelName end

    nuiOpen = true
    SendNUIMessage({
        action = 'open',
        groups = Handling.Groups,
        handlingName = currentHandlingName,
        displayName = displayName,
        live = buildLiveSnapshot(vehicle),
        classes = buildClassList(buildClassIndex()),
        classId = GetVehicleClass(vehicle),
        access = Access,
        adopted = adoptedMap(),
    })
    setFocus(true)

    TriggerServerEvent('handling_editor:requestFile', currentHandlingName)
end

-- F6: ask the server what our role allows, then open (see handling_editor:perms).
local function openEditor()
    -- Already open: the keybind just takes the mouse back from the game.
    if nuiOpen then
        if not nuiFocused then setFocus(true) end
        return
    end
    if not driverVehicle() then return end
    if accessPending ~= 0 and GetGameTimer() - accessPending < 5000 then return end
    accessPending = GetGameTimer()
    TriggerServerEvent('handling_editor:hello')
end

RegisterNetEvent('handling_editor:perms')
AddEventHandler('handling_editor:perms', function(info)
    if type(info) ~= 'table' then return end
    if type(info.perms) ~= 'table' then info.perms = {} end
    Access = info
    local wanted = accessPending ~= 0
    accessPending = 0

    if nuiOpen then
        -- Someone changed our role while the panel is up.
        if not can('open') then
            closeEditor()
            chat('Your handling editor access was removed.')
            return
        end
        if not can('tools') then resetAids() end
        SendNUIMessage({ action = 'access', access = Access })
        return
    end

    if wanted then
        if not can('open') then
            chat(noAccessText())
        else
            showEditor()
        end
    end
end)

RegisterCommand('handlingeditor', openEditor, false)
RegisterKeyMapping('handlingeditor', 'Open live handling editor', 'keyboard', 'F6')

RegisterNUICallback('close', function(_, cb)
    closeEditor()
    cb('ok')
end)

RegisterNUICallback('releaseFocus', function(_, cb)
    if nuiOpen then setFocus(false) end
    cb('ok')
end)

-- Local event from client/freecam.lua: the camera needs the mouse.
AddEventHandler('handling_editor:releaseFocus', function()
    if nuiOpen and nuiFocused then setFocus(false) end
end)

RegisterNUICallback('live', function(data, cb)
    local vehicle = currentVehicle
    if vehicle and DoesEntityExist(vehicle) and data and data.field then
        local field = Handling.ByName[data.field]
        if field and field.type ~= 'flags' and field.type ~= 'string' then
            applyEdit(vehicle, field, data.value)
            notifyApplied(vehicle, { [field.name] = data.value })
        end
    end
    cb('ok')
end)

local function applyFileToVehicle()
    local vehicle = currentVehicle
    if not vehicle or not fileBaseline or not DoesEntityExist(vehicle) then return end
    local applied = {}
    for fieldName, value in pairs(fileBaseline) do
        local field = Handling.ByName[fieldName]
        if field and field.type ~= 'flags' and field.type ~= 'string' then
            applyEdit(vehicle, field, value)
            applied[fieldName] = value
        end
    end
    if Payload.base then applyPayload() end
    notifyApplied(vehicle, applied)
    SendNUIMessage({ action = 'appliedBaseline', values = fileBaseline })
end

RegisterNUICallback('resetToFile', function(_, cb)
    applyFileToVehicle()
    cb('ok')
end)

RegisterNUICallback('resetToLive', function(_, cb)
    if currentVehicle then
        clearHeld(currentVehicle) -- the panel now shows what the car has, so there's nothing to guard
        local snapshot = buildLiveSnapshot(currentVehicle)
        if Payload.base and currentVehicle == Payload.vehicle then
            snapshot.fMass = Payload.base.mass
            snapshot.vecCentreOfMassOffset = Payload.base.com
        end
        SendNUIMessage({ action = 'appliedBaseline', values = snapshot })
    end
    cb('ok')
end)

-- apply = true (after a restore): once the file is re-read, put its values on
-- the car too, so you can drive the restored version straight away.
local applyFileOnLoad = false

RegisterNUICallback('reloadFile', function(data, cb)
    local handlingName = data and data.handlingName
    if type(handlingName) == 'string' and #handlingName > 0 then
        currentHandlingName = handlingName:upper()
        applyFileOnLoad = data.apply == true
        TriggerServerEvent('handling_editor:requestFile', currentHandlingName)
    end
    cb('ok')
end)

-- ---- requests from the panel's newer tabs (History, Access, shared presets,
-- locks): passed straight to the server, which checks the role and answers.

RegisterNUICallback('rpc', function(data, cb)
    cb('ok')
    if type(data) ~= 'table' or type(data.name) ~= 'string' then return end
    TriggerServerEvent('handling_editor:rpc', tonumber(data.id) or 0, data.name, type(data.args) == 'table' and data.args or {})
end)

RegisterNetEvent('handling_editor:rpcResult')
AddEventHandler('handling_editor:rpcResult', function(id, name, result)
    SendNUIMessage({ action = 'rpc', id = id, name = name, result = result })
end)

-- Someone else saved, restored or (un)locked the vehicle we have open.
RegisterNetEvent('handling_editor:changed')
AddEventHandler('handling_editor:changed', function(info)
    if not nuiOpen or not currentHandlingName then return end
    SendNUIMessage({ action = 'externalChange', message = type(info) == 'table' and info.message or nil })
    TriggerServerEvent('handling_editor:requestFile', currentHandlingName)
end)

-- Panel's "Keep .bak backup" checkbox; sent along with every save.
local makeBackup = false

RegisterNUICallback('setBackup', function(data, cb)
    makeBackup = type(data) == 'table' and data.enabled == true
    cb('ok')
end)

RegisterNUICallback('save', function(data, cb)
    if currentHandlingName and data and data.values then
        TriggerServerEvent('handling_editor:save', currentHandlingName, data.values, makeBackup)
    end
    cb('ok')
end)

-- Class-wide actions are scoped: a class plus an optional resource (nil = every
-- resource). The server tells us which models in that class really have a
-- handling.meta entry in scope; that confirmed list is what both the live
-- apply and the save use, so they always touch the same vehicles.
local classScope = nil      -- { classId, resource, models } once the server has answered
local scopeRequestId = 0

local function normaliseResource(r)
    if type(r) == 'string' and #r > 0 then return r end
    return nil
end

local function classResult(ok, message)
    SendNUIMessage({ action = 'saveResult', result = { ok = ok, message = message } })
end

-- The scope the NUI is asking to act on, or nil if it doesn't match what the
-- server last confirmed (e.g. the dropdown changed since the summary was shown).
local function confirmedScope(data)
    if type(data) ~= 'table' or type(data.values) ~= 'table' then return nil end
    local classId = tonumber(data.classId)
    local resource = normaliseResource(data.resource)
    if not classScope or classScope.classId ~= classId or classScope.resource ~= resource then
        return nil
    end
    return classScope
end

local pendingScope = nil -- { requestId, classId, resource }

RegisterNUICallback('classScope', function(data, cb)
    local classId = type(data) == 'table' and tonumber(data.classId) or nil
    if not classId or not ClassNames[classId] then
        SendNUIMessage({ action = 'classScope', ok = false, message = 'Invalid class request.' })
        cb('ok')
        return
    end

    scopeRequestId = scopeRequestId + 1
    pendingScope = { requestId = scopeRequestId, classId = classId, resource = normaliseResource(data.resource) }
    classScope = nil
    TriggerServerEvent('handling_editor:classScope', scopeRequestId, pendingScope.resource, buildClassIndex()[classId] or {})
    cb('ok')
end)

RegisterNetEvent('handling_editor:classScopeResult')
AddEventHandler('handling_editor:classScopeResult', function(result)
    if not nuiOpen or not pendingScope or type(result) ~= 'table' or result.requestId ~= pendingScope.requestId then
        return -- stale answer for a scope the user has already moved on from
    end
    local scope = pendingScope
    pendingScope = nil

    if not result.ok then
        SendNUIMessage({ action = 'classScope', ok = false, message = result.message })
        return
    end

    classScope = { classId = scope.classId, resource = scope.resource, models = result.models or {} }

    -- Spawn name plus the in-game display name (when the pack provides one), so
    -- the list the user picks from is readable.
    local list = {}
    for _, model in ipairs(classScope.models) do
        local label
        local text = GetLabelText(GetDisplayNameFromVehicleModel(GetHashKey(model)))
        if text and text ~= 'NULL' and text:lower() ~= model:lower() then label = text end
        list[#list + 1] = { name = model, label = label }
    end

    SendNUIMessage({
        action = 'classScope', ok = true,
        classId = scope.classId, resource = scope.resource, count = #list, models = list,
    })
end)

-- The models the user left ticked. Always a subset of what the server
-- confirmed, so the NUI can't smuggle in a model that wasn't in scope.
local function selectedModels(scope, requested)
    if type(requested) ~= 'table' then return scope.models end
    local wanted = {}
    for _, name in ipairs(requested) do
        if type(name) == 'string' then wanted[name] = true end
    end
    local out = {}
    for _, model in ipairs(scope.models) do
        if wanted[model] then out[#out + 1] = model end
    end
    return out
end

RegisterNUICallback('classLive', function(data, cb)
    local scope = confirmedScope(data)
    if not can('bulk') then
        classResult(false, 'Your handling editor role doesn\'t allow that.')
    elseif not scope then
        classResult(false, 'Scope changed since the summary was shown. Click "Apply changes..." again.')
    else
        local models = selectedModels(scope, data.models)
        if #models == 0 then
            classResult(false, 'No vehicles selected.')
        else
            local count = applyLiveToClass(models, data.values)
            classResult(true, ('Applied live to %d spawned vehicle%s (of %d selected %s model%s). New spawns keep the file values until you save.'):format(
                count, count == 1 and '' or 's', #models, ClassNames[scope.classId], #models == 1 and '' or 's'))
        end
    end
    cb('ok')
end)

RegisterNUICallback('classSave', function(data, cb)
    local scope = confirmedScope(data)
    if not scope then
        classResult(false, 'Scope changed since the summary was shown. Click "Apply changes..." again.')
    else
        local models = selectedModels(scope, data.models)
        if #models == 0 then
            classResult(false, 'No vehicles selected.')
        else
            applyLiveToClass(models, data.values)
            TriggerServerEvent('handling_editor:saveClass', ClassNames[scope.classId], models, data.values, scope.resource, makeBackup)
        end
    end
    cb('ok')
end)

-- ---- Presets tab: "Apply to another vehicle" -----------------------------
-- Separate request-id/state from the whole-class scope flow above so the two
-- pickers (class-wide vs. single alternate vehicle) can't stomp on each other.

local vehicleListRequestId = 0
local pendingVehicleList = nil -- { requestId, resource }

RegisterNUICallback('listVehicles', function(data, cb)
    local resource = normaliseResource(data and data.resource)
    if not resource then
        SendNUIMessage({ action = 'vehicleList', ok = false, message = 'No source resource known yet for this vehicle.' })
        cb('ok')
        return
    end
    vehicleListRequestId = vehicleListRequestId + 1
    pendingVehicleList = { requestId = vehicleListRequestId, resource = resource }
    TriggerServerEvent('handling_editor:listVehicles', vehicleListRequestId, resource, allKnownModels())
    cb('ok')
end)

RegisterNetEvent('handling_editor:listVehiclesResult')
AddEventHandler('handling_editor:listVehiclesResult', function(result)
    if not nuiOpen or not pendingVehicleList or type(result) ~= 'table' or result.requestId ~= pendingVehicleList.requestId then
        return -- stale answer for a resource the user has already moved on from
    end
    pendingVehicleList = nil

    if not result.ok then
        SendNUIMessage({ action = 'vehicleList', ok = false, message = result.message })
        return
    end

    local list = {}
    for _, model in ipairs(result.models or {}) do
        local label
        local text = GetLabelText(GetDisplayNameFromVehicleModel(GetHashKey(model)))
        if text and text ~= 'NULL' and text:lower() ~= model:lower() then label = text end
        list[#list + 1] = { name = model, label = label }
    end

    SendNUIMessage({ action = 'vehicleList', ok = true, resource = result.resource, models = list })
end)

-- Applies a preset's (numeric-only) fields straight to another vehicle model:
-- live, for any already-spawned instance of it, and to its handling.meta on
-- disk, since there's no "current vehicle" to preview on before saving.
RegisterNUICallback('applyPresetToVehicle', function(data, cb)
    local model = data and data.model
    local resource = normaliseResource(data and data.resource)
    local values = data and data.values
    if type(model) ~= 'string' or model == '' or type(values) ~= 'table' then
        cb('ok')
        return
    end
    applyLiveToClass({ model }, values)
    TriggerServerEvent('handling_editor:saveClass', (data.presetName or 'preset'), { model }, values, resource, makeBackup)
    cb('ok')
end)

RegisterNetEvent('handling_editor:fileResult')
AddEventHandler('handling_editor:fileResult', function(result)
    if not nuiOpen then return end
    local apply = applyFileOnLoad
    applyFileOnLoad = false
    if result and result.ok then
        fileBaseline = result.values
    end
    SendNUIMessage({ action = 'fileResult', result = result })
    if apply and result and result.ok then applyFileToVehicle() end
end)

RegisterNetEvent('handling_editor:saveResult')
AddEventHandler('handling_editor:saveResult', function(result)
    if not nuiOpen then return end
    SendNUIMessage({ action = 'saveResult', result = result })
    -- The file on disk just changed: re-read it so "file:" values, the diff
    -- markers and "Reset to file" all reflect what was actually written.
    if type(result) == 'table' and result.ok and currentHandlingName then
        TriggerServerEvent('handling_editor:requestFile', currentHandlingName)
    end
end)

-- ---- Tools: repair / flip ---------------------------------------------------
-- Needs the `tools` permission, so the panel isn't a free repair button.

local function applyValues(vehicle, values)
    if type(values) ~= 'table' then return end
    for fieldName, value in pairs(values) do
        local field = Handling.ByName[fieldName]
        if field and field.type ~= 'flags' and field.type ~= 'string' then
            setFieldValueLive(vehicle, field, value)
        end
    end
end

RegisterNUICallback('tool', function(data, cb)
    cb('ok')
    local vehicle = currentVehicle
    if not vehicle or not DoesEntityExist(vehicle) then return end
    if not can('tools') then
        SendNUIMessage({ action = 'saveResult', result = { ok = false, message = 'Your handling editor role doesn\'t include tools.' } })
        return
    end

    local name = type(data) == 'table' and data.name
    if name == 'repair' then
        SetVehicleFixed(vehicle)
        SetVehicleDeformationFixed(vehicle)
        SetVehicleEngineHealth(vehicle, 1000.0)
        SetVehicleBodyHealth(vehicle, 1000.0)
        SetVehiclePetrolTankHealth(vehicle, 1000.0)
        SetVehicleDirtLevel(vehicle, 0.0)
        -- Re-apply the tune in case the repair put any handling back to defaults.
        applyValues(vehicle, data.values)
        if Payload.base then
            payloadIntercept(vehicle, 'fMass', type(data.values) == 'table' and data.values.fMass)
            applyPayload()
        end
        SendNUIMessage({ action = 'saveResult', result = { ok = true, message = 'Vehicle repaired and cleaned.' } })
    elseif name == 'flip' then
        local heading = GetEntityHeading(vehicle)
        SetEntityRotation(vehicle, 0.0, 0.0, heading, 2, true)
        SetVehicleOnGroundProperly(vehicle)
        SendNUIMessage({ action = 'saveResult', result = { ok = true, message = 'Vehicle set back on its wheels.' } })
    end
end)

-- ---- Telemetry ---------------------------------------------------------------
-- Speed / gear / RPM plus a launch timer, sent to the panel ~10x a second
-- while it's open. A run starts when the car pulls away from a standstill and
-- records 0-60 mph, 0-100 km/h and quarter-mile splits. Braking or lifting
-- noticeably mid-run ends it, so a later re-acceleration isn't timed as a launch.

local MPH60, KMH100, QUARTER_MILE = 26.8224, 27.7778, 402.336 -- m/s, m/s, m
local telemetry = { top = 0.0, best = {} }

-- ---- Driving dynamics (Street & track, Drift, Pickups & trucks tabs) --------
-- g-forces from the change in world velocity projected onto the car's own
-- axes, slip (drift) angle from the local velocity, a drift score, and
-- braking-distance tests that start when you brake through 100 km/h / 60 mph.

local dyn
local BRAKE_TESTS = { b100 = KMH100, b60 = MPH60 }

local function resetDynamics()
    dyn = {
        lat = 0.0, lon = 0.0, peakLat = 0.0, peakBrake = 0.0, peakAccel = 0.0,
        slip = 0.0, peakSlip = 0.0,
        drift = 0.0, driftAngle = 0.0, driftLast = 0.0, driftBest = 0.0, lastDriftAt = 0,
        brakeRuns = {}, brake = {},
    }
end
resetDynamics()

local function updateDynamics(vehicle, speed, now, dt)
    local vel = GetEntityVelocity(vehicle)
    local right, forward = GetEntityMatrix(vehicle)
    local onGround = not IsEntityInAir(vehicle)

    if dyn.prevVel and dt > 0.0 then
        local ax = (vel.x - dyn.prevVel.x) / dt
        local ay = (vel.y - dyn.prevVel.y) / dt
        local az = (vel.z - dyn.prevVel.z) / dt
        local lat = (ax * right.x + ay * right.y + az * right.z) / 9.81
        local lon = (ax * forward.x + ay * forward.y + az * forward.z) / 9.81
        -- Frame-to-frame acceleration is noisy: smooth it, and skip spikes from
        -- crashes and landings.
        if math.abs(lat) < 4.0 and math.abs(lon) < 4.0 then
            dyn.lat = dyn.lat + (lat - dyn.lat) * 0.12
            dyn.lon = dyn.lon + (lon - dyn.lon) * 0.12
        end
        if onGround and speed > 5.0 then
            if math.abs(dyn.lat) > dyn.peakLat then dyn.peakLat = math.abs(dyn.lat) end
            if -dyn.lon > dyn.peakBrake then dyn.peakBrake = -dyn.lon end
            if dyn.lon > dyn.peakAccel then dyn.peakAccel = dyn.lon end
        end
    end
    dyn.prevVel = vel

    -- Slip angle: how far the direction of travel is from where the nose points.
    local lv = GetEntitySpeedVector(vehicle, true)
    local slip = 0.0
    if speed > 3.0 and lv.y > -1.0 then
        slip = math.deg(math.atan(lv.x, math.max(lv.y, 0.01)))
    end
    dyn.slip = slip

    -- Drift score: angle x speed while sliding 10-110 degrees. The run ends
    -- 1.5 s after you straighten up, or straight away if you hit something.
    local angle = math.abs(slip)
    if HasEntityCollidedWithAnything(vehicle) and dyn.drift > 0.0 then
        dyn.drift, dyn.driftAngle = 0.0, 0.0
    elseif onGround and speed > 5.0 and angle >= 10.0 and angle <= 110.0 then
        dyn.drift = dyn.drift + angle * speed * dt * 0.1
        dyn.lastDriftAt = now
        if angle > dyn.driftAngle then dyn.driftAngle = angle end
        if angle > dyn.peakSlip then dyn.peakSlip = angle end
    elseif dyn.drift > 0.0 and now - dyn.lastDriftAt > 1500 then
        dyn.driftLast = dyn.drift
        if dyn.drift > dyn.driftBest then dyn.driftBest = dyn.drift end
        dyn.drift, dyn.driftAngle = 0.0, 0.0
    end

    -- Braking tests: start when the speed drops through the threshold with the
    -- brake held (going forwards), finish at a standstill. Back on the throttle
    -- or speeding up again cancels the run.
    local braking = IsControlPressed(0, 72) and lv.y > 0.0
    for key, threshold in pairs(BRAKE_TESTS) do
        local r = dyn.brakeRuns[key]
        if not r then
            if braking and dyn.prevSpeed and dyn.prevSpeed >= threshold and speed < threshold then
                dyn.brakeRuns[key] = { dist = 0.0 }
            end
        else
            r.dist = r.dist + speed * dt
            if speed < 0.5 then
                local rec = dyn.brake[key] or {}
                rec.last = r.dist
                if not rec.best or r.dist < rec.best then rec.best = r.dist end
                dyn.brake[key] = rec
                dyn.brakeRuns[key] = nil
            elseif IsControlPressed(0, 71) or speed > threshold + 0.5 then
                dyn.brakeRuns[key] = nil
            end
        end
    end
    dyn.prevSpeed = speed
end

local function dynSnapshot()
    return {
        lat = dyn.lat, lon = dyn.lon, peakLat = dyn.peakLat, peakBrake = dyn.peakBrake, peakAccel = dyn.peakAccel,
        slip = dyn.slip, peakSlip = dyn.peakSlip,
        drift = dyn.drift, driftAngle = dyn.driftAngle, driftLast = dyn.driftLast, driftBest = dyn.driftBest,
        braking = next(dyn.brakeRuns) ~= nil,
        b100 = dyn.brake.b100, b60 = dyn.brake.b60,
    }
end

local function resetTelemetry()
    telemetry = { top = 0.0, best = {} }
    terrainBest = { artic = 0.0, pitch = 0.0, roll = 0.0 }
    resetDynamics()
end

-- Per-wheel suspension, wheel spin and body angle for the Off-road and
-- Crawling tabs. Only built while one of those tabs is showing.
local function terrainSnapshot(vehicle, speed)
    local count = math.min(GetVehicleNumberOfWheels(vehicle), 10)
    local wheels, minC, maxC, grounded = {}, nil, nil, 0
    for i = 0, count - 1 do
        local comp = GetVehicleWheelSuspensionCompression(vehicle, i)
        local wheelSpeed = math.abs(GetVehicleWheelSpeed(vehicle, i))
        local air = comp < 0.002
        if not air then grounded = grounded + 1 end
        wheels[#wheels + 1] = { c = comp, air = air, spin = not air and wheelSpeed - speed > 1.5 }
        if not minC or comp < minC then minC = comp end
        if not maxC or comp > maxC then maxC = comp end
    end

    local pitch, roll = GetEntityPitch(vehicle), GetEntityRoll(vehicle)
    local artic = (minC and maxC) and (maxC - minC) or 0.0
    -- Only count angles/articulation with the car actually on the ground, so a
    -- jump or a roll-over doesn't set the record.
    if not IsEntityInAir(vehicle) and grounded >= math.max(count - 1, 1) then
        if artic > terrainBest.artic then terrainBest.artic = artic end
        if math.abs(pitch) > terrainBest.pitch and math.abs(pitch) < 80.0 then terrainBest.pitch = math.abs(pitch) end
        if math.abs(roll) > terrainBest.roll and math.abs(roll) < 80.0 then terrainBest.roll = math.abs(roll) end
    end

    return {
        wheels = wheels, grounded = grounded, pitch = pitch, roll = roll,
        artic = artic, best = terrainBest,
    }
end

RegisterNUICallback('resetTelemetry', function(_, cb)
    resetTelemetry()
    cb('ok')
end)

CreateThread(function()
    local armed, run, lastSend, lastVehicle = false, nil, 0, nil
    while true do
        local vehicle = currentVehicle
        if nuiOpen and vehicle and DoesEntityExist(vehicle) then
            if vehicle ~= lastVehicle then
                lastVehicle = vehicle
                resetTelemetry()
                armed, run = false, nil
            end

            local speed = GetEntitySpeed(vehicle)
            local now = GetGameTimer()
            if speed > telemetry.top then telemetry.top = speed end
            if dynWatch then
                updateDynamics(vehicle, speed, now, GetFrameTime())
            else
                dyn.prevVel, dyn.prevSpeed, dyn.brakeRuns = nil, nil, {}
            end

            if speed < 0.3 then
                armed, run = true, nil
            elseif armed then
                armed = false
                -- Only time launches going forwards, not reversing out of a spot.
                if GetEntitySpeedVector(vehicle, true).y > 0.0 then
                    run = { start = now, dist = 0.0, max = speed }
                    telemetry.lastRun = run
                end
            end

            if run and not run.done then
                run.dist = run.dist + speed * GetFrameTime()
                if speed > run.max then run.max = speed end
                local t = (now - run.start) / 1000.0
                if not run.t60 and speed >= MPH60 then run.t60 = t end
                if not run.t100 and speed >= KMH100 then run.t100 = t end
                if not run.tQuarter and run.dist >= QUARTER_MILE then
                    run.tQuarter, run.trap = t, speed
                end
                if speed < run.max - 1.5 or t > 60.0 or run.tQuarter then
                    run.done = true
                end
                local best = telemetry.best
                for _, key in ipairs({ 't60', 't100', 'tQuarter' }) do
                    if run[key] and (not best[key] or run[key] < best[key]) then
                        best[key] = run[key]
                        if key == 'tQuarter' then best.trap = run.trap end
                    end
                end
            end

            if now - lastSend >= 100 then
                lastSend = now
                local last = telemetry.lastRun
                SendNUIMessage({
                    action = 'telemetry',
                    speed = speed,
                    top = telemetry.top,
                    gear = GetVehicleCurrentGear(vehicle),
                    rpm = GetVehicleCurrentRpm(vehicle),
                    running = run ~= nil and not run.done,
                    elapsed = (run and not run.done) and ((now - run.start) / 1000.0) or nil,
                    run = last and { t60 = last.t60, t100 = last.t100, tQuarter = last.tQuarter, trap = last.trap } or nil,
                    best = telemetry.best,
                    terrain = terrainWatch and terrainSnapshot(vehicle, speed) or nil,
                    dyn = dynWatch and dynSnapshot() or nil,
                    aids = aidStatus,
                })
            end
            Wait(0)
        else
            lastVehicle = nil
            Wait(250)
        end
    end
end)

-- ---- Off-road / Crawling: live driving aids ---------------------------------
-- These never touch handling values and nothing here is saved to a file. They
-- only run while the editor is open (panel focused or released with F6) and
-- switch off when it closes or you leave the vehicle.
--   Low range   - SET_VEHICLE_CHEAT_POWER_INCREASE for crawl torque, plus a
--                 governor that cuts the throttle above a speed cap.
--   Crawl ctrl  - holds a set forward crawl speed with simulated throttle and
--                 brake; you only steer. Holding brake/reverse overrides it.
--   Hill hold   - keeps the handbrake on when stopped on a slope with no pedal.

local function clampNum(n, min, max, fallback)
    n = tonumber(n)
    if not n then return fallback end
    return math.max(min, math.min(max, n))
end

RegisterNUICallback('aids', function(data, cb)
    cb('ok')
    if type(data) ~= 'table' then return end
    if (data.lowRange or data.crawl or data.hillHold) and not can('tools') then
        SendNUIMessage({ action = 'saveResult', result = { ok = false, message = 'Your handling editor role doesn\'t include driving aids.' } })
        SendNUIMessage({ action = 'aidsReset' })
        return
    end
    Aids.lowRange = data.lowRange == true
    Aids.crawl = data.crawl == true
    Aids.hillHold = data.hillHold == true
    Aids.ratio = clampNum(data.ratio, 1.0, 6.0, Aids.ratio)
    Aids.cap = clampNum(data.cap, 5.0, 120.0, Aids.cap)                 -- km/h
    Aids.crawlSpeed = clampNum(data.crawlSpeed, 1.0, 15.0, Aids.crawlSpeed) -- km/h
end)

RegisterNUICallback('liveWatch', function(data, cb)
    terrainWatch = type(data) == 'table' and data.terrain == true
    dynWatch = type(data) == 'table' and data.dyn == true
    cb('ok')
end)

RegisterNUICallback('payload', function(data, cb)
    cb('ok')
    local kg = type(data) == 'table' and tonumber(data.kg) or 0
    kg = math.max(0.0, math.min(5000.0, kg or 0))
    if kg <= 0.0 or not currentVehicle or not DoesEntityExist(currentVehicle) then
        unloadPayload()
        return
    end
    if not Payload.base or Payload.vehicle ~= currentVehicle then
        unloadPayload()
        local com = GetVehicleHandlingVector(currentVehicle, 'CHandlingData', 'vecCentreOfMassOffset')
        Payload.vehicle = currentVehicle
        Payload.base = {
            mass = GetVehicleHandlingFloat(currentVehicle, 'CHandlingData', 'fMass'),
            com = { x = com.x, y = com.y, z = com.z },
        }
    end
    Payload.kg = kg
    Payload.bed = data.bed ~= false
    applyPayload()
end)

RegisterNUICallback('resetDynamics', function(_, cb)
    resetDynamics()
    cb('ok')
end)

RegisterNUICallback('resetTerrain', function(_, cb)
    terrainBest = { artic = 0.0, pitch = 0.0, roll = 0.0 }
    cb('ok')
end)

CreateThread(function()
    local holdingVehicle = nil -- vehicle we put the handbrake on for hill hold
    while true do
        local vehicle = currentVehicle
        local active = nuiOpen and vehicle and DoesEntityExist(vehicle) and (Aids.lowRange or Aids.crawl or Aids.hillHold)

        if active then
            local fwd = GetEntitySpeedVector(vehicle, true).y
            local gas = IsControlPressed(0, 71)   -- INPUT_VEH_ACCELERATE
            local brake = IsControlPressed(0, 72) -- INPUT_VEH_BRAKE (also reverse)
            aidStatus.governor, aidStatus.crawl = false, false

            if Aids.lowRange then
                SetVehicleCheatPowerIncrease(vehicle, Aids.ratio) -- per-frame, so it stops when we stop calling it
                local cap = Aids.cap / 3.6
                if fwd > cap then
                    DisableControlAction(0, 71, true)
                    aidStatus.governor = true
                elseif fwd < -cap then
                    DisableControlAction(0, 72, true)
                    aidStatus.governor = true
                end
            end

            if Aids.crawl and not brake then
                local err = Aids.crawlSpeed / 3.6 - fwd
                if err > 0.05 then
                    SetControlNormal(0, 71, math.min(1.0, 0.25 + err * 0.8))
                elseif err < -0.3 and fwd > 0.3 then
                    SetControlNormal(0, 72, math.min(1.0, -err * 0.8)) -- moving forwards, so this brakes
                end
                aidStatus.crawl = true
            end

            local hold = Aids.hillHold and not aidStatus.crawl and not gas and not brake
                and GetEntitySpeed(vehicle) < 0.4 and math.abs(GetEntityPitch(vehicle)) > 4.0
            if hold then
                SetVehicleHandbrake(vehicle, true)
                holdingVehicle = vehicle
            elseif holdingVehicle then
                SetVehicleHandbrake(holdingVehicle, false)
                holdingVehicle = nil
            end
            aidStatus.hillHold = hold and true or false
            Wait(0)
        else
            if holdingVehicle then
                if DoesEntityExist(holdingVehicle) then SetVehicleHandbrake(holdingVehicle, false) end
                holdingVehicle = nil
            end
            aidStatus.governor, aidStatus.crawl, aidStatus.hillHold = false, false, false
            Wait(200)
        end
    end
end)

-- While the panel is open: run the pending gearbox refresh, put held edits back
-- if another script changed them (every 0.5 s), and send the panel what the car
-- is really running (every 1 s) so it can show "car:" where that differs.
CreateThread(function()
    local tick = 0
    while true do
        local vehicle = currentVehicle
        if nuiOpen and vehicle and DoesEntityExist(vehicle) then
            tick = tick + 1
            if gearboxDue ~= 0 and GetGameTimer() >= gearboxDue then
                gearboxDue = 0
                refreshGearbox(vehicle)
            end

            if tick % 2 == 0 and Held.vehicle == vehicle and next(Held.values) then
                local overwritten, reapplied, gearbox = {}, {}, false
                for name, want in pairs(Held.values) do
                    local field = Handling.ByName[name]
                    local payloadOwned = Payload.base and (name == 'fMass' or name == 'vecCentreOfMassOffset')
                    if field and not payloadOwned and not adoptedBy(name) then
                        local now = getFieldValue(vehicle, field)
                        if not closeEnough(field, now, Held.echo[name]) then
                            setFieldValueLive(vehicle, field, want)
                            Held.echo[name] = getFieldValue(vehicle, field)
                            Held.fights[name] = (Held.fights[name] or 0) + 1
                            overwritten[#overwritten + 1] = { field = name, count = Held.fights[name] }
                            reapplied[name] = want
                            if GEARBOX[name] then gearbox = true end
                        end
                    end
                end
                if gearbox then refreshGearbox(vehicle) end
                if #overwritten > 0 then
                    notifyApplied(vehicle, reapplied)
                    SendNUIMessage({ action = 'liveOverwritten', fields = overwritten })
                end
            end

            if tick % 4 == 0 then
                local snapshot = buildLiveSnapshot(vehicle)
                if Payload.base and vehicle == Payload.vehicle then
                    -- Show the car's own mass / balance, not the test load on top.
                    snapshot.fMass = Payload.base.mass
                    snapshot.vecCentreOfMassOffset = Payload.base.com
                end
                SendNUIMessage({ action = 'carValues', values = snapshot })
            end
            Wait(250)
        else
            tick = 0
            Wait(500)
        end
    end
end)

-- Safety net: if the vehicle disappears or the ped leaves it while the
-- editor is open, drop NUI focus instead of leaving the player stuck.
CreateThread(function()
    while true do
        Wait(500)
        if nuiOpen then
            local ped = PlayerPedId()
            local stillValid = currentVehicle
                and DoesEntityExist(currentVehicle)
                and GetVehiclePedIsIn(ped, false) == currentVehicle
            if not stillValid then
                closeEditor()
            end
        else
            Wait(1000)
        end
    end
end)

AddEventHandler('onResourceStop', function(resourceName)
    if resourceName == GetCurrentResourceName() and nuiOpen then
        SetNuiFocus(false, false)
    end
end)
