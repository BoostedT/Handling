-- Locates a vehicle's <Item type="CHandlingData"> block inside whichever
-- started resource ships its handling.meta, patches the fields the client
-- sent, and writes the file back to disk with SaveResourceFile.
--
-- Every event checks the sender's role (server/permissions.lua). Every write
-- is logged to the save history (server/history.lua) and, if a webhook is set,
-- to Discord. Config lives in config.lua.

local handlingCache = {} -- upper(handlingName) -> { resource = ..., file = ... }

local function escapePattern(s)
    return (s:gsub('([%^%$%(%)%%%.%[%]%*%+%-%?])', '%%%1'))
end

-- The files a resource's own manifest registers as this kind of data file
-- (data_file 'HANDLING_FILE' 'common/handling.meta'), so any folder layout is found.
-- Wildcard entries are skipped (LoadResourceFile can't glob); the fixed and
-- per-vehicle candidates below still cover the usual `data/**/` packs.
local DATA_FILE_KIND = { ['handling.meta'] = 'HANDLING_FILE', ['vehicles.meta'] = 'VEHICLE_METADATA_FILE' }

local function manifestPaths(resourceName, fileName)
    local kind, paths = DATA_FILE_KIND[fileName], {}
    if not kind or not resourceName then return paths end
    for i = 0, GetNumResourceMetadata(resourceName, 'data_file') - 1 do
        if GetResourceMetadata(resourceName, 'data_file', i) == kind then
            local extra = GetResourceMetadata(resourceName, 'data_file_extra', i)
            local ok, path = pcall(json.decode, extra or '')
            if not ok or type(path) ~= 'string' then path = extra end
            if type(path) == 'string' and path ~= '' and not path:find('[%*%?]') and not path:find('%.%.') then
                paths[#paths + 1] = path
            end
        end
    end
    return paths
end

-- The resource's own manifest entries, fixed candidate paths, plus per-vehicle
-- subfolders (data/<name>/<file>), the layout big packs use with a
-- `data/**/handling.meta` wildcard in their manifest.
-- Only plain names are used to build paths so a client can't smuggle in "../".
local function candidatePaths(fixed, name, fileName, resourceName)
    local paths = manifestPaths(resourceName, fileName)
    for _, p in ipairs(fixed) do paths[#paths + 1] = p end
    if name:match('^[%w_%-]+$') then
        for _, n in ipairs({ name, name:lower() }) do
            paths[#paths + 1] = ('data/%s/%s'):format(n, fileName)
            paths[#paths + 1] = ('meta/%s/%s'):format(n, fileName)
        end
    end
    return paths
end

local function clamp(n, min, max)
    if not n then return nil end
    if min and n < min then n = min end
    if max and n > max then n = max end
    return n
end

-- Finds the <Item type="CHandlingData">...</Item> block whose <handlingName>
-- matches (case-insensitively). Uses depth counting rather than a lazy
-- pattern match so nested <Item> elements inside <SubHandlingData> don't
-- cause us to stop at the wrong closing tag. Self-closing <Item ... />
-- elements are ignored since they never get a closing tag.
local function findItemBlock(content, handlingName)
    local searchPos = 1
    while true do
        local openStart, openEnd = content:find('<Item%s+type="CHandlingData"%s*>', searchPos)
        if not openStart then return nil end

        local depth = 1
        local pos = openEnd + 1
        local blockEnd = nil
        while depth > 0 do
            local nextOpen = content:find('<Item[%s>]', pos)
            local nextClose = content:find('</Item>', pos, true)
            if not nextClose then return nil end -- malformed file, bail out
            if nextOpen and nextOpen < nextClose then
                -- Self-closing items like <Item type="NULL" /> have no matching
                -- </Item>, so they must not raise the depth.
                local tagEnd = content:find('>', nextOpen, true)
                if tagEnd and content:sub(tagEnd - 1, tagEnd - 1) ~= '/' then
                    depth = depth + 1
                end
                pos = (tagEnd or nextOpen + 4) + 1
            else
                depth = depth - 1
                pos = nextClose + 7
                if depth == 0 then
                    blockEnd = nextClose + 6
                end
            end
        end

        local block = content:sub(openStart, blockEnd)
        local nameMatch = block:match('<handlingName>%s*([^<]-)%s*</handlingName>')
        if nameMatch and nameMatch:upper() == handlingName:upper() then
            return openStart, blockEnd, block
        end

        searchPos = blockEnd + 1
    end
end

-- Looks up the <handlingId> of the vehicles.meta entry whose <modelName> (or
-- <gameName>) matches, in any started resource.
local function resolveHandlingId(modelName, onlyResource)
    local escaped = escapePattern(modelName:lower())
    local currentResource = GetCurrentResourceName()
    for i = 0, GetNumResources() - 1 do
        local resourceName = GetResourceByFindIndex(i)
        if resourceName and resourceName ~= currentResource and GetResourceState(resourceName) == 'started'
            and (not onlyResource or resourceName == onlyResource) then
            for _, filePath in ipairs(candidatePaths(Config.CandidateVehicleFiles, modelName, 'vehicles.meta', resourceName)) do
                local content = LoadResourceFile(resourceName, filePath)
                if content then
                    local lower = content:lower() -- same length as content, so positions line up
                    local tagStart = lower:find('<modelname>%s*' .. escaped .. '%s*</modelname>')
                        or lower:find('<gamename>%s*' .. escaped .. '%s*</gamename>')
                    if tagStart then
                        -- The <handlingId> for this entry sits between this tag and the next <modelName>.
                        local nextModel = lower:find('<modelname>', tagStart + 1, true) or #content
                        local id = content:sub(tagStart, nextModel):match('<[hH]andlingId>%s*([^<]-)%s*</[hH]andlingId>')
                        if id and #id > 0 then return id, resourceName, filePath end
                    end
                end
            end
        end
    end
    return nil
end

local searchHandlingFile

-- Returns resourceName, filePath, content, resolvedHandlingName. Tries the
-- name as a handlingName first, then falls back to treating it as a model name
-- and following vehicles.meta to the real handlingId. onlyResource (optional)
-- restricts the whole lookup to that one resource.
local function findHandlingFile(name, onlyResource)
    local resourceName, filePath, content = searchHandlingFile(name, nil, nil, onlyResource)
    if resourceName then return resourceName, filePath, content, name end

    -- The handling.meta usually sits next to the vehicles.meta that named the
    -- handlingId (e.g. model "animfk8hr" -> handlingId "chrisfk8hr" in the same
    -- data/animfk8hr/ folder), so hand that path over as the first place to look.
    local handlingId, vehicleResource, vehicleFile = resolveHandlingId(name, onlyResource)
    if handlingId and handlingId:upper() ~= name:upper() then
        resourceName, filePath, content = searchHandlingFile(handlingId, vehicleResource, vehicleFile, onlyResource)
        if resourceName then return resourceName, filePath, content, handlingId end
    end
    return nil
end

searchHandlingFile = function(handlingName, hintResource, hintVehicleFile, onlyResource)
    local upper = handlingName:upper()
    local escaped = escapePattern(upper)

    local cached = handlingCache[upper]
    if cached and (not onlyResource or cached.resource == onlyResource) then
        local content = LoadResourceFile(cached.resource, cached.file)
        if content and content:upper():find('<HANDLINGNAME>%s*' .. escaped .. '%s*</HANDLINGNAME>') then
            return cached.resource, cached.file, content
        end
        handlingCache[upper] = nil
    end

    -- Hint: the handling.meta sitting next to the vehicles.meta this name came from.
    if hintResource and hintVehicleFile then
        local hintFile = hintVehicleFile:gsub('vehicles%.meta$', 'handling.meta')
        local content = LoadResourceFile(hintResource, hintFile)
        if content and content:upper():find('<HANDLINGNAME>%s*' .. escaped .. '%s*</HANDLINGNAME>') then
            handlingCache[upper] = { resource = hintResource, file = hintFile }
            return hintResource, hintFile, content
        end
    end

    local currentResource = GetCurrentResourceName()
    local numResources = GetNumResources()
    for i = 0, numResources - 1 do
        local resourceName = GetResourceByFindIndex(i)
        if resourceName and resourceName ~= currentResource and GetResourceState(resourceName) == 'started'
            and (not onlyResource or resourceName == onlyResource) then
            for _, filePath in ipairs(candidatePaths(Config.CandidateFiles, handlingName, 'handling.meta', resourceName)) do
                local content = LoadResourceFile(resourceName, filePath)
                if content and content:upper():find('<HANDLINGNAME>%s*' .. escaped .. '%s*</HANDLINGNAME>') then
                    handlingCache[upper] = { resource = resourceName, file = filePath }
                    return resourceName, filePath, content
                end
            end
        end
    end

    return nil
end

local function readField(block, field)
    if field.type == 'vector' then
        local x, y, z = block:match('<' .. field.name .. '%s+x="([^"]*)"%s+y="([^"]*)"%s+z="([^"]*)"')
        if x then return { x = tonumber(x), y = tonumber(y), z = tonumber(z) } end
        return nil
    elseif field.type == 'flags' or field.type == 'string' then
        return block:match('<' .. field.name .. '>([^<]*)</' .. field.name .. '>')
    else
        local v = block:match('<' .. field.name .. '%s+value="([^"]*)"')
        return v and tonumber(v) or nil
    end
end

local function setScalarField(block, fieldName, valueStr)
    local pattern = '(<' .. fieldName .. '%s+value=")[^"]*(")'
    local newBlock, count = block:gsub(pattern, function(a, b) return a .. valueStr .. b end, 1)
    return newBlock, count > 0
end

local function setVectorField(block, fieldName, x, y, z)
    local pattern = '(<' .. fieldName .. '%s+x=")[^"]*(" y=")[^"]*(" z=")[^"]*(")'
    local newBlock, count = block:gsub(pattern, function(a, b, c, d) return a .. x .. b .. y .. c .. z .. d end, 1)
    return newBlock, count > 0
end

local function setTextField(block, fieldName, text)
    local pattern = '(<' .. fieldName .. '>)[^<]*(</' .. fieldName .. '>)'
    local newBlock, count = block:gsub(pattern, function(a, b) return a .. text .. b end, 1)
    return newBlock, count > 0
end

-- Patches every field in `values` into one <Item> block. numericOnly skips the
-- flags/string fields (used for class-wide edits, where copying one vehicle's
-- flags onto a whole class would be destructive). exact skips the min/max
-- clamp (a restore puts back whatever the file had, even if it was outside the
-- editor's slider range). Returns the new block plus the lists of field names
-- that were applied / skipped (e.g. not present in that block).
local function patchBlock(block, values, numericOnly, exact)
    local updatedBlock = block
    local applied, skipped = {}, {}
    local function lim(n, field)
        if exact then return n end
        return clamp(n, field.min, field.max)
    end

    for _, group in ipairs(Handling.Groups) do
        for _, field in ipairs(group.fields) do
            local raw = values[field.name]
            local excluded = numericOnly and (field.type == 'flags' or field.type == 'string')
            if raw ~= nil and not excluded then
                local ok = false

                if field.type == 'float' then
                    local n = lim(tonumber(raw), field)
                    if n then
                        updatedBlock, ok = setScalarField(updatedBlock, field.name, ('%.6f'):format(n))
                    end
                elseif field.type == 'int' then
                    local n = tonumber(raw)
                    if n then
                        n = math.floor(lim(n, field))
                        updatedBlock, ok = setScalarField(updatedBlock, field.name, tostring(n))
                    end
                elseif field.type == 'vector' then
                    if type(raw) == 'table' then
                        local x = lim(tonumber(raw.x) or 0.0, field)
                        local y = lim(tonumber(raw.y) or 0.0, field)
                        local z = lim(tonumber(raw.z) or 0.0, field)
                        updatedBlock, ok = setVectorField(updatedBlock, field.name, ('%.6f'):format(x), ('%.6f'):format(y), ('%.6f'):format(z))
                    end
                elseif field.type == 'flags' then
                    if type(raw) == 'string' and raw:match('^%x+$') then
                        updatedBlock, ok = setTextField(updatedBlock, field.name, raw)
                    end
                elseif field.type == 'string' then
                    if type(raw) == 'string' then
                        local safe = raw:gsub('[<>&]', '')
                        updatedBlock, ok = setTextField(updatedBlock, field.name, safe)
                    end
                end

                if ok then
                    applied[#applied + 1] = field.name
                else
                    skipped[#skipped + 1] = field.name
                end
            end
        end
    end

    return updatedBlock, applied, skipped
end

-- ---- diffs, for the history and the logs ------------------------------------

local function sameValue(field, a, b)
    if a == nil or b == nil then return a == b end
    if field.type == 'vector' then
        if type(a) ~= 'table' or type(b) ~= 'table' then return false end
        return math.abs((a.x or 0) - (b.x or 0)) < 1e-5 and math.abs((a.y or 0) - (b.y or 0)) < 1e-5
            and math.abs((a.z or 0) - (b.z or 0)) < 1e-5
    elseif field.type == 'float' or field.type == 'int' then
        return type(a) == 'number' and type(b) == 'number' and math.abs(a - b) < 1e-5
    end
    return tostring(a):upper() == tostring(b):upper()
end

-- The fields in `names` whose value differs between two versions of a block.
local function diffBlocks(before, after, names)
    local changes = {}
    for _, name in ipairs(names) do
        local field = Handling.ByName[name]
        if field then
            local old, new = readField(before, field), readField(after, field)
            if not sameValue(field, old, new) then
                changes[#changes + 1] = { f = name, old = old, new = new }
            end
        end
    end
    return changes
end

local function num(n)
    local s = ('%.4f'):format(n):gsub('0+$', ''):gsub('%.$', '')
    return s
end

local function valueText(v)
    if type(v) == 'table' then return ('%s, %s, %s'):format(num(v.x or 0), num(v.y or 0), num(v.z or 0)) end
    if type(v) == 'number' then return num(v) end
    if v == nil then return '-' end
    return tostring(v)
end

local function changeLines(changes, max)
    local lines = {}
    for i, c in ipairs(changes) do
        if i > max then
            lines[#lines + 1] = ('...and %d more'):format(#changes - max)
            break
        end
        lines[#lines + 1] = ('`%s`: %s → %s'):format(c.f, valueText(c.old), valueText(c.new))
    end
    return lines
end

-- ---- who has which vehicle open ---------------------------------------------
-- So when one person saves, anyone else looking at the same vehicle gets told
-- and their "file:" values refresh.

local watchers = {} -- src -> upper(resolved handling name)

local function notifyWatchers(upperNames, actorSrc, message)
    for s, name in pairs(watchers) do
        if s ~= actorSrc and upperNames[name] then
            TriggerClientEvent('handling_editor:changed', s, { message = message })
        end
    end
end

RegisterNetEvent('handling_editor:closed')
AddEventHandler('handling_editor:closed', function()
    watchers[source] = nil
end)

AddEventHandler('playerDropped', function()
    watchers[source] = nil
end)

-- ---- vehicle locks ------------------------------------------------------------
-- A locked vehicle can only be saved (by any route: single save, copy, preset,
-- category, restore) by someone with the `lock` permission.

Locks = {}
local locks = Store.get('locks', {}) -- upper(handling name) -> { handling, by, t, reason }
if type(locks) ~= 'table' then locks = {} end

function Locks.get(name)
    return type(name) == 'string' and locks[name:upper()] or nil
end

-- The lock that stops this player saving `name`, or nil. Pass `bypass`
-- (Perms.has(src, 'lock')) when checking many vehicles in one request.
local function lockedFor(src, name, bypass)
    local lock = Locks.get(name)
    if not lock then return nil end
    if bypass == nil then bypass = Perms.has(src, 'lock') end
    return (not bypass) and lock or nil
end

local function lockMessage(name, lock)
    return ('%s is locked by %s%s. Someone with the lock permission has to save it.'):format(
        name, lock.by and lock.by.name or 'staff', (lock.reason and lock.reason ~= '') and (' ("' .. lock.reason .. '")') or '')
end

local function lockList()
    local out = {}
    for _, lock in pairs(locks) do out[#out + 1] = lock end
    table.sort(out, function(a, b) return (a.handling or '') < (b.handling or '') end)
    return out
end

RPC.register('locks.list', 'lock', function()
    return { ok = true, now = os.time(), locks = lockList() }
end)

RPC.register('locks.set', 'lock', function(src, args)
    local name = args.handling
    if type(name) ~= 'string' or not name:match('^[%w_%-]+$') then
        return { ok = false, message = 'Invalid handling name.' }
    end
    local reason = type(args.reason) == 'string' and args.reason:gsub('[%c<>]', ''):sub(1, 80) or ''
    local actor = Perms.describe(src)
    locks[name:upper()] = { handling = name, by = actor, t = os.time(), reason = reason }
    Store.set('locks', locks)
    print(('[handling_editor] %s locked %s%s'):format(actor.name, name, reason ~= '' and (' (' .. reason .. ')') or ''))
    Webhook.send('lock', 'Locked ' .. name, { reason ~= '' and ('Reason: ' .. reason) or 'No reason given.' }, actor)
    notifyWatchers({ [name:upper()] = true }, src, ('%s locked this vehicle.'):format(actor.name))
    return { ok = true, message = ('Locked %s. Only people with the lock permission can save it now.'):format(name), locks = lockList() }
end)

RPC.register('locks.clear', 'lock', function(src, args)
    local name = type(args.handling) == 'string' and args.handling or ''
    local lock = locks[name:upper()]
    if not lock then return { ok = false, message = ('%s isn\'t locked.'):format(name), locks = lockList() } end
    locks[name:upper()] = nil
    Store.set('locks', locks)
    local actor = Perms.describe(src)
    print(('[handling_editor] %s unlocked %s'):format(actor.name, lock.handling))
    Webhook.send('lock', 'Unlocked ' .. lock.handling, { ('Was locked by %s.'):format(lock.by and lock.by.name or '?') }, actor)
    notifyWatchers({ [name:upper()] = true }, src, ('%s unlocked this vehicle.'):format(actor.name))
    return { ok = true, message = ('Unlocked %s.'):format(lock.handling), locks = lockList() }
end)

-- ---- single vehicle -------------------------------------------------------------

local DENIED = 'Your handling editor role doesn\'t allow that.'

RegisterNetEvent('handling_editor:requestFile')
AddEventHandler('handling_editor:requestFile', function(handlingName)
    local src = source
    if not Perms.has(src, 'open') then
        TriggerClientEvent('handling_editor:fileResult', src, { ok = false, denied = true, message = 'You do not have permission to use the handling editor.' })
        return
    end
    if type(handlingName) ~= 'string' or #handlingName == 0 then
        TriggerClientEvent('handling_editor:fileResult', src, { ok = false, message = 'Invalid handling name.' })
        return
    end

    local resourceName, filePath, content, resolvedName = findHandlingFile(handlingName)
    if not resourceName then
        watchers[src] = nil
        TriggerClientEvent('handling_editor:fileResult', src, {
            ok = false,
            message = ('No handling.meta entry found for "%s" in any started resource (also tried resolving it as a model name via vehicles.meta). Live edits will still preview, but Save won\'t have anywhere to write.'):format(handlingName),
        })
        return
    end

    local openStart, _, block = findItemBlock(content, resolvedName)
    if not openStart then
        watchers[src] = nil
        TriggerClientEvent('handling_editor:fileResult', src, { ok = false, message = ('Found %s/%s but could not parse its <Item> block.'):format(resourceName, filePath) })
        return
    end

    local values = {}
    for _, group in ipairs(Handling.Groups) do
        for _, field in ipairs(group.fields) do
            values[field.name] = readField(block, field)
        end
    end

    watchers[src] = resolvedName:upper()
    TriggerClientEvent('handling_editor:fileResult', src, {
        ok = true,
        resource = resourceName,
        file = filePath,
        handling = resolvedName,
        lock = Locks.get(resolvedName),
        now = os.time(),
        values = values,
    })
end)

RegisterNetEvent('handling_editor:save')
AddEventHandler('handling_editor:save', function(handlingName, values, makeBackup)
    local src = source
    if not Perms.has(src, 'save') then
        TriggerClientEvent('handling_editor:saveResult', src, { ok = false, message = DENIED })
        return
    end
    if type(handlingName) ~= 'string' or #handlingName == 0 or type(values) ~= 'table' then
        TriggerClientEvent('handling_editor:saveResult', src, { ok = false, message = 'Invalid data.' })
        return
    end

    local resourceName, filePath, content, resolvedName = findHandlingFile(handlingName)
    if not resourceName then
        TriggerClientEvent('handling_editor:saveResult', src, {
            ok = false,
            message = ('Could not locate a handling.meta entry for "%s" in any started resource.'):format(handlingName),
        })
        return
    end

    local lock = lockedFor(src, resolvedName)
    if lock then
        TriggerClientEvent('handling_editor:saveResult', src, { ok = false, message = lockMessage(resolvedName, lock) })
        return
    end

    local openStart, blockEnd, block = findItemBlock(content, resolvedName)
    if not openStart then
        TriggerClientEvent('handling_editor:saveResult', src, { ok = false, message = 'Found the file but could not isolate the <Item> block (unexpected format).' })
        return
    end

    local updatedBlock, applied, skipped = patchBlock(block, values, false)
    local changes = diffBlocks(block, updatedBlock, applied)

    local newContent = content:sub(1, openStart - 1) .. updatedBlock .. content:sub(blockEnd + 1)

    if makeBackup == true then -- panel's "Keep .bak backup" checkbox
        local backupPath = filePath .. '.bak'
        if not LoadResourceFile(resourceName, backupPath) then
            SaveResourceFile(resourceName, backupPath, content, -1)
        end
    end

    local wrote = SaveResourceFile(resourceName, filePath, newContent, -1)
    if wrote then
        local actor = Perms.describe(src)
        print(('[handling_editor] %s saved %s/%s for handling "%s" (%d fields written, %d changed%s)'):format(
            actor.name, resourceName, filePath, resolvedName, #applied, #changes,
            #skipped > 0 and (', skipped: ' .. table.concat(skipped, ', ')) or ''
        ))
        if #changes > 0 then
            History.add({
                kind = 'save', by = actor, total = 1, restorable = true,
                targets = { { handling = resolvedName, resource = resourceName, file = filePath, changes = changes } },
            })
            local lines = { ('`%s/%s`'):format(resourceName, filePath) }
            for _, l in ipairs(changeLines(changes, 25)) do lines[#lines + 1] = l end
            Webhook.send('save', ('Saved %s (%d field%s)'):format(resolvedName, #changes, #changes == 1 and '' or 's'), lines, actor)
            notifyWatchers({ [resolvedName:upper()] = true }, src,
                ('%s just saved this vehicle (%d field%s). The file values have been refreshed.'):format(actor.name, #changes, #changes == 1 and '' or 's'))
        end
        TriggerClientEvent('handling_editor:saveResult', src, {
            ok = true,
            message = ('Saved to %s/%s (%d field%s changed%s). Restart "%s" to apply it to newly spawned vehicles server-wide.'):format(
                resourceName, filePath, #changes, #changes == 1 and '' or 's',
                #skipped > 0 and (', ' .. #skipped .. ' skipped') or '', resourceName
            ),
            applied = applied,
            skipped = skipped,
        })
    else
        TriggerClientEvent('handling_editor:saveResult', src, { ok = false, message = 'SaveResourceFile failed (the resource\'s files may be packed or read-only on disk).' })
    end
end)

-- ---- several vehicles at once ---------------------------------------------------
-- Class-wide save: the client works out which vehicle models belong to a game
-- class (SUVs, Sports, ...) and sends the model names plus only the fields the
-- user touched. Each model is resolved to its handling.meta entry the same way
-- a single save does, every matching entry is patched, and each file is
-- written once even if several of the models live in it. Copy-to-vehicle and
-- preset-onto-another-vehicle use this too, with a single model.
local MAX_CLASS_MODELS = 3000

-- A resource restriction is either nil (every started resource) or the name of
-- a started resource. Returns ok, resource.
local function validScope(resource)
    if resource == nil then return true, nil end
    if type(resource) == 'string' and #resource > 0 and GetResourceState(resource) == 'started' then
        return true, resource
    end
    return false, nil
end

-- Filters `models` down to the ones that actually resolve to a handling.meta
-- entry (optionally restricted to one resource). Shared by the whole-class
-- scope check and the single-vehicle "apply preset to another vehicle" picker.
local function filterModelsWithHandling(models, onlyResource)
    local found, checked = {}, 0
    for _, model in ipairs(models) do
        if checked >= MAX_CLASS_MODELS then break end
        checked = checked + 1
        if type(model) == 'string' and model:match('^[%w_%-]+$') and findHandlingFile(model, onlyResource) then
            found[#found + 1] = model
        end
        if checked % 5 == 0 then Wait(0) end
    end
    return found
end

-- Which of these models actually have a handling.meta entry (optionally only
-- inside one resource)? The client uses the answer to show an exact count and
-- to limit its live edits to the same set of vehicles the save will touch.
RegisterNetEvent('handling_editor:classScope')
AddEventHandler('handling_editor:classScope', function(requestId, resource, models)
    local src = source
    local function reply(result)
        result.requestId = requestId
        TriggerClientEvent('handling_editor:classScopeResult', src, result)
    end

    if not Perms.has(src, 'bulk') then
        reply({ ok = false, message = DENIED })
        return
    end
    local scopeOk, onlyResource = validScope(resource)
    if not scopeOk or type(models) ~= 'table' then
        reply({ ok = false, message = ('Resource "%s" is not started.'):format(tostring(resource)) })
        return
    end

    reply({ ok = true, models = filterModelsWithHandling(models, onlyResource), resource = onlyResource })
end)

-- Lists which of the given vehicle models (the client sends every model the
-- game knows about, since only the client can enumerate those) resolve to a
-- handling.meta entry inside one specific resource. Powers the "Copy to" and
-- "Apply presets to" dropdowns, which offer other vehicles from the same pack
-- as the vehicle currently loaded.
RegisterNetEvent('handling_editor:listVehicles')
AddEventHandler('handling_editor:listVehicles', function(requestId, resource, models)
    local src = source
    local function reply(result)
        result.requestId = requestId
        TriggerClientEvent('handling_editor:listVehiclesResult', src, result)
    end

    if not Perms.has(src, 'bulk') then
        reply({ ok = false, message = DENIED })
        return
    end
    local scopeOk, onlyResource = validScope(resource)
    if not scopeOk or type(models) ~= 'table' or not onlyResource then
        reply({ ok = false, message = ('Resource "%s" is not started.'):format(tostring(resource)) })
        return
    end

    reply({ ok = true, models = filterModelsWithHandling(models, onlyResource), resource = onlyResource })
end)

-- Writes each pending file once. pending: key -> { resource, file, original, content }.
-- Returns the set of keys written, the count, and the keys that failed.
local function writePending(pending, order, makeBackup)
    local written, count, failed = {}, 0, {}
    for _, key in ipairs(order) do
        local entry = pending[key]
        if entry.content ~= entry.original then
            if makeBackup == true then -- panel's "Keep .bak backup" checkbox
                local backupPath = entry.file .. '.bak'
                if not LoadResourceFile(entry.resource, backupPath) then
                    SaveResourceFile(entry.resource, backupPath, entry.original, -1)
                end
            end
            if SaveResourceFile(entry.resource, entry.file, entry.content, -1) then
                written[key] = true
                count = count + 1
            else
                failed[#failed + 1] = key
            end
        end
    end
    return written, count, failed
end

-- Keeps the targets whose file was actually written, capped for the history.
-- Returns the list, the real total and whether it fits (restorable).
local function writtenTargets(targets, written)
    local out, total = {}, 0
    local max = Config.HistoryMaxTargets or 250
    for _, t in ipairs(targets) do
        if written[t.key] then
            total = total + 1
            if #out < max then
                out[#out + 1] = { handling = t.handling, resource = t.resource, file = t.file, changes = t.changes }
            end
        end
    end
    return out, total, total <= max
end

RegisterNetEvent('handling_editor:saveClass')
AddEventHandler('handling_editor:saveClass', function(className, models, values, resource, makeBackup)
    local src = source
    local function reply(ok, message)
        TriggerClientEvent('handling_editor:saveResult', src, { ok = ok, message = message })
    end

    if not Perms.has(src, 'bulk') then
        reply(false, DENIED)
        return
    end
    if type(models) ~= 'table' or type(values) ~= 'table' then
        reply(false, 'Invalid data.')
        return
    end
    local scopeOk, onlyResource = validScope(resource)
    if not scopeOk then
        reply(false, ('Resource "%s" is not started.'):format(tostring(resource)))
        return
    end
    -- A category, preset or "A -> B" copy name; it ends up in logs and the history.
    className = type(className) == 'string' and className:gsub('[^%w%s%-%(%)%._>\']', ''):sub(1, 80) or ''
    if className:gsub('%s', '') == '' then className = 'class' end

    -- Flags and strings are per-vehicle identity, not something to broadcast.
    local bulkValues, fieldCount = {}, 0
    for _, group in ipairs(Handling.Groups) do
        for _, field in ipairs(group.fields) do
            if field.type ~= 'flags' and field.type ~= 'string' and values[field.name] ~= nil then
                bulkValues[field.name] = values[field.name]
                fieldCount = fieldCount + 1
            end
        end
    end
    if fieldCount == 0 then
        reply(false, 'No numeric fields to apply. Change a slider or value first.')
        return
    end

    local pending, order = {}, {} -- "resource|file" -> { resource, file, original, content }
    local seen = {}               -- "resource|file|NAME" -> already patched (models can share a handlingId)
    local targets = {}            -- { key, handling, resource, file, changes } for the history
    local entriesUpdated = 0
    local unresolved, locked = {}, {}
    local missingField = {}       -- field name -> number of entries that don't contain it
    local bypass = Perms.has(src, 'lock')

    local checked = 0
    for _, model in ipairs(models) do
        if checked >= MAX_CLASS_MODELS then break end
        checked = checked + 1

        if type(model) == 'string' and model:match('^[%w_%-]+$') then
            local resourceName, filePath, content, resolvedName = findHandlingFile(model, onlyResource)
            if not resourceName then
                unresolved[#unresolved + 1] = model
            elseif lockedFor(src, resolvedName, bypass) then
                locked[#locked + 1] = resolvedName
            else
                local key = resourceName .. '|' .. filePath
                local entry = pending[key]
                if not entry then
                    entry = { resource = resourceName, file = filePath, original = content, content = content }
                    pending[key] = entry
                    order[#order + 1] = key
                end

                local seenKey = key .. '|' .. resolvedName:upper()
                if not seen[seenKey] then
                    seen[seenKey] = true
                    -- Always patch entry.content, not `content`: an earlier model may
                    -- already have changed another block in this same file.
                    local openStart, blockEnd, block = findItemBlock(entry.content, resolvedName)
                    if openStart then
                        local updatedBlock, applied, skipped = patchBlock(block, bulkValues, true)
                        entry.content = entry.content:sub(1, openStart - 1) .. updatedBlock .. entry.content:sub(blockEnd + 1)
                        entriesUpdated = entriesUpdated + 1
                        for _, fieldName in ipairs(skipped) do
                            missingField[fieldName] = (missingField[fieldName] or 0) + 1
                        end
                        local changes = diffBlocks(block, updatedBlock, applied)
                        if #changes > 0 then
                            targets[#targets + 1] = { key = key, handling = resolvedName, resource = resourceName, file = filePath, changes = changes }
                        end
                    else
                        unresolved[#unresolved + 1] = model
                    end
                end
            end
        end

        if checked % 5 == 0 then Wait(0) end -- big classes shouldn't stall the server thread
    end

    local written, filesWritten, failed = writePending(pending, order, makeBackup)

    local actor = Perms.describe(src)
    local scopeLabel = onlyResource and (' (only in ' .. onlyResource .. ')') or ' (all resources)'
    print(('[handling_editor] %s applied %d field(s) to "%s"%s: %d handling entries in %d file(s); %d model(s) not found%s%s%s'):format(
        actor.name, fieldCount, className, scopeLabel, entriesUpdated, filesWritten, #unresolved,
        #unresolved > 0 and (' (' .. table.concat(unresolved, ', ') .. ')') or '',
        #locked > 0 and ('; locked, skipped: ' .. table.concat(locked, ', ')) or '',
        #failed > 0 and ('; WRITE FAILED: ' .. table.concat(failed, ', ')) or ''
    ))

    local logged, total, restorable = writtenTargets(targets, written)
    if total > 0 then
        History.add({ kind = 'bulk', label = className, by = actor, targets = logged, total = total, restorable = restorable })
        local names, touched = {}, {}
        for i, t in ipairs(logged) do
            touched[t.handling:upper()] = true
            if i <= 30 then names[#names + 1] = t.handling end
        end
        local lines = { ('%d vehicle%s%s: %s%s'):format(total, total == 1 and '' or 's', scopeLabel, table.concat(names, ', '), total > #names and ', ...' or '') }
        if logged[1] then
            for _, l in ipairs(changeLines(logged[1].changes, 15)) do lines[#lines + 1] = l end
        end
        Webhook.send('bulk', ('%s: %d field%s on %d vehicle%s'):format(className, fieldCount, fieldCount == 1 and '' or 's', total, total == 1 and '' or 's'), lines, actor)
        notifyWatchers(touched, src, ('%s just saved this vehicle as part of "%s". The file values have been refreshed.'):format(actor.name, className))
    end

    local notes = {}
    if #unresolved > 0 then
        notes[#notes + 1] = ('%d model%s had no handling.meta entry'):format(#unresolved, #unresolved == 1 and '' or 's')
    end
    if #locked > 0 then
        notes[#notes + 1] = ('%d locked vehicle%s skipped: %s'):format(#locked, #locked == 1 and '' or 's', table.concat(locked, ', '))
    end
    local missing = {}
    for fieldName, count in pairs(missingField) do
        missing[#missing + 1] = ('%s absent in %d'):format(fieldName, count)
    end
    if #missing > 0 then
        table.sort(missing)
        notes[#notes + 1] = 'not added where missing: ' .. table.concat(missing, ', ')
    end
    if #failed > 0 then
        notes[#notes + 1] = ('%d file%s could not be written'):format(#failed, #failed == 1 and '' or 's')
    end

    if entriesUpdated == 0 and #locked > 0 and #unresolved == 0 then
        reply(false, ('Nothing saved: %s.'):format(notes[1]))
        return
    end
    reply(#failed == 0 and entriesUpdated > 0, ('%s%s: updated %d handling entr%s in %d file%s%s. Restart the vehicle resource%s to apply to newly spawned vehicles.'):format(
        className, onlyResource and (' in ' .. onlyResource) or '', entriesUpdated, entriesUpdated == 1 and 'y' or 'ies', filesWritten, filesWritten == 1 and '' or 's',
        #notes > 0 and (' (' .. table.concat(notes, '; ') .. ')') or '',
        #order > 1 and 's' or ''
    ))
end)

-- ---- restore a logged save ----------------------------------------------------------
-- Puts back the "before" value of every field the save changed. The restore is
-- itself logged, so it can be undone the same way.

RPC.register('history.restore', 'restore', function(src, args)
    local entry = History.get(args.id)
    if not entry then return { ok = false, message = 'That save is no longer in the history.' } end
    if entry.restorable == false then
        return { ok = false, message = 'That save touched more vehicles than the history keeps, so it can\'t be restored in one click.' }
    end

    local pending, order, targets = {}, {}, {}
    local missing, locked, changedSince = {}, {}, 0
    local bypass = Perms.has(src, 'lock')

    local function loadFile(resource, file)
        local key = tostring(resource) .. '|' .. tostring(file)
        if pending[key] then return pending[key], key end
        if type(resource) ~= 'string' or type(file) ~= 'string' or GetResourceState(resource) ~= 'started' then return nil, key end
        local content = LoadResourceFile(resource, file)
        if not content then return nil, key end
        pending[key] = { resource = resource, file = file, original = content, content = content }
        order[#order + 1] = key
        return pending[key], key
    end

    for _, target in ipairs(entry.targets or {}) do
        local name = target.handling
        if type(name) ~= 'string' then
            -- malformed entry, skip it
        elseif lockedFor(src, name, bypass) then
            locked[#locked + 1] = name
        else
            local file, key = loadFile(target.resource, target.file)
            local openStart, blockEnd, block
            if file then openStart, blockEnd, block = findItemBlock(file.content, name) end
            if not openStart then
                missing[#missing + 1] = name
            else
                local oldValues = {}
                for _, c in ipairs(target.changes or {}) do
                    local field = Handling.ByName[c.f]
                    if field and c.old ~= nil then
                        oldValues[c.f] = c.old
                        if not sameValue(field, readField(block, field), c.new) then
                            changedSince = changedSince + 1
                        end
                    end
                end
                local updated, applied = patchBlock(block, oldValues, false, true)
                local changes = diffBlocks(block, updated, applied)
                if #changes > 0 then
                    file.content = file.content:sub(1, openStart - 1) .. updated .. file.content:sub(blockEnd + 1)
                    targets[#targets + 1] = { key = key, handling = name, resource = target.resource, file = target.file, changes = changes }
                end
            end
        end
    end

    local written, filesWritten, failed = writePending(pending, order, false)
    local logged, total, restorable = writtenTargets(targets, written)
    local actor = Perms.describe(src)

    local notes = {}
    if changedSince > 0 then
        notes[#notes + 1] = ('%d field%s had been changed again since, and were put back anyway'):format(changedSince, changedSince == 1 and '' or 's')
    end
    if #locked > 0 then notes[#notes + 1] = 'locked, skipped: ' .. table.concat(locked, ', ') end
    if #missing > 0 then notes[#notes + 1] = 'not found any more: ' .. table.concat(missing, ', ') end
    if #failed > 0 then notes[#notes + 1] = ('%d file%s could not be written'):format(#failed, #failed == 1 and '' or 's') end
    local noteText = #notes > 0 and (' (' .. table.concat(notes, '; ') .. ')') or ''

    if total == 0 then
        return { ok = false, message = 'Nothing to restore: the files already have those values' .. noteText .. '.' }
    end

    local newEntry = History.add({
        kind = 'restore', label = ('Restore of #%d'):format(entry.id), by = actor,
        targets = logged, total = total, restorable = restorable,
    })
    entry.restoredBy = { name = actor.name, t = os.time(), id = newEntry.id }
    History.update(entry)

    local handlings, touched = {}, {}
    for _, t in ipairs(logged) do
        handlings[#handlings + 1] = t.handling
        touched[t.handling:upper()] = true
    end
    print(('[handling_editor] %s restored history #%d: %d vehicle(s) in %d file(s)%s'):format(actor.name, entry.id, total, filesWritten, noteText))
    local lines = { ('Rolled back #%d (%s by %s)'):format(entry.id, entry.label or entry.kind or 'save', entry.by and entry.by.name or '?') }
    lines[#lines + 1] = 'Vehicles: ' .. table.concat(handlings, ', ', 1, math.min(#handlings, 30))
    if logged[1] then
        for _, l in ipairs(changeLines(logged[1].changes, 15)) do lines[#lines + 1] = l end
    end
    Webhook.send('restore', ('Restored #%d'):format(entry.id), lines, actor)
    notifyWatchers(touched, src, ('%s just restored an earlier version of this vehicle. The file values have been refreshed.'):format(actor.name))

    return {
        ok = true, handlings = handlings,
        message = ('Restored %d vehicle%s to before #%d%s. Restart the vehicle resource to apply it to new spawns.'):format(
            total, total == 1 and '' or 's', entry.id, noteText),
    }
end)

-- Freecam (client/freecam.lua) lets you see anywhere on the map, so it has its
-- own permission.
RegisterNetEvent('handling_editor:freecam')
AddEventHandler('handling_editor:freecam', function()
    local src = source
    TriggerClientEvent('handling_editor:freecamResult', src, Perms.has(src, 'freecam'))
end)
